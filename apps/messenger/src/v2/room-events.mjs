// 메신저 v2 공간·방 사건(U6d 서버 v2:u: 방송 'spaces'·'rooms'·'invite') → 셸이 다시 읽을 것(U6c-2b). 셸은 사건을 짧은 창(500ms)에 묶어 창마다 한 번만 읽는다.
//   spaces {space_id, removed?}           → 공간 목록 다시 읽기
//   rooms  {space_id?, room_id, removed?} → 보고 있는 공간이면 그 공간의 방 목록 다시 읽기, 그 방을 보고 있다가 빠졌으면 닫기.
//                                           개인 방은 처음 연 사람의 개인 공간에 있다(친구가 열면 친구 공간) — 내 팀 공간이 아니면 개인 방으로 본다(#1088 검수 1)
//   invite {invite_id, space_id}          → 초대 목록 다시 읽기(설정 > 멤버의 초대 관리, 받은 초대함 화면은 아직 없다)
/** ev = { event, payload }, at = { orgId(보는 공간 — 개인이면 personal 값), personal(개인 공간 자리 값), teamIds(내 팀 공간 id들), chId }. */
export function roomEventPlan(ev, { orgId, personal, teamIds = [], chId = null } = {}) {
  const p = ev?.payload ?? {}; const none = { orgs: false, reload: false, forget: null, close: false, invites: false };
  if (ev?.event === 'spaces') return { ...none, orgs: true, forget: p.space_id ?? null };
  if (ev?.event === 'invite') return { ...none, invites: true };
  if (ev?.event !== 'rooms') return none;
  const space = p.space_id ?? null;
  const personalRoom = space != null && !teamIds.includes(space);
  const here = space == null || space === orgId || (orgId === personal && personalRoom);
  return { ...none, reload: here, forget: space, close: !!p.removed && p.room_id != null && p.room_id === chId };
}

/** 묶음 창 안의 계획을 하나로 합친다(목록 읽기는 창마다 한 번 — #1088 검수 2). */
export function mergePlans(a, b) {
  if (!a) return { ...b, forget: b.forget ? [b.forget] : [] };
  return { orgs: a.orgs || b.orgs, reload: a.reload || b.reload, invites: a.invites || b.invites, close: false, forget: b.forget ? [...new Set([...a.forget, b.forget])] : a.forget };
}
