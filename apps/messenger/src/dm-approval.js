// 채팅(DM) 에이전트 결재 — 화면 판정. 최종 강제는 서버(msgr_crew_join·msgr_can_decide_crew_join, 20260918170000)다.
// msgr_dm_approver 결과(res = { data, error })에서 화면이 쓸 상태를 만든다.
// RPC가 오류면 "결재자 모름"(legacy): 170000이 없는 서버는 채팅에 결재가 없으므로 '승인 필요'·안내를 띄우지 않는다.
// 앱이 라이브 적용보다 먼저 나가도 방을 연 사람 본인에게 틀린 안내가 보이지 않게 한다(검수 2026-09-18).
export function dmApprovalState(res, uid) {
  if (!res || res.error) return { legacy: true, approver: null, isApprover: false };
  const approver = res.data ?? null;
  return { legacy: false, approver, isApprover: !!approver && approver === uid };
}
// 이 채팅에 내 에이전트를 넣으면 결재가 필요한가 — 결재자 모름(legacy)이면 옛 규칙(바로 들어감)으로 본다.
export const dmNeedsApproval = (st) => !st.legacy && !st.isApprover;
