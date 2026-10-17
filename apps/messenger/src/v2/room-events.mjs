// 메신저 v2 공간·방 사건(U6d 서버 v2:u: 방송 'spaces'·'rooms'·'invite') → 셸이 다시 읽을 것(U6c-2b). 받는 쪽은 사건마다 목록 조회 1회까지, 유휴 0.
//   spaces {space_id, removed?}           → 공간 목록 다시 읽기
//   rooms  {space_id?, room_id, removed?} → 보고 있는 공간이면 그 공간의 방 목록 다시 읽기(공간을 모르면 보고 있는 공간), 그 방을 보고 있다가 빠졌으면 닫기
//   invite {invite_id, space_id}          → 사람 지정 초대 도착(받은 초대함 화면은 아직 없다 — 미룸). 아무것도 읽지 않는다
/** ev = { event, payload }, at = { orgId(보는 공간 — 개인이면 personal 값), personal(개인 공간 자리 값), personalId(개인 공간의 진짜 id·없으면 null), chId }. */
export function roomEventPlan(ev, { orgId, personal, personalId = null, chId = null } = {}) {
  const p = ev?.payload ?? {}; const none = { orgs: false, reload: false, forget: null, close: false };
  if (ev?.event === 'spaces') return { ...none, orgs: true, forget: p.space_id ?? null };
  if (ev?.event !== 'rooms') return none;
  const space = p.space_id ?? null;
  const here = space == null || space === orgId || (orgId === personal && personalId != null && space === personalId);
  return { orgs: false, reload: here, forget: space, close: !!p.removed && p.room_id != null && p.room_id === chId };
}
