// 설정 › 메신저 연결 — 무료 계정이 유지할 에이전트를 고르는 목록(유건 2026-10-12: 사용자 제보 "12명 중 5~8, 9~12번만 번갈아 연결된다").
// 종전 '연결 안 된 에이전트 추가'는 빠진 에이전트를 목록 순서대로 하나씩 연결했고, 무료 한도(4명)가 차 있으면 서버 관문이 연결할 때마다
// 가장 오래 고르지 않은 것을 멈췄다 → 매번 목록의 마지막 4명만 남아 앞쪽 에이전트는 영영 연결되지 않았다.
// 이제 자리가 모자라면 사람이 유지할 묶음을 고르고, 서버 함수 msgr_free_keep(20261012130000)이 한 번에 적용한다(메신저 #958과 같은 함수·같은 판정).
import { slotKey, slotState, togglePick, pickReady, FREE_AGENT_LIMIT } from '../../../../apps/messenger/src/agent-pick.mjs';

export { togglePick, pickReady, FREE_AGENT_LIMIT };

/**
 * 고르는 목록 — 내 에이전트 전체(다른 회사 포함 — 한도는 계정 전체, 연결·멈춤)와 이 회사에서 지금 연결하려는 에이전트.
 * rows: 서버 keepList 응답 행(owner_user_id·ws_id·slug·display_name·status·hosting), ws: 이 회사, wanted: 연결하려는 slug, agents: 이 회사 에이전트(이름 표시)
 * → { slots: [{ key, name, ws, active, paused, here }], picked: Set(키) } — 처음 고른 상태 = 지금 연결된 것 + 자리가 남는 만큼 연결하려는 것
 */
export function keepChoices({ rows, uid, ws, wanted = [], agents = [], limit = FREE_AGENT_LIMIT }) {
  const live = (rows ?? []).filter((r) => r && (r.status === 'active' || r.status === 'paused'));
  const { slots } = slotState(live, uid);
  const list = slots.map((s) => ({ key: s.key, name: s.name, ws: s.rows[0].ws_id, active: s.active, paused: s.paused, here: s.rows[0].ws_id === ws }));
  for (const slug of wanted) { // 지금 연결하려는 이 회사 에이전트는 행이 없어도(메신저에 올린 적 없음) 고를 수 있게 — 저장하면 서버가 그것만 멈춘 행으로 먼저 만든다
    const key = slotKey({ ws_id: ws, slug });
    const a = agents.find((x) => x.slug === slug);
    if (a && !list.some((s) => s.key === key)) list.push({ key, name: a.name || a.slug, ws, active: false, paused: false, here: true });
  }
  for (const s of list) if (s.here) s.name = agents.find((a) => slotKey({ ws_id: ws, slug: a.slug }) === s.key)?.name || s.name; // 이 회사 이름은 지금 카드의 이름으로
  const order = new Map(agents.map((a, i) => [slotKey({ ws_id: ws, slug: a.slug }), i]));
  list.sort((a, b) => (b.here - a.here) || ((order.get(a.key) ?? 1e9) - (order.get(b.key) ?? 1e9)) || a.name.localeCompare(b.name)); // 이 회사(카드 순서) 먼저, 다른 회사는 아래
  let picked = new Set(list.filter((s) => s.active).map((s) => s.key));
  for (const slug of wanted) { // 자리가 남는 만큼만 미리 고른다(넘치면 사람이 고른다). 다른 조직에서 이미 연결된 것은 이미 골라져 있다 — 두 번 누르면 풀린다(분리 검수 M2)
    const k = slotKey({ ws_id: ws, slug });
    if (!picked.has(k) && list.some((s) => s.key === k)) picked = togglePick(picked, k, limit);
  }
  return { slots: list, picked };
}

/** 저장할 때 서버에 보낼 이 회사 slug — 고른 키 가운데 이 회사 것(행이 없으면 서버가 멈춘 행으로 먼저 만든다) */
export const hereSlugs = (picked, ws) => [...picked].filter((k) => k.startsWith(`${ws}:`)).map((k) => k.slice(ws.length + 1));

/** 고른 것이 지금 연결된 묶음과 같은가(저장 단추를 끈다) */
export const sameAsActive = (picked, slots) => {
  const act = slots.filter((s) => s.active).map((s) => s.key);
  return act.length === picked.size && act.every((k) => picked.has(k));
};
