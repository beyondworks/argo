// 무료 계정의 메신저 연결 에이전트(기본 4명)를 사용자가 고르는 판정(유건 2026-10-12: "4명의 에이전트는 사용자가 선택 가능하도록").
// 서버(20261011120000)는 한도를 넘는 연결에서 멈출 에이전트를 점수로 자동 선택한다 — 이 모듈은 그 자리에 사용자 선택을 끼운다:
// 미리 보기(msgr_free_swap_preview)로 자리가 필요한지 묻고, 필요하면 사용자가 멈출 에이전트를 고른 뒤 그것을 끊고(→available) 연결한다.
// 서버 변경 없음 — 관문의 기존 경로(주인의 active↔available 쓰기 허용, 사람의 연결은 선택 기록·한도 판정)를 그대로 쓴다.
export const FREE_AGENT_LIMIT = 4; // 표시용 기본값 — 실제 한도는 서버 설정(_msgr_free_agent_policy)이고, 자리 필요 여부는 미리 보기가 답한다

/** 내 플랜(5분 모듈 캐시) — 슬롯 표시(무료만)에 쓴다. 실패·지연은 null(무료 취급 — 서버가 최종 판정) */
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

/** 같은 에이전트 = 같은 회사(ws)·slug(서버의 count(distinct (ws_id, slug))과 같은 셈) */
export const slotKey = (r) => `${r.ws_id ?? ''}:${r.slug ?? ''}`;

/** 내 에이트 행들을 슬롯(에이전트) 단위로 — rows: 내 크루 행 전부(모든 공간·모든 상태, 봇 제외) */
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

/** 이 에이전트를 연결할 때 서버가 자동으로 멈출 에이전트 이름들 — []이면 자리가 있다(또는 무료 한도가 없는 계정). 옛 서버·오류는 [] */
export async function swapPreview(db, row) {
  try {
    const { data, error } = await db.rpc('msgr_free_swap_preview', { p_ws: row.ws_id, p_slugs: [row.slug] });
    return error ? [] : (data ?? []);
  } catch { return []; }
}

/** 상태 쓰기 한 곳 — 행들을 한 문장으로(RLS 0행도 오류로 본다 — 조용한 무시를 화면에 알린다) */
/** 상태 쓰기 한 곳 — 행들을 한 문장으로(RLS 0행도 오류로 본다 — 조용한 무시를 화면에 알린다) */
export async function writeStatus(db, ids, status) {
  const res = await db.from('msgr_crews').update({ status }).in('id', ids).select('id');
  if (res.error) return { ok: false, error: res.error.message };
  if ((res.data?.length ?? 0) !== ids.length) return { ok: false, error: 'row count' };
  return { ok: true };
}

/** 선택 교체 — 멈출 슬롯의 모든 행을 끊고(→available) 대상 행을 연결한다. 대상 연결이 실패하면 멈춘 행을 되돌린다(빈 자리로 남지 않게) */
export async function swapConnect(db, victim, target) {
  const v = await writeStatus(db, victim.rows.map((r) => r.id), 'available');
  if (!v.ok) return { ok: false, error: v.error, stage: 'pause' };
  const t = await writeStatus(db, [target.id], 'active');
  if (!t.ok) {
    const back = await writeStatus(db, victim.rows.map((r) => r.id), 'active').catch(() => ({ ok: false }));
    return { ok: false, error: back.ok === false ? `${t.error} · 되돌리기도 실패(${victim.name}은 멈춘 채)` : t.error, stage: 'connect' };
  }
  return { ok: true };
}

