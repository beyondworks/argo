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
export function createV2ClientFor(raw) { return createV2Client(raw, { personalSpace: personalSpaceOf(raw), ready: async () => { await current?.registered; } }); } // 등록 전 v2 읽기를 등록 뒤로(#1085 검수 2)

// 기기 등록이 끝났는가 — v2 표의 RLS는 등록된 기기 세션만 읽게 한다(U3). 목록 조회는 그 뒤에.
const AFTER_REGISTER = [STATES.subscribing, STATES.catchingUp, STATES.ready, STATES.background, STATES.paused, STATES.updateRequired, STATES.signedOut];

/** 셸 하나(계정 하나)의 기계. raw = 원래 supabase 클라이언트(기계는 msgr2_*만 부른다). */
export function createV2Runtime({ raw, client, uid, appVersion = null }) {
  const machine = createLinkMachine({ client: raw, userId: uid, appVersion });
  let off = () => {};
  const registered = new Promise((resolve) => {
    const check = (s) => { if (s && (s.deviceId || AFTER_REGISTER.includes(s.state))) { off(); resolve(s); } };
    off = machine.on('state', check);
    check(machine.getSnapshot());
  });
  const rt = { machine, client, uid, registered };
  current = rt;
  rt.dispose = () => { off(); machine.stop(); if (current === rt) current = null; };
  return rt;
}
