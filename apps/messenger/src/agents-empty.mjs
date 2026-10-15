// 레일 '에이전트' 구역과 빈 안내(D7, 2026-10-15 — 링크 감사 2-1). 메신저 계정이 실행기(Argo 앱)와 달라 개인 공간에 에이전트가 0명이면
// 구역 자체가 숨어 "아직 조직이 없습니다"만 보였다 — 어느 계정으로 로그인해야 하는지 단서가 없었다.
// shown = 레일에 보이는 연결 에이전트 수, available = 내가 꺼 둔(파견 해제) 에이전트 수, paused = 멈춘 내 에이전트 수(무료 한도·실행기 꺼짐 — 이유 안내가 따로 있다).
// ownEmpty = 내 에이전트 행 전체(로그인 때 읽는 readOwnCrews — active·available)를 읽었고 행이 하나도 없다(ownAgentsEmptyOf) — 읽지 못했거나(오프라인·옛 서버) 행이 있으면 false.
//   목록 읽기가 실패해 빈 것을 '계정이 다르다'로 안내하지 않게 하는 근거(새 요청 0).
// → { section: 구역을 그리나, hint: 구역 안 빈 안내 { key, vars } | null }
export function railAgentsView({ isPersonal, orgReady = false, shown = 0, available = 0, paused = 0, ownEmpty = false, email = null }) {
  if (!isPersonal) return { section: !!orgReady, hint: orgReady && !shown && !available ? { key: 'phone.agents.none', vars: {} } : null }; // 조직 공간 — 종전 그대로(UXM-08)
  if (shown > 0) return { section: true, hint: null }; // 에이전트가 있으면 종전 그대로
  if (available > 0 || paused > 0 || !ownEmpty) return { section: false, hint: null }; // 꺼 둔·멈춘 에이전트가 있다(같은 계정 — 멈춤 이유 안내가 따로 있다), 또는 내 에이전트가 정말 없는지 모른다 — 종전 그대로
  return { section: true, hint: accountHint(email) };
}
/** 폰 에이전트 탭이 비었을 때 — 멈춘 에이전트가 있거나(이유 안내가 위에 있다) 내 에이전트가 정말 없는지 모르면 종전 문구, 아니면 계정 단서 */
export function phoneAgentsEmpty({ paused = 0, ownEmpty = false, email = null }) {
  return paused > 0 || !ownEmpty ? { key: 'phone.agents.none', vars: {} } : accountHint(email);
}
const accountHint = (email) => (email ? { key: 'agents.none.account', vars: { email } } : { key: 'agents.none.account.noemail', vars: {} });

/** 내 에이전트가 정말 없나 — readOwnCrews 결과({ rows }, 못 읽었으면 null). readOwnCrews는 active·available을 함께 읽는다 —
    꺼 둔(available) 행만 있는 사용자도 같은 계정이므로 빈 것이 아니다(검수 2 #1037: '연결된 행 0'으로 셌더니 계정 단서가 잘못 떴다. 개인 공간 로더는 myAvailable을 늘 0으로 둔다) */
export function ownAgentsEmptyOf(own) { return !!own && own.rows.length === 0; }
