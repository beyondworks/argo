// 메신저 v2 연결부(agent-link-host.mjs)의 실제 상태 — 설정 › 연결의 메신저 칸(msgr-archive GET)과 argo_status 'messenger' 구획이 읽는다.
// 프로세스 메모리 한 곳(globalThis — 게이트웨이와 Next 라우트가 같은 프로세스에서 모듈을 따로 읽어도 같은 값). 읽기·쓰기 모두 요청 0.
// 2026-10-28 제보: 메신저 앱의 "모든 기기 로그아웃"으로 본체 기기가 폐기됐는데 설정·자기소개는 계속 "연결됨"이었다 — 이제 연결부가 겪은 그대로 보인다.

/** 상태값. off = 연결부가 돌지 않음(무료·예비 기기·꺼짐·시작 전), starting = 등록·러너 감지 중, ok = 일을 받는 중,
 *  no_runners = 기기는 등록됐지만 쓸 수 있는 러너 0개(서버가 일을 주지 않는다), reauth = 기기 폐기·만료·세션 거부(403) — 다시 로그인해야 한다,
 *  signed_out = 이 기기 로그인 없음, pro_required = 무료 계정(메신저는 Pro), update_required = 앱 업데이트 필요, paused = 서버 중단 스위치,
 *  error = 일시 오류로 다시 시도 중. */
export const LINK_STATES = Object.freeze(['off', 'starting', 'ok', 'no_runners', 'reauth', 'signed_out', 'pro_required', 'update_required', 'paused', 'error']);

const OFF = Object.freeze({ state: 'off', code: null, runners: [], agents: 0, at: null });
const box = (globalThis.__argoAgentLinkStatus ??= { cur: OFF });

/** 지금 상태(사본). code = 짧은 오류 코드(토큰·개인 정보 없음), runners = 등록한 러너 id, agents = 맡은 에이전트 수. */
export function linkStatus() {
  const c = box.cur;
  return { state: c.state, code: c.code ?? null, runners: [...(c.runners ?? [])], agents: c.agents ?? 0, at: c.at ?? null };
}

/** 연결부가 상태가 바뀔 때만 부른다(agent-link-host.mjs onStatus). 모르는 상태값은 error로 둔다. */
export function setLinkStatus(s) {
  const state = LINK_STATES.includes(s?.state) ? s.state : 'error';
  box.cur = { state, code: s?.code ?? null, runners: Array.isArray(s?.runners) ? [...s.runners] : [], agents: Number.isInteger(s?.agents) ? s.agents : 0, at: s?.at ?? Date.now() };
}

/** 시험용 — 처음(off)으로 */
export function resetLinkStatus() { box.cur = OFF; }
