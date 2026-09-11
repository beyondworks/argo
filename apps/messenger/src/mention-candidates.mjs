// @멘션 후보 — 사람을 먼저, 크루를 뒤에(유건 제보 2026-09-11: 크루가 8명을 넘으면 상한에 잘려 채널에 들어온 사람이 아예 안 떴다).
// 나 자신은 뺀다(슬랙과 같다). 검색어가 있으면 이름 부분 일치, 상한 8.
export const MENTION_MAX = 8;
export function mentionCandidates({ q = '', crews = [], members = [], uid = null, max = MENTION_MAX } = {}) {
  const needle = q.toLowerCase();
  const people = members.filter((m) => m.user_id !== uid).map((m) => ({ kind: 'user', id: m.user_id, name: m.display_name || m.user_id.slice(0, 8), sub: m.role }));
  const agents = crews.map((c) => ({ kind: 'crew', id: c.id, name: c.display_name, sub: c.role_text }));
  return [...people, ...agents].filter((x) => !needle || x.name.toLowerCase().includes(needle)).slice(0, max);
}
