// 원자적 JSON 저장 + 손상 안전 로드 — 로컬 우선 파일 저장소의 데이터 유실 방어 토대.
//
// 문제(감사 D1): 코어 전반이 writeFile로 JSON을 직접 덮어써(비원자적) 저장 중 크래시 시
// 파일이 잘리고, 로드가 예외를 조용히 삼켜 "빈 상태"로 리셋 → 대화·기억·토큰 소실.
//
// 처방:
//  - writeJsonAtomic: 임시파일에 쓰고 fsync 후 rename(원자적 교체). 부분 쓰기가 원본을 오염 못 함.
//  - readJson: ENOENT(부재)만 기본값. SyntaxError(손상)는 .corrupt-<ts>로 백업 후 throw —
//    절대 조용히 리셋하지 않는다(부재와 손상을 구분).
import { readFile, writeFile, rename, mkdir, open, rm } from 'node:fs/promises';
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
  await rename(tmp, file); // 원자적 교체 — 원본은 항상 완전한 이전 상태 또는 완전한 새 상태
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
