// 기억 페이지 창(pane)·탭 상태 전이 — 순수 함수(행동 테스트가 직접 임포트, test/msgr-panes.test.mjs).
// 아르고 기억 페이지의 openTab/closeTab 계약과 같은 모양. 상태는 { panes: [{ id, tabs, active }], focus } 하나로 다뤄
// React 업데이터 안에서 다른 setState를 부르지 않는다(검수 LOW: 비순수 업데이터).
export const GRAPH_TAB = { id: 'graph', kind: 'graph' };
export const MAX_PANES = 2;
const clone = (panes) => panes.map((p) => ({ ...p, tabs: [...p.tabs] }));
/** 빈 창 정리 — 둘째 창이면 없애고 포커스를 남은 창으로, 마지막 창이면 그래프 탭으로. 활성 탭이 사라졌으면 후보→마지막 탭. */
function settle(next, paneId, focus, activeAfter) {
  const pane = next.find((p) => p.id === paneId);
  if (!pane.tabs.length) {
    if (next.length > 1) { const rest = next.filter((p) => p.id !== paneId); return { panes: rest, focus: rest[0].id }; }
    pane.tabs.push(GRAPH_TAB);
  }
  if (!pane.tabs.some((x) => x.id === pane.active)) pane.active = activeAfter && pane.tabs.some((x) => x.id === activeAfter) ? activeAfter : pane.tabs[pane.tabs.length - 1].id;
  return { panes: next, focus };
}
/** 탭 열기/활성화 — split이면 옆 창에(없으면 만들고, 상한이면 포커스 창에). 같은 탭이 있으면 활성화만. */
export function openTab(panes, focus, tab, { split = false } = {}) {
  let target = panes.find((p) => p.id === focus) ?? panes[0];
  const next = clone(panes); let nf = focus;
  if (split) {
    const other = next.find((p) => p.id !== target.id);
    if (other) target = other;
    else if (next.length < MAX_PANES) { const np = { id: Math.max(...next.map((p) => p.id)) + 1, tabs: [], active: null }; next.push(np); target = np; }
    nf = target.id;
  }
  const pane = next.find((p) => p.id === target.id);
  if (!pane.tabs.some((x) => x.id === tab.id)) pane.tabs.push(tab);
  pane.active = tab.id;
  return { panes: next, focus: nf };
}
export function closeTab(panes, focus, paneId, tabId) {
  const next = clone(panes); const pane = next.find((p) => p.id === paneId); if (!pane) return { panes, focus };
  const i = pane.tabs.findIndex((x) => x.id === tabId); if (i < 0) return { panes, focus };
  const wasActive = pane.active === tabId;
  pane.tabs.splice(i, 1);
  return settle(next, paneId, focus, wasActive ? pane.tabs[Math.min(i, pane.tabs.length - 1)]?.id : pane.active);
}
export function keepTabs(panes, focus, paneId, pred, activeAfter) {
  const next = clone(panes); const pane = next.find((p) => p.id === paneId); if (!pane) return { panes, focus };
  pane.tabs = pane.tabs.filter(pred);
  return settle(next, paneId, focus, activeAfter);
}
export const closeOthers = (panes, focus, paneId, id) => keepTabs(panes, focus, paneId, (x) => x.id === id, id);
export const closeAll = (panes, focus, paneId) => keepTabs(panes, focus, paneId, () => false);
export function closeRight(panes, focus, paneId, id) {
  const next = clone(panes); const pane = next.find((p) => p.id === paneId); if (!pane) return { panes, focus };
  const k = pane.tabs.findIndex((x) => x.id === id); if (k < 0) return { panes, focus };
  pane.tabs = pane.tabs.slice(0, k + 1);
  return settle(next, paneId, focus, id);
}
export const setActive = (panes, focus, paneId, tabId) => ({ panes: panes.map((p) => p.id === paneId ? { ...p, active: tabId } : p), focus });
