// 메신저 단순화 2단계(파일 one-list.mjs) — 공간 전환 없는 한 목록(설계 2026-10-22-1500-msgr-simple-structure-design.md, 유건 승인 15:3x KST).
// 서버 msgr2_inbox(20261022160000)를 한 번 불러 내 방 전부를 받고, 거르개(전체·안 읽음·에이전트·조직)는 여기서 한다(요청 0).
// 새 글은 방송으로 그 행만 고친다(oneListBump) — 주기 조회 없음. 모르는 방의 글·방 사건이면 부르는 쪽이 한 번 다시 읽는다.
export const ONE_LIST_LIMIT = 200;
export const ONE_LIST_FILTERS = ['all', 'unread', 'agents'];

/** 목록 한 쪽 읽기. 반환 { rows, more, error } — error.pro = 무료·Pro 만료(msgr2_pro_required → FreeGate) */
export async function loadOneList(client, { limit = ONE_LIST_LIMIT } = {}) {
  const r = await client.rpc('msgr2_inbox', { p_limit: limit });
  if (r?.error) {
    const msg = String(r.error.message ?? '');
    return { rows: null, more: false, error: { pro: /msgr2_pro_required/.test(msg), message: msg } };
  }
  const rows = Array.isArray(r?.data) ? r.data : [];
  return { rows, more: rows.length >= limit, error: null };
}

/** 방이 사는 공간(셸의 공간 키) — 개인 종류는 어느 개인 공간이든 하나(personalKey), 팀은 그 공간 id */
export const oneListSpace = (row, personalKey) => (row?.space_kind === 'team' ? row.space_id : personalKey);

/** 조직 칩 재료 — 목록에 나온 조직(팀 공간)만, 이름순, 같은 id는 한 번 */
export function oneListOrgs(rows) {
  const m = new Map();
  for (const r of rows ?? []) if (r?.space_kind === 'team' && !m.has(r.space_id)) m.set(r.space_id, { id: r.space_id, name: r.space_name || '' });
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko') || a.id.localeCompare(b.id));
}

/** 거르개. filter: all | unread(음소거 제외 안 읽음) | agents(에이전트와의 대화), org: 조직 id(그 조직 방만) 또는 null
    agents = 에이전트 1:1(peer_kind agent) 또는 사람은 나뿐이고 에이전트가 있는 방(내 에이전트 회의방·팀 공간 에이전트 1:1).
    사람이 둘 이상인 방은 에이전트가 들어 있어도 빼낸다 — 에이전트가 파견된 팀 채널·사람 방이 다 나와 칩이 '전체'와 다르지 않았다(유건 사용 검수 2026-10-23). */
export function oneListView(rows, { filter = 'all', org = null, q = '', hit = null } = {}) { // hit(row): 서버 본문 찾기에서 맞은 방(검수 D3 — 폰 검색이 방 이름만 걸렀다)
  const needle = String(q ?? '').trim().toLowerCase();
  return (rows ?? []).filter((r) => (!org || (r.space_kind === 'team' && r.space_id === org))
    && (filter !== 'unread' || (r.unread > 0 && !r.muted))
    && (filter !== 'agents' || r.peer_kind === 'agent' || (r.agents > 0 && (r.users ?? 0) <= 1))
    && (!needle || String(r._title ?? r.room_name ?? '').toLowerCase().includes(needle) || String(r.space_name ?? '').toLowerCase().includes(needle) || !!hit?.(r)));
}

/** 서버 본문 찾기(msgr2_search) 결과 → 맞은 방 id 집합. 한 목록은 공간을 섞으므로 공간으로 거르지 않는다(옛 msgr_tab_search 번역은 지금 공간의 방만 남겼다). */
export const oneListSearchHits = (data) => new Set([...(data?.messages ?? []).map((m) => m.room_id), ...(data?.rooms ?? []).map((x) => x.id)].filter(Boolean));

/** 안 읽음 합계(음소거 제외) — 폰 '대화' 탭 숫자 */
/** 폰 칩 줄의 실제 거르기(검수 D2, 2026-10-25) — 폰은 칩(전체·안읽음·에이전트)과 조직 고르기가 한 줄이고 강조는 하나만 보인다(조직을 고르면 칩 강조가 꺼진다).
    그래서 조직이 골라져 있으면 칩 조건은 '전체'로 본다 — 종전엔 '에이전트' 칩 조건이 숨은 채 남아 팀 방이 다 빠졌다. 데스크톱은 칩 강조가 남아 둘 다 건다. */
export const oneListChipFilter = ({ filter = 'all', org = null, phone = false } = {}) => (phone && org ? 'all' : filter);
export const oneListUnread = (rows) => (rows ?? []).reduce((n, r) => n + (r.muted ? 0 : (r.unread || 0)), 0);

/** 방송으로 온 새 글 한 개를 목록에 반영. 반환 { rows, known } — known=false면 모르는 방(부르는 쪽이 다시 읽는다).
    msg: v2 글 행(room_id·id·created_at·kind·author_kind·author_user_id·author_agent_id·body). 내 글·보고 있는 방은 안 읽음을 올리지 않는다. */
export function oneListBump(rows, msg, { uid = null, active = null } = {}) {
  if (!rows || !msg?.room_id) return { rows, known: false };
  const i = rows.findIndex((r) => r.room_id === msg.room_id);
  if (i < 0) return { rows, known: false };
  const cur = rows[i];
  if (cur.last_id != null && Number(msg.id) <= Number(cur.last_id)) return { rows, known: true }; // 이미 반영(따라잡기 중복)
  const mine = msg.author_user_id && msg.author_user_id === uid;
  const counts = msg.kind !== 'system' && !mine && msg.room_id !== active;
  const next = { ...cur, last_id: Number(msg.id), last_at: msg.created_at ?? new Date().toISOString(), last_kind: msg.kind ?? 'text', last_author_kind: msg.author_kind ?? null,
    last_author_id: msg.author_user_id ?? msg.author_agent_id ?? null, last_preview: msg.kind === 'system' ? null : String(msg.body ?? '').slice(0, 140),
    unread: counts ? Math.min(99, (cur.unread || 0) + 1) : cur.unread };
  const rest = rows.filter((_, k) => k !== i);
  return { rows: oneListSort([next, ...rest]), known: true };
}

/** 고정한 방끼리의 순서(끌기·위로/아래로 — pinPos: Map id→순번). 순번 없는 고정 방은 뒤에, 같으면 서버 순서 그대로. 고정 안 한 방은 그대로 */
export function oneListPinOrder(rows, pinPos) {
  if (!rows) return rows;
  const pin = rows.filter((r) => r.pinned); const rest = rows.filter((r) => !r.pinned);
  const rank = (r) => pinPos?.get?.(r.room_id) ?? 1e9;
  return [...pin.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r), ...rest];
}

/** 방을 열면 그 방 안 읽음 0(서버 읽음 표시는 방 화면이 한다) */
export const oneListSeen = (rows, roomId) => (rows ?? []).map((r) => (r.room_id === roomId && r.unread ? { ...r, unread: 0 } : r));

/** 서버와 같은 순서: 고정 먼저, 마지막 활동 최신, 같으면 방 id 역순 */
export function oneListSort(rows) {
  return [...(rows ?? [])].sort((a, b) => (Number(!!b.pinned) - Number(!!a.pinned)) || ((Date.parse(b.last_at) || 0) - (Date.parse(a.last_at) || 0)) || String(b.room_id).localeCompare(String(a.room_id)));
}

const roomLabel = (row) => String(row?.room_name ?? '').replace(/^dm:/, '').trim();
/** 1:1로 보일 줄인가 — direct 방, 또는 이름 없는 방에 상대가 하나(서버 peer: 에이전트 1:1은 이름 없는 private 방, 20261020200600).
    이름 붙은 방(팀 비공개 채널 등)은 나 말고 한 명뿐이어도 방 이름으로 보인다 */
export const oneListPair = (row) => !!row?.peer_id && (row.room_kind === 'direct' || !roomLabel(row));
/** 줄에 보일 이름 — 1:1은 상대 이름(names(kind, id)), 여러 명 방·채널은 방 이름(dm: 머리말 뺌), 없으면 null(부르는 쪽 기본 문구) */
export function oneListTitle(row, names) {
  if (oneListPair(row)) return names(row.peer_kind, row.peer_id) || null;
  return roomLabel(row) || null;
}

/** 데스크톱 레일 '에이전트' 구역의 묶음 — [id, 이름 키, 목록], 빈 묶음은 뺀다. 내 에이전트(Argo)·외부 둘이다.
 *  '회사' 묶음은 없다: v2 서버에 회사 에이전트가 없다(msgr2_spaces에 service_user_id 없음, msgr2_agents.hosting은 local·bot만). 서버에 생기면 범위 조직 기준 1회 읽기로 다시 붙인다(#1143 미룸) */
export function oneListAgentFolds(mine, sourceOf) {
  const argo = (mine ?? []).filter((c) => sourceOf(c) === 'argo');
  const ext = (mine ?? []).filter((c) => sourceOf(c) !== 'argo');
  return [['mine.argo', 'rail.agents.mine', argo], ['mine.ext', 'rail.src.custom', ext]].filter(([, , list]) => list.length > 0);
}
