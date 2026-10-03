// 폰 에이전트 탭 — 같은 에이전트를 한 줄로(유건 2026-10-02). 순수 함수만(DOM·React·supabase 없음) — 행동은 test/agent-groups.test.mjs.
// 크루 행은 공간마다 따로 있다(개인 공간 행 #779, 외부 봇의 개인 쌍둥이). 행은 그대로 두고 화면에서만 묶는다. 1:1은 개인 행 하나로 연다(agentRoomTarget).
//
// 같은 에이전트 판정 = 주인(owner_user_id) + 회사(ws_id) + slug.
//   · 본체 크루: 같은 Argo 회사(ws_id)의 같은 slug를 공간마다 파견한 행 — 서버 msgr_personal_room_crews도 개인 행의 접속 시각을
//     이 세 값이 같은 조직 행에서 빌려 온다(같은 크루로 본다).
//   · 외부 봇: 조직 봇 행(ws_id 'bot', slug 'bot-…' 무작위)과 그 개인 쌍둥이는 쌍둥이를 만들 때 slug를 그대로 복사한다(20261001140000).
//   · 셋 중 하나라도 모르면(옛 서버·조회 실패) 그 행은 id로만 — 다른 행과 잘못 합치지 않는 쪽으로 틀린다. 이름으로는 판정하지 않는다.
export const AGENT_FILTERS = ['all', 'fav', 'mine', 'ext'];

export function agentKey(c) {
  return c?.owner_user_id && c.ws_id && c.slug ? `${c.owner_user_id}|${c.ws_id}|${c.slug}` : `id:${c?.id}`;
}

/** 행 목록 → 묶음 목록(이름순). 묶음 안의 행은 개인 공간 먼저, 그 다음 orgOrder(조직 목록) 순서. 대표 이름·사진은 첫 행 */
export function groupAgents(rows, { orgOrder = [] } = {}) {
  const rank = (r) => (r.org_id == null ? -1 : (orgOrder.indexOf(r.org_id) + 1 || 1e6));
  const byKey = new Map();
  for (const r of rows ?? []) {
    if (!r?.id) continue;
    const k = agentKey(r);
    if (!byKey.has(k)) byKey.set(k, []);
    const list = byKey.get(k);
    if (!list.some((x) => x.id === r.id)) list.push(r);
  }
  return [...byKey.entries()].map(([key, list]) => {
    const rs = list.slice().sort((a, b) => rank(a) - rank(b));
    return { key, rows: rs, id: rs[0].id, display_name: rs[0].display_name, role_text: rs.find((r) => r.role_text)?.role_text ?? null, avatar_url: rs.find((r) => r.avatar_url)?.avatar_url ?? null, ext: rs.some((r) => r.hosting === 'bot') };
  }).sort((a, b) => String(a.display_name).localeCompare(String(b.display_name), 'ko'));
}

/** 지금 보고 있는 공간의 행, 없으면 첫 공간 — 설정 '내 에이전트'의 카드, 개인 행이 없는 에이전트의 1:1 */
export function rowForSpace(group, space, personalKey) {
  return group.rows.find((r) => (r.org_id ?? personalKey) === space) ?? group.rows[0];
}

// 에이전트 = 한 사람(유건 2026-10-03, P2). 내 에이전트와의 1:1은 개인 공간의 방 하나다 — 공간마다 따로 열지 않는다.
// 조직 이야기는 다음 단계의 '조직 기억 찾기'로 꺼낸다. 개인 행은 본체 0.1.92부터 모든 에이전트에 생긴다(그 전 본체는 조직 행만 — 종전대로 연다).
const isPersonalRow = (r, uid) => !!r && r.org_id == null && r.status === 'active' && !!uid && r.owner_user_id === uid;

/** 줄을 눌렀을 때 열 행 — 내 에이전트는 개인 공간 행(1:1 방 하나), 개인 행이 없거나 남의 에이전트면 rowForSpace(지금 공간, 없으면 첫 공간) */
export function agentRoomTarget(group, { uid, space, personalKey }) {
  return group.rows.find((r) => isPersonalRow(r, uid)) ?? rowForSpace(group, space, personalKey);
}

/** 조직 행 → 같은 에이전트(agentKey = 주인·회사·slug)의 내 활성 개인 공간 행, 없으면 null(종전 조직 1:1).
    남의 크루는 키의 주인이 나와 달라 맞는 행이 없고, 셋 중 하나라도 모르는 행은 키가 id라 다른 행과 맞지 않는다 —
    다른 에이전트의 방을 잘못 여는 쪽이 아니라 종전 쪽으로 틀린다. rows = 내 크루 행 목록(같은 slug만 읽어 와도 된다) */
export function personalTwinOf(crew, rows, uid) {
  if (crew?.org_id == null) return null; // 조직 행만 — 개인 행 자체·조회에서 못 찾은 행은 바꿀 것이 없다
  const key = agentKey(crew);
  return (rows ?? []).find((r) => isPersonalRow(r, uid) && agentKey(r) === key) ?? null;
}

/** 상단 메뉴별 단락. 전체 = 즐겨찾기 → 내 에이전트 → 외부 에이전트(즐겨찾기는 아래 단락에 다시 넣지 않는다). 빈 단락은 빼고 돌려준다 */
export function agentSections(groups, { filter = 'all', isFav = () => false } = {}) {
  const mine = (g) => !g.ext; const ext = (g) => g.ext;
  const out = filter === 'fav' ? [['fav', groups.filter(isFav)]]
    : filter === 'mine' ? [['mine', groups.filter(mine)]]
    : filter === 'ext' ? [['ext', groups.filter(ext)]]
    : [['fav', groups.filter(isFav)], ['mine', groups.filter((g) => mine(g) && !isFav(g))], ['ext', groups.filter((g) => ext(g) && !isFav(g))]];
  return out.map(([key, list]) => ({ key, list })).filter((s) => s.list.length);
}

// 즐겨찾기 저장 — 조직 행은 기존 에이전트 즐겨찾기(msgr_target_prefs, target_kind 'crew', 조직별 — 데스크톱 레일 '내 에이전트' 별과 같은 행).
// 개인 공간 행은 그 표에 둘 자리가 없어(org_id NOT NULL) 이 기기에만 둔다. pinned = Set('조직id:크루id'), local = Set(크루id)
export const AGENT_FAV_KEY = 'argo-msgr-agent-fav';
export function readAgentFav(store) {
  try { const v = JSON.parse(store?.getItem(AGENT_FAV_KEY) ?? '[]'); return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []); } catch { return new Set(); }
}
export function groupIsFav(group, { pinned = new Set(), local = new Set() } = {}) {
  return group.rows.some((r) => (r.org_id ? pinned.has(`${r.org_id}:${r.id}`) : local.has(r.id)));
}
/** 켜기·끄기에 필요한 쓰기 — 서버는 값이 바뀌는 조직 행만(같은 값 다시 쓰기 0), 개인 행은 다음 기기 목록 */
export function favChanges(group, on, { pinned = new Set(), local = new Set() } = {}) {
  const server = group.rows.filter((r) => r.org_id && pinned.has(`${r.org_id}:${r.id}`) !== on).map((r) => ({ org_id: r.org_id, target_kind: 'crew', target_id: r.id, pinned: on }));
  const next = new Set(local);
  for (const r of group.rows) if (!r.org_id) { if (on) next.add(r.id); else next.delete(r.id); }
  return { server, local: next };
}
