// 폰 폭 사이드바 서랍의 키보드 규칙 — JSX 없는 순수 함수(UL9, 2026-10-05). layout.jsx가 서랍이 열려 있는 동안 keydown을 이 판정에 넘긴다.
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 키 하나에 서랍이 할 일 — 'close' | null. Esc만, 열려 있을 때만. IME 조합 중 Esc(한글 입력 취소)와 입력창·모달이 이미 쓴 Esc(defaultPrevented)는 건드리지 않는다. */
export function drawerKeyAction({ key, open, composing = false, defaultPrevented = false } = {}) {
  return open && key === 'Escape' && !composing && !defaultPrevented ? 'close' : null;
}

/** 서랍을 열 때 포커스를 보낼 곳 — 서랍 안 첫 조작 요소, 없으면 서랍 자체(tabIndex -1). 서랍 뒤 본문에 포커스가 남지 않게. */
export function drawerFocusTarget(container) {
  return container?.querySelector?.(FOCUSABLE) ?? container ?? null;
}
