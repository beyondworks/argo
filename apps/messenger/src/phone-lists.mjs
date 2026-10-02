// 폰 채팅·채널 목록(유건 요청 2026-10-02) — 토스트 문구, 채팅 탭 즐겨찾기 단락, 채널 탭 '즐겨찾기 · 채널 · <그룹들…>' 메뉴.
// 그룹은 나만 보이고(서버 msgr_channel_groups — 내 기기끼리 맞춰짐), 채널 하나는 그룹 하나에만(msgr_channel_group_links 기본 키 user_id+channel_id).
// 순수 함수만 — 화면·저장은 App.jsx. 테스트: test/phone-lists.test.mjs

export const FLASH_MS = 2500; // 즐겨찾기·알림 끄기 토스트 — 누르면 바로, 아니면 이만큼 뒤에 저절로 사라진다
export const flashKey = (kind, on) => `flash.${kind}.${on ? 'on' : 'off'}`;

/** 채팅 탭 — 즐겨찾기(고정)한 대화는 위 단락, 나머지는 아래. 각 단락 안 순서는 들어온 순서 그대로(정렬은 sortRooms가 이미 했다). */
export function splitFavs(list, pinned) {
  return { favs: list.filter((c) => pinned.has(c.id)), rest: list.filter((c) => !pinned.has(c.id)) };
}

export const GROUP_NAME_MAX = 30; // 서버 check와 같다
export const cleanGroupName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
const nameKey = (s) => cleanGroupName(s).toLowerCase();
/** 같은 조직 안 내 그룹 이름 겹침(대소문자 무시 — 서버 유일 색인 lower(name)과 같다). 자기 자신(exceptId)은 뺀다. */
export const groupNameTaken = (groups, name, exceptId = null) => groups.some((g) => g.id !== exceptId && nameKey(g.name) === nameKey(name));

export const sortGroups = (groups) => [...groups].sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')) || String(a.name).localeCompare(String(b.name), 'ko'));
export const nextGroupPos = (groups) => (groups.length ? Math.max(...groups.map((g) => g.pos ?? 0)) + 1 : 0);

/** 채널 탭 메뉴 — 'fav' · 'channels' · 'g:<그룹 id>'(pos 순). 화면은 맨 끝에 '+'를 붙인다. */
export const channelMenu = (groups) => ['fav', 'channels', ...sortGroups(groups).map((g) => `g:${g.id}`)];
/** 고른 메뉴가 없어졌으면(그룹을 지움·다른 기기에서 지움) '채널'로 */
export const resolveMenu = (key, groups) => (key && channelMenu(groups).includes(key) ? key : 'channels');

/** 채널이 든 그룹(없거나 지운 그룹을 가리키면 null — '채널' 메뉴에 남는다) */
export function groupOfChannel(links, groups, channelId) {
  const gid = links.find((l) => l.channel_id === channelId)?.group_id;
  return gid ? (groups.find((g) => g.id === gid) ?? null) : null;
}

/** 메뉴별 채널 — 즐겨찾기 = 고정한 채널 전부(그룹과 상관없이), 채널 = 그룹에 안 넣은 채널, 그룹 = 그 그룹의 채널. 순서는 들어온 그대로. */
export function menuChannels(key, list, { pinned = new Set(), links = [], groups = [] } = {}) {
  if (key === 'fav') return list.filter((c) => pinned.has(c.id));
  if (key?.startsWith('g:')) { const gid = key.slice(2); return list.filter((c) => groupOfChannel(links, groups, c.id)?.id === gid); }
  return list.filter((c) => !groupOfChannel(links, groups, c.id));
}

/** '이 조직의 대화' 단락 — 채널 메뉴는 전부(종전 화면 그대로), 즐겨찾기는 고정한 대화만, 그룹 메뉴엔 없다(대화방은 그룹에 넣지 않는다) */
export function menuTalks(key, talks, pinned = new Set()) {
  if (key === 'fav') return talks.filter((c) => pinned.has(c.id));
  if (key?.startsWith('g:')) return [];
  return talks;
}

/** 채널 하나를 그룹에 넣기·옮기기(groupId) 또는 빼기(null). 바뀐 것이 없으면 op 'none' — 쓰지 않는다(DB 위생). */
export function linkChange(links, channelId, groupId) {
  const cur = links.find((l) => l.channel_id === channelId)?.group_id ?? null;
  if (cur === (groupId ?? null)) return { op: 'none', next: links };
  const rest = links.filter((l) => l.channel_id !== channelId);
  if (!groupId) return { op: 'delete', next: rest };
  return { op: 'upsert', next: [...rest, { channel_id: channelId, group_id: groupId }] };
}

/** 그룹 편집 저장 — 체크한 채널(checked)과 지금 연결을 비교해 넣을 것(다른 그룹에서 옮겨 오는 것 포함)·뺄 것만 */
export function groupDiff(links, groupId, checked) {
  const want = new Set(checked);
  const now = new Set(links.filter((l) => l.group_id === groupId).map((l) => l.channel_id));
  return { add: [...want].filter((id) => !now.has(id)), remove: [...now].filter((id) => !want.has(id)) };
}
