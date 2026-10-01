// 업무 탭 순서·숨김(사람마다, biztabs:me — 유건 9/30). 좌측 메뉴(core/nav-model.js)와 같은 모양으로 저장한다: [{ id }, { id, hidden: true }].
// 켜기·끄기는 조직 설정(settings.enabled), 순서·숨김은 내 보기. 이 파일은 업무 화면에만 실린다(첫 화면 JS 상한).
import { moveId } from '../core/nav-model.js';

/** 저장값(saved) → 전체 순서(order, 꺼진 탭 포함 — 다시 켜도 내 자리·숨김이 남게), 켜진 탭 중 보이는 탭(shown)·숨긴 탭(hidden) */
export function readTabs(modules, enabled, saved) {
  const list = Array.isArray(saved) ? saved.filter((x) => x && typeof x.id === 'string') : [];
  const order = [...new Set([...list.map((x) => x.id).filter((id) => modules.includes(id)), ...modules])];
  const hiddenAll = new Set(list.filter((x) => x.hidden && modules.includes(x.id)).map((x) => x.id));
  const on = order.filter((id) => enabled.includes(id));
  // 켜진 탭이 전부 숨긴 탭이면(조직이 남은 탭을 끈 경우) 첫 탭은 보인다 — 탭 줄이 비지 않게. 저장값은 그대로 둔다
  const keep = on.length && on.every((id) => hiddenAll.has(id)) ? on[0] : null;
  return { order, hiddenAll, shown: on.filter((id) => !hiddenAll.has(id) || id === keep), hidden: on.filter((id) => hiddenAll.has(id) && id !== keep) };
}

/** 마지막 남은 탭은 숨길 수 없다 */
export const canHide = (state, id) => state.shown.includes(id) && state.shown.length > 1;

/** 바꾼 뒤 저장할 items — op: { move: [a, b] } | { hide: id } | { show: id }. 숨길 수 없으면 null */
export function writeTabs(state, op) {
  const hidden = new Set(state.hiddenAll);
  if (op.hide) { if (!canHide(state, op.hide)) return null; hidden.add(op.hide); }
  if (op.show) hidden.delete(op.show);
  const order = op.move ? moveId(state.order, ...op.move) : state.order;
  return order.map((id) => (hidden.has(id) ? { id, hidden: true } : { id }));
}

/** 보여 줄 탭 — 요청한 탭이 켜져 있으면 숨긴 탭이어도 그대로(주소·홈 카드 링크가 깨지지 않게), 꺼졌거나 모르는 탭이면 분석 → 보이는 첫 탭 */
export function pickTab(state, tab) {
  if (state.shown.includes(tab) || state.hidden.includes(tab)) return tab;
  return state.shown.includes('analytics') ? 'analytics' : state.shown[0] ?? 'analytics';
}

/** 탭 줄 — 보이는 탭 + 지금 보고 있는 숨긴 탭(제자리에 '숨긴 탭'으로 표시) */
export const tabBar = (state, current) => state.order.filter((id) => state.shown.includes(id) || (id === current && state.hidden.includes(id)));

/** 지금 보고 있는 탭을 숨기면 옮겨 갈 탭 — 남은 첫 탭. 다른 탭을 숨기면 null(그대로) */
export const afterHide = (state, id, current) => (id === current ? state.shown.find((x) => x !== id) ?? null : null);
