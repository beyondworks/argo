// 원자적 JSON 저장 + 손상 안전 로드 — 로컬 우선 파일 저장소의 데이터 유실 방어 토대.
//
// 문제(감사 D1): 코어 전반이 writeFile로 JSON을 직접 덮어써(비원자적) 저장 중 크래시 시
// 파일이 잘리고, 로드가 예외를 조용히 삼켜 "빈 상태"로 리셋 → 대화·기억·토큰 소실.
//
// 처방:
//  - writeJsonAtomic: 임시파일에 쓰고 fsync 후 rename(원자적 교체). 부분 쓰기가 원본을 오염 못 함.
//  - readJson: ENOENT(부재)만 기본값. SyntaxError(손상)는 .corrupt-<ts>로 백업 후 throw —
//    절대 조용히 리셋하지 않는다(부재와 손상을 구분).
import { readFile, writeFile, rename, mkdir, open, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/** 원자적 파일 쓰기(버퍼/문자열) — tmp write → fsync → rename. 같은 디렉터리 tmp라야 rename이 원자적(동일 파일시스템).
    부분 쓰기가 원본을 오염 못 한다. 동기화가 스레드·blob을 쓸 때 크래시로 파일이 잘려 '손상→삭제 오전파'로
    번지는 것을 막는 토대(.tmp-는 동기화 EXCLUDE 대상이라 원격에 새지 않는다). */
export async function writeFileAtomic(file, body, { mode = 0o644 } = {}) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.tmp-${basename(file)}-${process.pid}-${randomSuffix()}`);
  let fh;
  try {
    fh = await open(tmp, 'w', mode);
    await fh.writeFile(body);
    await fh.sync(); // 디스크까지 내려쓴 뒤 rename — 크래시 창 최소화
  } finally {
    await fh?.close();
  }
  try {
    await renameRetry(tmp, file); // 원자적 교체 — 원본은 항상 완전한 이전 상태 또는 완전한 새 상태
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {}); // 최종 실패 시 tmp 잔재 정리
    throw e;
  }
}

/** rename 재시도 — Windows는 대상 파일이 잠깐 잠겨 있으면(동시 rename 경합·AV·인덱서) EPERM/EACCES를
    던진다(2026-07-27 CI 첫 Windows 실행 실측: 동시 20쓰기에서 EPERM — 동기화·채팅이 같은 파일을 겹쳐
    쓰는 프로덕션 경로와 동형). win32 한정 — POSIX의 rename EPERM/EACCES는 사실상 영구 조건(디렉터리
    권한·sticky bit)이라 재시도가 순수 지연일 뿐이다(분리 검수 2026-07-27). 총 ~450ms 백오프 후에도
    잠겨 있으면 진짜 오류로 올린다 — 조용히 삼키면 유실이 무증상이 된다. */
async function renameRetry(tmp, file) {
  for (let i = 0; ; i++) {
    try { return await rename(tmp, file); }
    catch (e) {
      if (process.platform !== 'win32' || (e.code !== 'EPERM' && e.code !== 'EACCES') || i >= 9) throw e;
      await new Promise((r) => setTimeout(r, 10 * (i + 1)));
    }
  }
}

/** 원자적 JSON 저장 — 0600(워크스페이스 JSON은 시크릿: .secrets.json·connections·페어링 자격을 담을 수 있어 소유자만).
    rename이 tmp의 모드를 보존하므로 기존 0644 파일도 다음 쓰기에 0600으로 조여진다(업그레이드 안전). (P1-8) */
export async function writeJsonAtomic(file, data) {
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  await writeFileAtomic(file, body, { mode: 0o600 });
}

/** 손상 안전 로드. 반환: 파싱된 값 | (부재 시) fallback.
    손상(SyntaxError)이면 원본을 .corrupt-<ts>로 옮기고 throw — 호출부가 "빈 상태로 진행"을 못 하게. */
export async function readJson(file, fallback) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return structuredClone(fallback);
    throw e; // 권한 등 진짜 오류는 숨기지 않는다
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 손상 — 조용히 버리지 않는다. 증거를 남기고 실패를 드러낸다.
    const backup = `${file}.corrupt-${Date.now()}`;
    await rename(file, backup).catch(() => {});
    const err = new Error(`손상된 JSON: ${basename(file)} → ${basename(backup)}로 백업됨`);
    err.corrupt = true;
    err.backup = backup;
    throw err;
  }
}

/** 손상본에서 배열 항목을 최대한 건져낸다(순수) — 대화 파일은 append-only라 손상은 대개 꼬리에만
    생긴다(쓰기 중 크래시·디스크 가득). 앞쪽의 완결된 객체들은 멀쩡하므로, 중괄호 균형을 스캔해
    파싱 가능한 항목까지만 복원한다. 반환: 복구된 배열(못 건지면 []).
    (export: 회귀 테스트용 — 순수 함수)

    배경(실측 2026-07-26): 손상 → readJson이 .corrupt-<ts>로 격리 → 다음 로드는 ENOENT라 **빈 방**이
    돌아와 사용자에겐 "회의 대화가 통째로 사라짐"으로 보였다. 격리 자체는 옳지만 복구 경로가 없었다. */
export function salvageJsonArray(raw, key) {
  const src = String(raw ?? '');
  // 앵커는 **최상위 키**만 인정한다 — 단순 indexOf는 메시지 본문에 붙여넣은 JSON 안의 "messages"를
  // 배열로 오인해 거짓 복구를 만든다(분리 검수 지적 2026-07-26: 개발자향 제품이라 대화에 JSON이 흔함).
  const at = topLevelKeyIndex(src, key);
  if (at < 0) return [];
  const start = src.indexOf('[', at);
  if (start < 0) return [];
  const out = [];
  let depth = 0, inStr = false, esc = false, objStart = -1;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') { if (depth === 0) objStart = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(src.slice(objStart, i + 1))); } catch { /* 이 항목만 포기 */ }
        objStart = -1;
      }
      continue;
    }
    if (c === ']' && depth === 0) break; // 배열 정상 종료
  }
  return out;
}

/** 최상위 키의 위치 — 중첩 객체·문자열 안의 동명 키를 건너뛴다(순수, salvage 앵커 전용). 없으면 -1. */
function topLevelKeyIndex(src, key) {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') {
      // depth 1(최상위 객체 직속)에서 시작하는 문자열만 키 후보로 본다
      if (!inStr && depth === 1 && src.startsWith(`"${key}"`, i)) return i;
      inStr = !inStr; continue;
    }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return -1;
}

/** 격리된 손상본에서 건진 배열 — **읽기 전용**(파일에 쓰지 않는다).
    반환: { items, from } | null.

    쓰기를 하지 않는 이유(분리 검수 CRITICAL 2건, 2026-07-26):
     ① 잘린 salvage로 로컬 파일을 되살리면 sync의 기존 self-heal("로컬 부재 + .corrupt 존재 → 원격
        완전본 pull + 백업 청소")이 성립하지 않고, 오히려 잘린 본이 클라우드로 push돼 **로컬 손상이
        전 기기 영구 유실로 확대**된다. 파일을 안 쓰면 sync가 유일한 writer로 남아 계약이 유지된다.
     ② loadRoom/loadThread는 락 밖 호출부가 많아, 여기서 전 파일 write를 하면 appendTurn·pushRoomMsg·
        sync pull과 lost-update 경합이 난다.
    복구본은 화면·다음 정상 write(appendTurn이 락 안에서 수행)를 통해 자연히 durable해진다.

    또한 **파일이 존재하면 복구하지 않는다** — "정상적으로 빈 상태"(회의 마치기·새 대화·새 크루)를
    옛 손상본으로 덮어 유령 대화가 부활하던 결함 차단(같은 검수 CRITICAL-1). */
export async function salvageFromCorrupt(file, key) {
  if (existsSync(file)) return null; // 정상 파일 존재 = 복구 대상 아님(빈 배열이어도)
  const dir = dirname(file);
  const base = basename(file);
  let names = [];
  try { names = await readdir(dir); } catch { return null; }
  const cands = names.filter((n) => n.startsWith(`${base}.corrupt-`)).sort(); // 접미 타임스탬프 = 사전순 = 시간순
  const latest = cands[cands.length - 1];
  if (!latest) return null;
  let raw = '';
  try { raw = await readFile(join(dir, latest), 'utf8'); } catch { return null; }
  const items = salvageJsonArray(raw, key);
  if (!items.length) return null;
  console.warn(`[argo] 손상본에서 ${items.length}건 복구 표시: ${latest} (파일은 쓰지 않음 — 동기화 self-heal 보존)`);
  return { items, from: latest };
}

/** 손상을 "복구 가능한 부재"로 관용해야 하는 소비자용(예: 캐시성 상태) — 손상 시 백업만 하고 fallback.
    주의: 대화·기억·토큰처럼 유실이 치명적인 데이터에는 쓰지 말 것(readJson으로 실패를 드러내라). */
export async function readJsonLenient(file, fallback) {
  try {
    return await readJson(file, fallback);
  } catch (e) {
    if (e.corrupt) return structuredClone(fallback);
    throw e;
  }
}

function randomSuffix() {
  // Math.random은 이 환경에서 금지 — 시각·pid·카운터로 충분히 유일(동일 프로세스 내 tmp 충돌만 피하면 됨)
  return `${Date.now().toString(36)}-${(globalThis.__argoTmpSeq = (globalThis.__argoTmpSeq ?? 0) + 1)}`;
}

/** 손상 백업 청소 — 필요 시 운영용. 지금은 미사용(수동 진단 대비 보존). */
export async function purgeCorrupt(file) {
  await rm(`${file}`, { force: true }).catch(() => {});
}
