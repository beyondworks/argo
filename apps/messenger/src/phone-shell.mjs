// 폰 셸 v2 — 아래 탭 5개(친구 / 채팅 / 채널 / 에이전트 / 기억, 유건 확정 2026-10-01)의 판단을 한 곳에 둔다.
// 순수 함수만(DOM·React·supabase 없음) — 행동은 test/phone-shell.test.mjs가 고정한다. 화면 배선은 App.jsx.
import { sortDms } from './dm-sort.mjs';
import { plainPreview } from './msg-text.mjs';

export const PHONE_TABS = ['friends', 'chats', 'channels', 'agents', 'memory'];
const ROOTS = new Set(PHONE_TABS);
/** 아래 탭이 있는 루트 화면인가 — 대화방·설정·검색은 그 위에 여는 화면 */
export const isPhoneRoot = (page) => ROOTS.has(page);
/** 채팅 탭 칩(전체 / 안읽음 N / 에이전트 / 그룹) */
export const CHAT_FILTERS = ['all', 'unread', 'agent', 'group'];

/** 탭이 보여 줄 공간. 채팅 = 개인 공간, 채널·기억 = 고른 조직(없으면 null — 공간을 바꾸지 않고 빈 안내), 친구·에이전트 = null(지금 공간 그대로) */
export function spaceForTab(tab, { personal, chOrg = null } = {}) {
  if (tab === 'chats') return personal;
  if (tab === 'channels' || tab === 'memory') return chOrg ?? null;
  return null;
}

/** 채널 탭이 고를 조직 — 고른 적 있는 조직이 아직 목록에 있으면 그것, 아니면 마지막 공간이 조직이면 그것, 아니면 첫 조직 */
export function pickChannelOrg({ saved = null, last = null, orgIds = [] } = {}) {
  if (saved && orgIds.includes(saved)) return saved;
  if (last && orgIds.includes(last)) return last;
  return orgIds[0] ?? null;
}

/** 공간이 바뀐 뒤 기억할 채널·기억 탭 조직 — 조직 공간에 들어가면 그 조직, 개인 공간·없음이면 그대로(두 탭이 같은 값을 쓴다) */
export function savedOrgAfter(saved, orgId, personal) {
  return orgId && orgId !== personal ? orgId : saved;
}

/** 머리 조직 메뉴 항목(유건 3차 피드백 2026-10-02) — 채널 탭은 조직 일 전체, 기억 탭은 조직 고르기 + 기억 설정만 */
export function orgMenuItems(tab, { admin = false } = {}) {
  if (tab === 'memory') return ['orgs', 'memory-settings'];
  return ['orgs', 'joinable', 'deleted', 'join', ...(admin ? ['invite', 'org-settings'] : [])];
}

/** 처음 여는 탭 — 마지막 공간이 (아직 있는) 조직이면 채널, 개인 공간이거나 처음이면 채팅 */
export function startTab({ last = null, personal, orgIds = [] } = {}) {
  return last && last !== personal && orgIds.includes(last) ? 'channels' : 'chats';
}

/** 아래 탭 숫자. here = 보고 있는 공간의 채널별 최신 셈(음소거 제외), totals = 공간별 서버 합계({ personal|orgId: { n } }).
    hereReady가 거짓이면(공간을 막 바꿔 채널별 셈이 아직 없음) 그 공간도 서버 합계로 센다 — 숫자가 0으로 깜빡이지 않게. */
export function tabBadges({ hereKey = null, here = null, hereReady = false, totals = {}, orgIds = [], personalKey = 'personal', approvals = 0, friendRequests = 0 } = {}) {
  const n = (key) => (key === hereKey && hereReady ? here?.n : totals?.[key]?.n) || 0;
  return {
    friends: friendRequests || 0,
    chats: n(personalKey),
    channels: orgIds.reduce((sum, id) => sum + n(id), 0),
    agents: approvals || 0,
    memory: 0,
  };
}

/** 뱃지 글자 — 0 이하면 빈 문자열(그리지 않는다), 100부터 '99+' */
export const badgeText = (n) => (n > 99 ? '99+' : n > 0 ? String(n) : '');

/** 방의 성격. 그룹 = 나 말고 둘 이상(단 "사람 1 + 그 사람의 에이전트 1"은 남의 에이전트 1:1), 에이전트 방 = 에이전트가 들어 있음. size = 인원(나 포함) */
export function roomTraits({ c = {}, members = [], uid = null, ownerOf = () => null } = {}) {
  const people = members.filter((m) => m.member_kind === 'user' && m.member_id !== uid);
  const crews = members.filter((m) => m.member_kind === 'crew');
  const others = people.length + crews.length;
  const ownersPair = people.length === 1 && crews.length === 1 && ownerOf(crews[0].member_id) === people[0].member_id;
  return {
    group: !!c._personal_group || (others >= 2 && !ownersPair),
    agent: crews.length > 0 || !!c._personal_crew,
    size: others + 1,
  };
}

/** 칩에 보일 방인가 — r: roomRow 결과 + roomTraits */
export function chatVisible(filter, r) {
  if (filter === 'unread') return r.unreadN > 0 && !r.muted;
  if (filter === 'agent') return !!r.agent;
  if (filter === 'group') return !!r.group;
  return true;
}

/** '안읽음 N' 칩 숫자 — 목록에 있는 방의 안 읽은 글 합(알림 끈 방 제외). 채팅 탭 뱃지와 같은 규칙 */
export function chatUnreadTotal(list, unread = {}, muted = new Set()) {
  let n = 0;
  for (const c of list) if (!muted.has(c.id)) n += unread[c.id]?.n || 0;
  return n;
}

/** 목록 한 줄의 정보 — 마지막 글(미리보기는 마크다운을 벗긴 한 줄, 두 줄 자르기는 CSS)·시각·안 읽음·@·고정·알림 끔.
    개인 방은 목록 조회(msgr_dm_personal_list)가 준 마지막 글로 시작하고, 실시간으로 받은 글이 더 새것이면 그것을 쓴다. */
export function roomRow({ c, lastMsg = null, lastAt = 0, unread = null, muted = false, pinned = false }) {
  const listAt = Date.parse(c?._personal_last_at ?? '') || 0;
  const live = lastMsg && (lastMsg.at || 0) >= listAt ? lastMsg : null;
  const preview = live ? (live.body ?? '') : (c?._personal_last_body != null ? plainPreview(c._personal_last_body) : (lastMsg?.body ?? ''));
  return {
    at: Math.max(live?.at || 0, listAt, lastAt || 0, lastMsg?.at || 0),
    preview,
    mine: !!live?.mine,
    userId: live?.userId ?? null,
    crewId: live?.crewId ?? null,
    unreadN: unread?.n || 0,
    mention: (unread?.mention || 0) > 0,
    pinned: !!pinned,
    muted: !!muted,
  };
}

/** 채팅·채널 목록 순서 — 고정한 방이 위(고정 순서 pin_pos), 나머지는 고른 정렬(기본 최근 글 순, dm-sort.mjs와 같은 규칙) */
export function sortRooms(list, { sort = 'recent', atOf = () => 0, unread = {}, pinned = new Set(), pinPos = new Map(), nameOf = (c) => c.name ?? '', sortPos = {} } = {}) {
  const top = list.filter((c) => pinned.has(c.id)).sort((a, b) => (pinPos.get(a.id) ?? 1e9) - (pinPos.get(b.id) ?? 1e9) || nameOf(a).localeCompare(nameOf(b), 'ko'));
  const rest = list.filter((c) => !pinned.has(c.id));
  const lastAt = Object.fromEntries(rest.map((c) => [c.id, atOf(c)]));
  return [...top, ...sortDms(rest, { sort, lastAt, unread, nameOf, sortPos })];
}

/** 탭 안 검색 — fields(item)가 돌려준 글자들에서 대소문자 없이 찾는다. 빈 검색어는 전부 */
export function tabSearch(items, query, fields, alsoHit = null) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((x) => alsoHit?.(x) || fields(x).some((v) => String(v ?? '').toLowerCase().includes(q)));
}

/** 채팅·채널 탭 검색의 서버 본문 검색어(기능 점검 D9) — 두 글자부터만 요청한다(한 글자는 거의 모든 방이 맞고 요청만 늘린다). */
export function tabBodyQuery(query) {
  const q = String(query ?? '').trim();
  return q.length >= 2 ? q : null;
}

/** 기억 탭 폴더 — 조직 전체 기억(규칙·용어·프로젝트 순) / 채널별 기억(문서 먼저, 일지는 늘 최신이 위).
    sort: 'recent'(기본 — 문서·채널 묶음 모두 최근에 바뀐 것이 위) | 'name'(문서 제목·채널 이름순). 설정 > 기억에서 고른다(이 기기에 기억).
    query가 있으면 제목·본문에서 먼저 거른다(탭 안 검색). 문서는 서버 msgr_org_docs(조직 단위 — 개인 공간 기억은 서버에 없다). */
export const MEM_FOLDERS = ['rules', 'glossary', 'projects'];
export const MEM_SORTS = ['name', 'recent'];
export function memoryGroups(docs, { query = '', channelLabel = (id) => id, sort = 'recent' } = {}) {
  const shown = tabSearch(docs, query, (d) => [d.title, d.body]);
  const byTitle = (a, b) => String(a.title).localeCompare(String(b.title), 'ko');
  const byRecent = (a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || byTitle(a, b);
  const order = sort === 'name' ? byTitle : byRecent;
  const org = MEM_FOLDERS.map((f) => ({ key: f, docs: shown.filter((d) => !d.channel_id && d.path.startsWith(`${f}/`)).sort(order) })).filter((g) => g.docs.length);
  const byCh = new Map();
  for (const d of shown) if (d.channel_id) { if (!byCh.has(d.channel_id)) byCh.set(d.channel_id, []); byCh.get(d.channel_id).push(d); }
  const journal = (d) => d.path.startsWith('journal/');
  const channels = [...byCh.entries()].map(([key, ds]) => ({ key, label: channelLabel(key), latest: ds.reduce((m, d) => (String(d.updated_at) > m ? String(d.updated_at) : m), ''),
    docs: [...ds.filter((d) => !journal(d)).sort(order), ...ds.filter(journal).sort((a, b) => b.path.localeCompare(a.path))] }))
    .sort((a, b) => (sort === 'name' ? String(a.label).localeCompare(String(b.label), 'ko') : b.latest.localeCompare(a.latest))).map(({ latest, ...g }) => g); // eslint-disable-line no-unused-vars
  return { org, channels, total: shown.length };
}

/** 기억 검색 결과 발췌 — 마크다운을 벗긴 한 줄에서 찾은 자리 앞뒤(max자), 못 찾으면 앞부분 */
export function memSnippet(body, query, max = 90) {
  const text = plainPreview(body ?? '', 4000);
  if (!text) return '';
  const q = String(query ?? '').trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0 || text.length <= max) return text.slice(0, max) + (text.length > max ? '…' : '');
  const start = Math.max(0, i - Math.floor((max - q.length) / 2)); const end = Math.min(text.length, start + max);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** 설정 > 내 에이전트 줄을 눌렀을 때(유건 2차 피드백 1): 조직 에이전트 = 그 조직 공간으로 바꿔 에이전트 카드, 개인 에이전트 = 개인 에이전트 카드.
    대화로 넘기지 않는다(문구가 '카드가 열립니다'). 알 수 없는 줄은 이유를 알린다 — 눌러도 아무 일도 없는 줄을 만들지 않는다. */
export function agentCardAction(c) {
  if (!c?.id) return { do: 'note', why: 'missing' };
  if (c.org_id) return { do: 'org-card', space: c.org_id };
  return { do: 'personal-card' };
}
/** 조직 카드 — 공간을 바꾼 뒤 한 걸음. 동의 전(조직 화면 잠김)·크루 없음·늦음은 이유를 알린다 */
export function orgCardStep({ found = false, blocked = false, timedOut = false } = {}) {
  if (timedOut) return { do: 'note', why: 'slow' };
  if (blocked) return { do: 'note', why: 'blocked' };
  return found ? { do: 'open' } : { do: 'note', why: 'missing' };
}
/** 개인 에이전트 카드에서 잠글 칸과 이유 — 서버 규칙 그대로: 이름은 Argo 앱(이름표·연결 열은 msgr_lock_crews),
    개인 쪽 외부 에이전트(조직 봇의 쌍둥이)는 이름·직무·지시 범위가 조직을 따른다(msgr_bot_twin_lock). 얼굴·사진·소개는 주인이 바꾼다 */
export function personalCardLocks(c) {
  const twin = c?.hosting === 'bot';
  return { name: twin ? 'twin' : 'argo', role: twin ? 'twin' : null, allow: twin ? 'twin' : null, face: null, bio: null };
}

/** 숨김(유건 4차 피드백 2026-10-02) — 내 목록에서만 뺀다. 친구 관계·대화·알림은 그대로라 목록·후보를 그리는 자리에서만 거른다.
    hidden이 없으면(아직 못 불러옴) 그대로 둔다 — 숨긴 사람이 잠깐 보이는 쪽이 친구가 통째로 사라지는 쪽보다 낫다. */
export function withoutHidden(list, hidden, idOf = (x) => x.user_id) {
  if (!hidden?.size) return list;
  return list.filter((x) => !hidden.has(idOf(x)));
}

/** 숨김 탭 — 숨긴 친구(친구 행 그대로: 사진·이름·아이디)와 숨긴 에이전트. 친구가 아닌 숨김 행(친구 삭제 뒤 남은 것)은 보이지 않는다 */
export function hiddenGroups({ friends = [], hiddenUserIds = null, mutedCrews = [] } = {}) {
  return { friends: hiddenUserIds?.size ? friends.filter((f) => f.status === 'accepted' && hiddenUserIds.has(f.user_id)) : [], agents: mutedCrews };
}

const isOrgAdmin = (o) => o?.role === 'owner' || o?.role === 'admin';
const ADMIN_ONLY = new Set(['server', 'ext']);

/** 설정 목록의 조직 줄 — 조직이 몇 개든 각각 한 줄. 에이전트 연결·서버 연결은 관리하는 조직이 하나라도 있을 때만 */
export function settingsOrgRows(orgs = []) {
  const any = orgs.length > 0; const admin = orgs.some(isOrgAdmin);
  return { org: any, ext: admin, server: admin, memory: any };
}

/** 설정 조직 화면 맨 위 '조직 이름 ▾' — 지금 고른 조직, 둘 이상일 때만 고르기, 관리자 전용 화면에서 관리자가 아닌 조직이면 잠금 */
export function orgScreen(view, { orgs = [], orgId = null } = {}) {
  const org = orgs.find((o) => o.id === orgId) ?? null;
  return { org, multi: orgs.length > 1, locked: !!org && ADMIN_ONLY.has(view) && !isOrgAdmin(org) };
}

/** 에이전트 넣기 요청 카드 문구(기능 점검 D6) — 에이전트·방 이름을 알면 "'효일'을 '유건, 하나' 방에 넣어 달라는 요청", 모르면 종전 문구 */
export function joinReqKey({ crew = null, room = null } = {}) {
  if (crew && room) return ['phone.agents.joinReq.named', { crew, room }];
  if (crew) return ['phone.agents.joinReq.crew', { crew }];
  return ['phone.agents.joinReq', {}];
}

/** 목록 미리보기 가리기(기능 점검 D7) — 방 안과 같이: 차단한 사람의 글은 '차단한 사용자의 메시지'(masked 'blocked'), 숨긴 에이전트의 글은 빈칸. 목록 검색도 이 글자로 찾는다 */
export function maskedPreview(row, { blocked = null, muted = null } = {}) {
  if (row?.userId && blocked?.has(row.userId)) return { text: '', masked: 'blocked' };
  if (row?.crewId && muted?.has(row.crewId)) return { text: '', masked: 'muted' };
  return { text: row?.preview ?? '', masked: null };
}

/** 기능 점검 D13 — 개인 사람 1:1인데 글이 한 번도 없으면 빈 방(목록에서 뺀다). 그룹·에이전트 1:1·조직 방은 아니다.
    lastMsg = 실시간·조회로 받은 마지막 글(있으면 첫 글이 막 온 것). */
export function emptyPersonalDm(c, lastMsg) {
  return !!c?._personal_other && !c._personal_group && !c._personal_crew && !c._personal_last_at && !lastMsg;
}

/** 그 친구와의 개인 사람 1:1(목록 행 중) — 없으면 null. 친구 줄을 누를 때 방을 만들지 않고 찾기만 한다(D13). */
export function personalDmWith(rows, userId) {
  return (rows ?? []).find((c) => c._personal_other === userId && !c._personal_group && !c._personal_crew) ?? null;
}
