// 클라우드 자료 내보내기 — 체험 만료(free) 사용자가 버튼 한 번으로 클라우드에 동결된 자기 자료를
// 로컬 폴더에 통째로 내려받는다. "데이터를 인질로 잡지 않는다" 원칙의 구현(유건 확정 2026-07-28).
//
// 근거(실측): Storage RLS는 **쓰기만** Pro 게이트다 — select는 소유자 경계만이라 free 사용자도
// 자기 prefix를 목록·다운로드할 수 있다(20260723001629_companies_sync_pro_gate.sql의 명시 계약:
// "무료·다운그레이드 계정도 기존 클라우드 데이터를 pull(내보내기)·삭제(정리)할 수 있어야 한다").
//
// 설계:
//  - 자격·클라이언트는 sync.mjs와 같은 경로(synccreds 서비스 자격 우선, 없으면 기기 세션 JWT).
//  - 열거는 재귀 list() — 매니페스트를 신뢰하지 않는다(동기화가 중간에 죽어 매니페스트에 없는
//    blob이 남아도 전부 내려받아야 "인질 없음"이 성립). list는 서버에서 storage.search라 비싸지만
//    1회성 버튼이라 감수한다(사이클마다 도는 sync와 다른 비용 계급 — 재클릭은 in-flight 가드로 차단).
//  - 스토리지 키의 비ASCII 세그먼트는 base64url(u8- 접두, sync.mjs encSeg)이다 — decSeg로 복원해
//    한글 파일명이 그대로 살아난다. 복원된 세그먼트는 safeRel로 재검증(경로 탈출 차단, P1-7과 동일).
//  - 목적지는 사용자 입력 없이 자동: ~/Documents/Argo-cloud-export-YYYYMMDD/<회사명>/<rel>.
//    같은 날 재실행은 -2, -3… 접미로 새 폴더(기존 사본 위에 덮어쓰지 않는다).
//  - 자격 제외 정책은 export.mjs의 exportExcluded 정본을 그대로 적용 — 러너 키·봇 토큰·MCP 토큰이
//    담긴 rel(직속 도트·connections.json·mcp.json)은 내려받지 않는다. 봉투 암호문(secretbox)은
//    openSecretCompat로 관용 개봉(평문은 그대로, 봉투는 키가 있으면 복호) — 개봉 실패는 파일 단위로
//    건너뛰고 집계한다(암호문 쓰레기를 사본에 남기지 않는다).
//  - .partial에 받은 뒤 성공 시 rename — 부분 실패 잔재가 완전한 사본으로 오인되지 않는다(export.mjs와 동일).
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { exportExcluded } from './export.mjs';
import { openSecretCompat } from './secretbox.mjs';
import { loadSyncCreds } from './synccreds.mjs';
import { getFreshDeviceSession } from './devicesession.mjs';
import { serviceCredsAllowed, safeRel } from './sync.mjs';
import { ensureAccountKey } from './accountkey.mjs';
import { WS_ID_RE } from './workspace.mjs';

const BUCKET = 'companies';
const err = (code, msg) => Object.assign(new Error(msg), { code });

/** 스토리지 키 세그먼트 복원 — sync.mjs encSeg의 역. u8- 접두면 base64url 디코드, 아니면 그대로. */
export const decSeg = (s) => {
  if (!String(s).startsWith('u8-')) return String(s);
  return Buffer.from(String(s).slice(3), 'base64url').toString('utf8');
};

/** 회사 표시명 → 폴더명 정화. 경로 구분자·예약 문자를 지우고, 비면 폴백(wsId). */
export const safeFolderName = (name, fallback) => {
  const s = String(name ?? '').replace(/[\\/:*?"<>|\0]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  return s || fallback;
};

/** 목적지 자동 선택 — <docsDir>/Argo-cloud-export-YYYYMMDD, 있으면 -2, -3…(순수 — exists 주입 가능).
    날짜는 로컬(사용자 시간대) — 폴더명은 사용자가 읽는 값이다. */
export function pickExportTarget(docsDir, { now = new Date(), exists = existsSync } = {}) {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  for (let i = 1; i <= 99; i++) {
    const cand = join(docsDir, `Argo-cloud-export-${ymd}${i === 1 ? '' : `-${i}`}`);
    if (!exists(cand) && !exists(`${cand}.partial`)) return cand;
  }
  throw err('exists', `내보내기 폴더 후보 소진: ${docsDir}`);
}

// 재귀 list 페이지네이션 — Supabase list 기본 100개 제한을 넘겨 받는다. 오류는 throw(부분 목록으로
// "다 받았다"는 거짓 안심을 만들지 않는다 — 열거 실패는 전체 실패).
// 종료는 빈 배치로만 판정한다(분리 검수 MED): "batch < limit이면 끝" 판정은 서버가 limit을 캡할 때
// (예: 1000 요청에 100 반환) 첫 페이지에서 끊겨 부분 목록을 전체로 오인한다. 빈 배치 판정은 캡과 무관.
async function listDir(storage, prefix) {
  const out = [];
  for (let offset = 0; ;) {
    const { data, error } = await storage.list(prefix, { limit: 1000, offset });
    if (error) throw err('list-failed', String(error.message || error));
    const batch = data ?? [];
    if (batch.length === 0) break;
    out.push(...batch);
    offset += batch.length;
    // 폭주 상한(재검수 LOW) — 서버가 offset을 무시하면 빈 배치가 영영 안 와 행+메모리 폭주가 된다.
    // 디렉토리 하나에 10만 항목은 정상 데이터가 아니다 — 부분 목록 오인(무음)이 아니라 명시 실패로 끝낸다.
    if (out.length > 100_000) throw err('list-failed', `목록 폭주 차단: ${prefix} (${out.length}개 초과)`);
  }
  return out;
}

// 회사 하위 전체 파일 수집 — [{ key, rel }]. rel은 디코딩된 논리 경로('/' 구분).
// 디코딩 결과가 경로로서 위험하면(구분자·'..'·NUL 포함) 그 항목은 수집에서 제외하고 집계한다
// — 스토리지 키는 신뢰할 수 없는 입력이다(변조 키가 워크스페이스 밖 쓰기를 만들면 안 된다).
async function collectFiles(storage, keyPrefix, relBase, out, state) {
  for (const e of await listDir(storage, keyPrefix)) {
    const name = String(e.name);
    const seg = decSeg(name);
    if (seg === '.emptyFolderPlaceholder') continue; // Supabase 빈 폴더 마커 — 자료 아님(잡음)
    if (!seg || seg.includes('/') || seg.includes('\\') || seg.includes('\0') || seg === '.' || seg === '..') {
      state.unsafe += 1;
      continue;
    }
    const rel = relBase ? `${relBase}/${seg}` : seg;
    if (e.id) out.push({ key: `${keyPrefix}/${name}`, rel });
    else await collectFiles(storage, `${keyPrefix}/${name}`, rel, out, state);
  }
}

/** 코어 — 주입된 storage(from(BUCKET) 인터페이스)로 owner prefix 전체를 targetDir에 내려받는다.
    반환 { target, companies, files, failed, unsafe }. (export: 통합 테스트용 — 실 Supabase 없이 검증) */
export async function exportCloudAll({ storage, owner, targetDir }) {
  const top = await listDir(storage, owner);
  // 회사 = 폴더(id 없음). 점 접두(.tombstones)·직속 파일(_device-lease.json)은 동기화 인프라 — 자료가 아니다.
  const companies = top.filter((e) => !e.id && !String(e.name).startsWith('.'));
  if (companies.length === 0) throw err('empty', `클라우드에 회사 없음: ${owner}`);
  const tmp = `${targetDir}.partial`;
  await rm(tmp, { recursive: true, force: true }).catch(() => {}); // 강제 종료 잔재와의 병합 차단
  const state = { files: 0, failed: 0, unsafe: 0, companies: 0 };
  const usedNames = new Set();
  try {
    for (const c of companies) {
      const wsId = String(c.name);
      // 회사 세그먼트도 rel과 같은 계약으로 검증(분리 검수 HIGH) — RLS는 첫 세그먼트(uid)만 강제하므로
      // 두 번째 세그먼트가 '..' 같은 변조 키일 수 있고, 미검증 wsId는 폴백 폴더명으로 FS에 조립된다.
      // 정본은 workspace.mjs WS_ID_RE(회사 생성 규칙과 동일 문자셋).
      if (!WS_ID_RE.test(wsId)) { state.unsafe += 1; continue; }
      const files = [];
      await collectFiles(storage, `${owner}/${wsId}`, '', files, state);
      // 회사 표시명 — company.json의 name. 못 읽으면 wsId. 동명 회사는 (wsId) 접미로 구분.
      let display = wsId;
      try {
        const { data } = await storage.download(`${owner}/${wsId}/company.json`);
        if (data) {
          const meta = JSON.parse(openSecretCompat(Buffer.from(await data.arrayBuffer())).toString('utf8'));
          display = safeFolderName(meta?.name, wsId);
        }
      } catch { /* 표시명 실패는 wsId 폴백 — 자료 수집엔 영향 없음 */ }
      let folder = display;
      if (usedNames.has(folder.toLowerCase())) folder = `${display} (${wsId})`;
      usedNames.add(folder.toLowerCase());
      let wrote = 0;
      for (const f of files) {
        if (f.rel === '__manifest__.json') continue; // 동기화 인덱스 — 자료 아님
        if (exportExcluded(f.rel)) continue; // 자격 제외 정본(export.mjs) — 러너 키·봇 토큰·MCP 토큰
        if (!safeRel(f.rel)) { state.unsafe += 1; continue; } // 조립 전 최종 재검증(P1-7 계열)
        try {
          const { data, error } = await storage.download(f.key);
          if (error) throw new Error(String(error.message || error));
          const buf = openSecretCompat(Buffer.from(await data.arrayBuffer())); // 봉투면 복호, 평문은 그대로
          const full = join(tmp, folder, ...f.rel.split('/'));
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, buf);
          wrote += 1; state.files += 1;
        } catch { state.failed += 1; } // 파일 하나 실패(네트워크·개봉 실패)는 건너뛰고 계속 — 집계로 정직 보고
      }
      if (wrote > 0) state.companies += 1;
    }
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {}); // 부분 잔재 정리 — 잘린 사본의 무음 생존 방지
    throw e.code ? e : err('copy-failed', String(e.message || e));
  }
  // 변조 키 차단은 무음이면 안 된다(분리 검수 LOW — sync.mjs의 매니페스트 키 위생 warn과 동일 관례).
  // 위치는 files===0 throw보다 앞(재검수 LOW) — 전 세그먼트가 변조돼 하나도 못 받은, 로그가 가장
  // 필요한 경우에도 찍혀야 한다.
  if (state.unsafe > 0) console.warn(`[cloudexport] 안전하지 않은 스토리지 키 ${state.unsafe}개 무시(경로 탈출 차단) — owner=${owner}`);
  if (state.files === 0) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    // 회사는 있는데 한 파일도 못 받음 — 전부 실패면 실패로, 받을 게 없으면 empty로 정직하게 가른다
    throw state.failed > 0 ? err('copy-failed', `다운로드 전부 실패 (${state.failed}건)`) : err('empty', '내려받을 파일 없음');
  }
  await rename(tmp, targetDir); // 성공 시에만 정식 이름(원자 rename 관용구)
  return { target: targetDir, ...state };
}

// 자격 해석 — sync.mjs ensureClient와 같은 우선순위(서비스 자격 → 기기 세션). 캐시는 두지 않는다
// (1회성 버튼 — 매 호출 신선한 세션이 오히려 옳다). 타임아웃도 sync와 동일 30s.
const CLIENT_OPTS = {
  auth: { persistSession: false },
  global: { fetch: (url, opts) => fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) }) },
};
async function resolveStorage() {
  const svc = loadSyncCreds();
  if (svc && serviceCredsAllowed()) {
    const owner = process.env.ARGO_SYNC_OWNER || svc.owner || null;
    if (!owner) return null; // 오너 미상 서비스 모드 — 어느 prefix인지 모른다(무차별 순회 금지)
    const sb = createClient(svc.url, svc.key, CLIENT_OPTS);
    // 계정 키 확보(분리 검수 HIGH) — 봉투 파일(ARGO_ENC_VAULT면 전 파일)을 열려면 필수. sync 사이클이
    // 채우는 accountkey 캐시는 모듈 변수라 라우트 번들에선 비어 있을 수 있다. 실패는 null(개봉 실패는
    // 파일 단위 failed로 집계 — ensureAccountKey 자체가 throw하지 않는 계약).
    await ensureAccountKey(sb, owner);
    return { storage: sb.storage.from(BUCKET), owner };
  }
  const sess = await getFreshDeviceSession();
  if (!sess) return null;
  const sb = createClient(sess.url, sess.anonKey, {
    ...CLIENT_OPTS,
    global: { ...CLIENT_OPTS.global, headers: { Authorization: `Bearer ${sess.access_token}` } },
  });
  await ensureAccountKey(sb, sess.user.id); // 위와 동일 — 세션 모드도 봉투 개봉 키를 먼저 확보
  return { storage: sb.storage.from(BUCKET), owner: sess.user.id };
}

// in-flight 가드 — globalThis에(Next가 라우트를 별도 번들로 복제해도 하나를 본다, sync 상태와 동일 관례).
// 재클릭·이중 요청이 같은 목적지 후보를 두고 경합해 반쯤 겹친 사본을 만드는 것을 차단한다.
const inflight = (globalThis.__argoCloudExport ??= { busy: false });

/** 진입점 — 자격 해석 → 목적지 자동 선택 → 전체 다운로드. UI는 이 함수 하나만 부른다.
    requesterId: 라우트가 확인한 요청자 신원(currentUser). 서비스 모드(RLS 우회)에서 ARGO_SYNC_OWNER
    오설정이 요청자와 무관한 계정의 전 자료를 디스크로 덤프하는 것을 막는 심층 방어(분리 검수 MED)
    — 'local'(인증 off·게스트)은 대조 불가라 통과(정상 셀프호스트 경로 무영향). */
export async function exportCloudToLocal({ requesterId = null } = {}) {
  if (inflight.busy) throw err('busy', '클라우드 내보내기가 이미 진행 중');
  inflight.busy = true;
  try {
    const c = await resolveStorage();
    if (!c) throw err('no-creds', '동기화 자격 없음(서비스 자격·기기 세션 모두 부재)');
    if (requesterId && requesterId !== 'local' && c.owner !== requesterId) {
      throw err('owner-mismatch', '요청자와 내보내기 대상 계정이 다릅니다');
    }
    const docs = join(homedir(), 'Documents');
    await mkdir(docs, { recursive: true });
    const targetDir = pickExportTarget(docs);
    return await exportCloudAll({ storage: c.storage, owner: c.owner, targetDir });
  } finally {
    inflight.busy = false;
  }
}
