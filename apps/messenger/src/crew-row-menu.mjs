// 대화방 시트의 에이전트 행 '…' 메뉴 항목. 개인 공간은 에이전트 관리(시트)를 그리지 않으므로(조직 기능 — App.jsx CrewSheet 렌더 조건 !isPersonal)
// 메뉴에도 두지 않는다. 눌러도 시트만 닫히고 아무것도 안 열리던 결함(검수 F, 2026-10-01).
// 개인 공간에서 내 에이전트는 '빼기'(주인이 자기 에이전트를 이 방에서 빼는 서버 함수 msgr_crew_leave_channel)로만 뺀다 — 친구가 만든 그룹방에서
// 채널 행을 직접 지우면 서버가 "채널 관리자나 조직 관리자만 바꿀 수 있습니다"로 거절했다(실측 2026-10-01, QA 스택).
export function crewRowMenuKeys({ isPersonal, isDm, canKickCrew, ownedByMe }) {
  const viaLeave = ownedByMe && (isPersonal || !canKickCrew);
  return [
    !isPersonal && 'manage',
    !isDm && 'call',
    canKickCrew && !viaLeave && 'remove',
    viaLeave && 'leave',
  ].filter(Boolean);
}
