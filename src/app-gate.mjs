// 서버가 정하는 최소 앱 버전(유건 2026-10-13 "옛 버전 기기는 일시정지 화면에 업데이트 버튼을 띄우고, 무조건 업데이트하게 한다").
// 0.1.101 이하 앱은 서버가 멈출 장치가 없어 15초마다 Supabase를 불렀다(로그 과금의 약 10%). 앞으로 옛 버전이 생기면 이 장치로 멈춘다:
//  - 서버 값: argo_min_app_version('desktop')(msgr_settings 'min_app_version' 한 줄, 20261013190000). 행이 없으면 막지 않는다.
//  - 이 앱이 그보다 낮으면 getFreshDeviceSession이 세션 없음(null)을 돌려준다 — 동기화·메신저 브리지·알림·메일이 모두 "세션 없음" 경로로 호출 0.
//  - 화면은 /api/app-gate를 보고 일시 정지 화면(업데이트 버튼)을 띄운다(app/app-gate.jsx).
// 판정은 데이터 루트의 파일(.app-gate.json)이 정본이다 — Next는 이 모듈을 라우트·동기화 루프에 따로 번들해 메모리가 갈리고(devicesession.mjs 주석),
// 재시작·오프라인에서도 막힘이 풀리지 않아야 한다. 확인은 30분에 한 번(막힌 동안에도 — 서버가 값을 낮추면 풀린다). 확인 실패는 판정을 바꾸지 않는다.
// 버전을 모르는 앱(APP_VERSION null — 버전을 못 읽은 번들)은 막지 않는다: 비교할 수 없는데 막으면 최신 앱도 멈출 수 있다.
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { APP_VERSION } from './app-version.mjs';
import { cmpVersion } from './version-compare.mjs';
import { WS_ROOT } from './workspace.mjs';

export const APP_GATE_FILE = '.app-gate.json';
export const APP_GATE_RECHECK_MS = 30 * 60_000;     // 확인 주기 — 기기 1대당 시간당 2회
export const APP_GATE_RETRY_MS = 5 * 60_000;        // 확인 실패(오프라인·옛 서버 아님 오류) 뒤 다시 묻기까지
const fileOf = (root) => join(root, APP_GATE_FILE);
let memo = null; // { root, stamp, data } — 파일 도장(mtime+size)이 같을 때만 쓴다

/** 이 버전이 최소 버전보다 낮은가(순수). 최소 버전이 없거나 이 앱 버전을 모르면 거짓.
    '0.0.0'도 모름으로 본다 — 번들에서 버전을 못 읽으면 0.0.0이 되던 설치본 결함(0.1.101 실측, app-version.mjs)에서 최신 앱을 막지 않게. */
const unknownVersion = (v) => !v || cmpVersion(v, '0.0.0') === 0;
export const belowMin = (version, min) => !!min && !unknownVersion(version) && cmpVersion(version, min) < 0;

/** 파일의 마지막 판정 { min, checkedAt } — 없으면 { min: null, checkedAt: 0 } */
export function readAppGate(root) {
  let stamp = 'none';
  try { const st = statSync(fileOf(root)); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* 없음 */ }
  if (memo && memo.root === root && memo.stamp === stamp) return memo.data;
  let data = { min: null, checkedAt: 0 };
  if (stamp !== 'none') try { const d = JSON.parse(readFileSync(fileOf(root), 'utf8')); data = { min: typeof d.min === 'string' && d.min ? d.min : null, checkedAt: Number(d.checkedAt) || 0 }; } catch { /* 손상 — 막지 않는다 */ }
  memo = { root, stamp, data };
  return data;
}

async function writeAppGate(root, data) {
  await mkdir(root, { recursive: true });
  const tmp = `${fileOf(root)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, fileOf(root));
  memo = null;
}

/** 지금 막혀 있나(파일 기준, 네트워크 없음) — 화면·세션 관문이 같이 쓴다 */
export function appGateState(root, version = APP_VERSION) {
  const { min, checkedAt } = readAppGate(root);
  return { blocked: belowMin(version, min), min, version: version ?? null, checkedAt };
}

const inflight = new Map(); // root → Promise — 같은 프로세스 사본 안에서 확인을 겹치지 않게
/** 확인 기한이 지났으면 서버에 최소 버전을 묻고 파일에 남긴다. sess = 기기 세션(access_token·url·anonKey), mk = createClient.
    성공: 서버 값(없으면 null)으로 바꾼다. 실패: 판정은 그대로 두고 APP_GATE_RETRY_MS 뒤 다시 묻는다. 옛 서버(함수 없음)는 null(막지 않음). */
export async function refreshAppGate(root, sess, mk, { now = Date.now } = {}) {
  const prev = readAppGate(root);
  if (now() - prev.checkedAt < APP_GATE_RECHECK_MS) return prev;
  if (inflight.has(root)) return inflight.get(root);
  const run = (async () => {
    let next;
    try {
      const sb = mk(sess.url, sess.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${sess.access_token}` } } });
      const { data, error } = await sb.rpc('argo_min_app_version', { p_app: 'desktop' });
      if (error && !['PGRST202', '42883'].includes(error.code)) throw new Error(error.message);
      next = { min: !error && typeof data === 'string' && data.trim() ? data.trim() : null, checkedAt: now() };
    } catch {
      next = { min: prev.min, checkedAt: now() - APP_GATE_RECHECK_MS + APP_GATE_RETRY_MS };
    }
    await writeAppGate(root, next).catch(() => {});
    return next;
  })().finally(() => inflight.delete(root));
  inflight.set(root, run);
  return run;
}

/** 서버 확인용 클라이언트 — 5초 안에 끝나지 않으면 끊는다(확인 실패는 판정을 바꾸지 않는다) */
export const appGateClient = (url, key, opts) => createClient(url, key, { ...opts, global: { ...opts?.global, fetch: (u, init = {}) => fetch(u, { ...init, signal: AbortSignal.timeout(5_000) }) } });

/** 이 프로세스의 데이터 루트(WS_ROOT) 기준 — 호출부가 루트를 들고 있지 않은 곳(메신저 세션 클라이언트)용 */
export const appGateBlockedHere = () => appGateState(WS_ROOT).blocked;

/** 시험용 — 메모를 비운다 */
export function _resetAppGateForTest() { memo = null; inflight.clear(); }
