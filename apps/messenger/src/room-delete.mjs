// 대화방 삭제 판정(유건 결정 2026-10-06) — 서버 msgr_can_delete_channel(20261006170000)과 같은 기준.
// 조직 그룹 대화(조직 안 kind='dm', 사람 3명 이상)는 만든 사람(지금 참여 중)과 조직 관리자(owner·admin)만 지운다. 나머지 참여자는 나가기만.
// 에이전트 행은 세지 않는다 — 사람 둘 + 에이전트는 두 사람의 대화라 1:1 규칙(두 사람 모두 삭제).
// 구성원을 아직 못 읽었으면(빈 목록) 막지 않는다 — 판정은 서버가 하고, 1:1에서 삭제 메뉴가 깜빡 사라지지 않게.
// 개인 그룹(조직 밖)은 종전 규칙(만든 사람만 끝내기·삭제)이 App.jsx dmItemsOf에 따로 있다.

/** 조직 그룹 대화인가 — members: dmMembers 행({ member_kind, member_id }) */
export function isOrgGroupRoom(c, members = []) {
  if (!c || c.kind !== 'dm' || c.org_id == null) return false;
  return members.filter((m) => m.member_kind === 'user').length >= 3;
}

/** 이 대화방을 지울 수 있는가 — isOrgAdmin: 지금 조직에서 owner·admin */
export function canDeleteRoom({ c, members = [], uid = null, isOrgAdmin = false } = {}) {
  if (!isOrgGroupRoom(c, members)) return true;
  const inRoom = members.some((m) => m.member_kind === 'user' && m.member_id === uid);
  return !!inRoom && (c.created_by === uid || !!isOrgAdmin);
}
