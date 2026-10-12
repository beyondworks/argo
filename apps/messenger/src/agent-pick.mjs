// 무료 계정의 메신저 연결 에이전트(기본 4명)를 사용자가 고르는 판정(유건 2026-10-12: "유지할 4명의 에이전트를 선택해주세요", "4명 한도 내에서는 무제한으로 변경").
// 서버(20261011120000)는 한도를 넘는 연결에서 멈출 에이전트를 점수로 고른다 — 이 모듈은 그 자리에 사용자 선택을 끼운다:
// 미리 보기(msgr_free_swap_preview)로 자리가 필요한지 묻고, 필요하면 유지할 에이전트를 고르게 한 뒤 서버 함수 msgr_free_keep(20261012130000)이
// 한 번에 적용한다 — 고르지 않은 것은 멈춤(채널 참여·기억 보존), 고른 멈춘 것은 재개. 앱은 상태를 직접 쓰지 않는다(파견 해제는 조직 기억을 지운다).
export const FREE_AGENT_LIMIT = 4; // 표시용 기본값 — 실제 한도는 서버 설정(_msgr_free_agent_policy)이고, 자리 필요 여부는 미리 보기가 답한다

/** 내 플랜(5분 모듈 캐시) — 선택 목록(무료만)에 쓴다. 실패·지연은 null(무료 취급 — 서버가 최종 판정) */
let planCache = null;
export async function readMyPlan(db, now = Date.now()) {
  if (planCache && now - planCache.at <= 300_000) return planCache.plan;
  try {
    const { data, error } = await db.rpc('my_plan');
    if (error) return planCache?.plan ?? null;
    const p = data?.plan;
    if (p === 'pro' || p === 'trial' || p === 'free') planCache = { at: now, plan: p }; // 모르는 값은 이전 값을 유지한다
  } catch { /* 조회 실패는 이전 값 */ }
  return planCache?.plan ?? null;
}

/** 같은 에이전트 = 같은 회사(ws)·slug(서버의 count(distinct (ws_id, slug))과 같은 셈, msgr_free_keep의 '회사:이름' 키) */
export const slotKey = (r) => `${r.ws_id ?? ''}:${r.slug ?? ''}`;

/** 내 에이전트 행들을 슬롯(에이전트) 단위로 — rows: 내 크루 행(봇 제외). active = 연결됨, paused = 멈춤만(연결된 행 없음) */
export function slotState(rows, uid) {
  const bySlot = new Map();
  for (const r of rows ?? []) {
    if (!r || r.owner_user_id !== uid || r.hosting === 'bot') continue;
    const k = slotKey(r);
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(r);
  }
  const slots = [...bySlot.values()].map((list) => ({
    key: slotKey(list[0]),
    name: list[0].display_name,
    rows: list,
    active: list.some((r) => r.status === 'active'),
    paused: !list.some((r) => r.status === 'active') && list.some((r) => r.status === 'paused'),
  }));
  return { slots, used: slots.filter((s) => s.active).length };
}

/** 고르는 목록 — 연결·멈춤 에이전트(파견 해제만 있는 에이전트는 빼고) + 지금 연결하려는 에이전트(파견 해제 행이면 함께 연결할 행으로) */
export function keepChoices(rows, uid, target = null) {
  const { slots } = slotState(rows, uid);
  const list = slots.filter((s) => s.active || s.paused);
  let activate = [];
  if (target) {
    const k = slotKey(target);
    if (!list.some((s) => s.key === k)) list.push({ key: k, name: target.display_name, rows: [target], active: false, paused: false });
    if (target.status === 'available') activate = [target.id];
  }
  return { slots: list, activate, picked: new Set([...list.filter((s) => s.active).map((s) => s.key), ...(target ? [slotKey(target)] : [])]) };
}

/** 고를 때 한 칸 누르기 — 한도까지만 더한다(넘으면 그대로) */
export function togglePick(picked, key, limit = FREE_AGENT_LIMIT) {
  const next = new Set(picked);
  if (next.has(key)) next.delete(key); else if (next.size < limit) next.add(key);
  return next;
}

/** 저장할 수 있나 — 고를 수 있는 만큼(한도와 목록 수 중 작은 쪽)을 정확히 골랐을 때 */
export const pickReady = (picked, slots, limit = FREE_AGENT_LIMIT) => picked.size > 0 && picked.size === Math.min(limit, slots.length);

/** 이 에이전트를 연결할 때 서버가 자동으로 멈출 에이전트 이름들 — []이면 자리가 있다(또는 무료 한도가 없는 계정). 옛 서버·오류는 [] */
export async function swapPreview(db, row) {
  try {
    const { data, error } = await db.rpc('msgr_free_swap_preview', { p_ws: row.ws_id, p_slugs: [row.slug] });
    return error ? [] : (data ?? []);
  } catch { return []; }
}

/** 유지할 에이전트 적용 — 서버 함수 한 번(msgr_free_keep). activate = 고른 것 중 함께 연결할 파견 해제 행 */
export async function keepAgents(db, keys, activate = []) {
  try {
    const { data, error } = await db.rpc('msgr_free_keep', { p_keep: [...keys], p_activate: activate.filter(Boolean) });
    return error ? { ok: false, error: error.message } : { ok: true, data };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}
