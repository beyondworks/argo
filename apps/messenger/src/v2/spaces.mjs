// 메신저 v2 공간 목록(U6 ①): 개인 공간과 팀 공간을 한 목록·한 전환으로. 기존 사이드바의 공간 메뉴(개인 공간이 맨 위, 그 아래 조직)와 같은 순서.
// 서버: msgr2_spaces(RLS — 내가 볼 수 있는 공간), msgr2_space_members(내 역할), msgr2_my_personal_space()(없으면 만든다).

/**
 * spaces: msgr2_spaces 행들, members: 내 msgr2_space_members 행들(user_id = 나), personalId: 내 개인 공간 id.
 * 반환: [{ id, kind, name, role, personal }] — 개인 공간 먼저, 그다음 팀 공간을 이름순(같으면 id순). 빠졌거나 만료된 팀 멤버십은 뺀다.
 */
export function spaceList({ spaces = [], members = [], personalId = null, now = Date.now() } = {}) {
  const role = new Map();
  for (const m of members) {
    if (m.removed_at || (m.expires_at && Date.parse(m.expires_at) <= now)) continue;
    role.set(m.space_id, m.role);
  }
  const out = [];
  const pers = spaces.find((s) => s.id === personalId) || spaces.find((s) => s.kind === 'personal');
  if (pers) out.push({ id: pers.id, kind: 'personal', name: '', role: 'owner', personal: true });
  const teams = spaces.filter((s) => s.kind === 'team' && !s.deleted_at && role.has(s.id))
    .map((s) => ({ id: s.id, kind: 'team', name: s.name || '', role: role.get(s.id), personal: false }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
  return out.concat(teams);
}

/** v2:s:<공간>을 구독할 공간 — 내가 owner·admin·member인 팀 공간(손님은 그 토픽을 못 받는다, U2b 정책). */
export const liveSpaceIds = (list) => list.filter((s) => s.kind === 'team' && ['owner', 'admin', 'member'].includes(s.role)).map((s) => s.id);

/** 시작 공간: 저장한 마지막 공간이 아직 목록에 있으면 그것, 아니면 개인 공간(없으면 첫 공간). */
export function pickStartSpace(list, lastId) {
  if (lastId && list.some((s) => s.id === lastId)) return lastId;
  return (list.find((s) => s.personal) || list[0])?.id ?? null;
}
