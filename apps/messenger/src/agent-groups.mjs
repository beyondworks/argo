// 폰 에이전트 탭 — 같은 에이전트를 한 줄로(유건 2026-10-02). 순수 함수만(DOM·React·supabase 없음) — 행동은 test/agent-groups.test.mjs.
// 크루 행은 공간마다 따로 있다(개인 공간 행 #779, 외부 봇의 개인 쌍둥이). 권한·기억은 행마다 그대로 두고, 화면에서만 묶는다.
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

/** 줄을 눌렀을 때 열 행 — 지금 보고 있는 공간의 행, 없으면 첫 공간 */
export function rowForSpace(group, space, personalKey) {
  return group.rows.find((r) => (r.org_id ?? personalKey) === space) ?? group.rows[0];
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
