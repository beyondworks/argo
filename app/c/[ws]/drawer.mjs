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

/** Tab 순환(2차 L4) — 서랍이 열려 있는 동안 포커스가 서랍 안에서만 돈다. 반환 'first' | 'last' | null(브라우저 기본 동작).
    마지막에서 Tab → 첫째, 첫째(또는 서랍 자체)에서 Shift+Tab → 마지막, 서랍 밖(배경막 뒤 상단바)에 있으면 안으로. */
export function drawerTabAction({ key, open, shiftKey = false, active, first, last, container } = {}) {
  if (!open || key !== 'Tab' || !first || !last) return null;
  const inside = !!active && (container?.contains?.(active) ?? false);
  if (!inside) return shiftKey ? 'last' : 'first';
  if (shiftKey) return active === first || active === container ? 'last' : null;
  return active === last ? 'first' : (active === container ? 'first' : null);
}

/** 서랍 접근성 속성 — 폰 폭에서 열렸을 때만 role="dialog" aria-modal. 데스크톱의 고정 사이드바는 대화상자가 아니므로 속성을 달지 않는다(영향 0). */
export function drawerAttrs({ open, phone, label }) {
  return open && phone ? { role: 'dialog', 'aria-modal': 'true', 'aria-label': label } : {};
}

/** 서랍 안 조작 요소 목록의 처음·끝 — 포커스를 가둘 때 쓴다. */
export function drawerEnds(container) {
  const list = [...(container?.querySelectorAll?.(FOCUSABLE) ?? [])].filter((el) => !el.disabled && el.offsetParent !== null);
  return { first: list[0] ?? null, last: list[list.length - 1] ?? null };
}
