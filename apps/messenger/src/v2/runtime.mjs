// 메신저 v2 실행 묶음(U6c-1b) — 기존 셸(App.jsx)이 v2 모드에서 쓰는 것 한곳: 조회 어댑터(source.mjs)와 연결 상태 기계(link/machine.mjs).
// 셸은 계정마다 이 묶음을 하나 만들고(useMemo), 화면 구성 요소(채널·입력창)는 currentV2()로 같은 기계를 쓴다(속성 사슬을 늘리지 않게).
import { createLinkMachine } from '../link/machine.mjs';
import { STATES } from '../link/policy.mjs';
import { createV2Client } from './source.mjs';

let current = null;
/** 지금 셸의 v2 묶음(없으면 null — 플래그 꺼짐이거나 셸이 아직 없음). */
export const currentV2 = () => current;

/** 개인 공간 id — 계정마다 한 번 묻는다(실패하면 다음에 다시). */
export function personalSpaceOf(raw) {
  const memo = new Map();
  return async () => {
    const { data } = await raw.auth.getSession().catch(() => ({ data: null }));
    const uid = data?.session?.user?.id ?? null;
    if (!uid) return null;
    if (!memo.has(uid)) memo.set(uid, Promise.resolve(raw.rpc('msgr2_my_personal_space')).then((r) => (r?.error ? (memo.delete(uid), null) : r?.data ?? null), () => (memo.delete(uid), null)));
    return memo.get(uid);
  };
}

/** 모듈 하나에 클라이언트 하나 — 플래그가 켜졌을 때만 App.jsx가 부른다. */
export function createV2ClientFor(raw) { return createV2Client(raw, { personalSpace: personalSpaceOf(raw), ready: async () => { if (current) await current.ready(); } }); } // 등록 전 v2 읽기를 등록 뒤로(#1085 검수 2)

/** 기기 등록을 기다리다 그만둔 이유 — 조회는 이 코드의 오류로 끝난다(friendlyErr → 'v2.state.unreachable'). */
export const V2_NOT_READY = 'v2_not_registered';
/** 등록 대기 상한(#1086 검수 1) — 넘으면 조회를 실패로 돌리고 안내 줄을 띄운다. */
export const READY_MS = 15_000;
// 기기 등록이 끝났는가 — v2 표의 RLS는 등록된 기기 세션만 읽게 한다(U3). 기기 id가 있어야 등록이다(뒤로 간 앱도 — #1086 검수 1-③).
// 기다릴 수 없는 상태(중단·업데이트 필요·로그아웃)는 기다림을 풀어 그 상태 안내가 화면을 맡게 한다.
const HOLD = [STATES.paused, STATES.updateRequired, STATES.signedOut];
export const registeredOf = (s) => !!s && (!!s.deviceId || HOLD.includes(s.state));
/** 다시 붙기를 그만둔 상태(gave_up) — 기계는 타이머 없이 멈춰 있다. 사람이 다시 시도(machine.retry)해야 이어진다. */
export const gaveUpOf = (s) => s?.state === STATES.disconnected && String(s.reason ?? '').startsWith('gave_up:');
const notReady = (why) => Object.assign(new Error(V2_NOT_READY), { code: V2_NOT_READY, why });

/** 등록될 때까지 기다린다. 등록되면 풀리고, 그만둔 상태(gave_up)이거나 상한이 지나면 V2_NOT_READY로 거부한다(onStuck(이유)). */
export function waitRegistered(machine, { ms = READY_MS, timer = setTimeout, clear = clearTimeout, onStuck = null } = {}) {
  const now = machine.getSnapshot();
  if (registeredOf(now)) return Promise.resolve(now);
  if (gaveUpOf(now)) { onStuck?.('gave_up'); return Promise.reject(notReady('gave_up')); }
  return new Promise((resolve, reject) => {
    let t = null; let off = () => {};
    const end = (fn, v) => { off(); clear(t); fn(v); };
    off = machine.on('state', (s) => { if (registeredOf(s)) end(resolve, s); else if (gaveUpOf(s)) { onStuck?.('gave_up'); end(reject, notReady('gave_up')); } });
    t = timer(() => { onStuck?.('timeout'); end(reject, notReady('timeout')); }, ms);
  });
}

/** 셸 하나(계정 하나)의 기계. raw = 원래 supabase 클라이언트(기계는 msgr2_*만 부른다). */
export function createV2Runtime({ raw, client, uid, appVersion = null, readyMs = READY_MS, timer, clear }) {
  const machine = createLinkMachine({ client: raw, userId: uid, appVersion });
  let stuck = null; const stuckFns = new Set();
  const setStuck = (v) => { if (stuck === v) return; stuck = v; for (const fn of stuckFns) { try { fn(v); } catch { /* 화면 쪽 오류 */ } } };
  const off = machine.on('state', (s) => { if (registeredOf(s)) setStuck(null); else if (gaveUpOf(s)) setStuck('gave_up'); });
  const rt = { machine, client, uid };
  /** 등록을 기다린다(조회 어댑터·셸 목록 조회). 멈춘 기계를 다시 붙이지는 않는다 — 자동 재시도가 등록을 되풀이하지 않게(다시 붙이기는 rt.retry, 사람이 누를 때만). */
  rt.ready = () => waitRegistered(machine, { ms: readyMs, timer, clear, onStuck: setStuck });
  /** 안내 줄용: null | 'gave_up' | 'timeout'. */
  rt.stuck = () => stuck;
  rt.onStuck = (fn) => { stuckFns.add(fn); return () => stuckFns.delete(fn); };
  /** 안내 줄의 다시 시도 — 멈춘 기계를 다시 붙인다(사람이 누를 때만). */
  rt.retry = () => machine.retry?.();
  current = rt;
  rt.dispose = () => { off(); stuckFns.clear(); machine.stop(); if (current === rt) current = null; };
  return rt;
}
