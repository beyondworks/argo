// 폰 키보드 내리기(유건 실기기 2026-10-04: "키보드 내리려면 어떻게 해야돼") — iOS 폼 보조 막대(↑↓✓)를 숨긴 뒤 아이폰에는 키보드를 내릴 키가 없다.
// 카카오톡·아이메시지처럼 입력 중에 대화 목록을 위아래로 끌거나 짧게 누르면 입력칸 초점을 풀어 키보드를 내린다.
// 링크·버튼·입력칸을 누른 것, 길게 누르기(메뉴), 옆으로 미는 동작(뒤로 가기)은 건드리지 않는다.
export const DRAG_PX = 10;
export const LONG_PRESS_MS = 500;
const INTERACTIVE = 'a, button, input, textarea, select, label, [contenteditable=""], [contenteditable="true"], [role="button"], [role="menuitem"], [role="link"]';
const NOT_TEXT = new Set(['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color', 'image', 'hidden']);
const typingIn = (el) => !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !NOT_TEXT.has(String(el.type || 'text').toLowerCase())) || el.isContentEditable === true);

/** 대화 목록 el에 붙인다. 반환 = 떼기. doc·now는 테스트 주입. */
export function attachKeyboardDismiss(el, { doc = globalThis.document, now = () => Date.now() } = {}) {
  let start = null;
  const dismiss = () => { const a = doc?.activeElement; if (typingIn(a)) a.blur(); };
  const onStart = (e) => { const t = e.touches?.[0]; start = t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, at: now(), moved: false } : null; };
  const onMove = (e) => {
    const t = e.touches?.[0]; if (!start || start.moved || !t) return;
    const dy = Math.abs(t.clientY - start.y), dx = Math.abs(t.clientX - start.x);
    if (dy > DRAG_PX && dy >= dx) { start.moved = true; dismiss(); } else if (dx > DRAG_PX) start.moved = true; // 옆으로 밀기는 내리지 않는다
  };
  const onEnd = (e) => {
    const s = start; start = null;
    if (!s || s.moved || now() - s.at > LONG_PRESS_MS) return;
    if (e.target?.closest?.(INTERACTIVE)) return;
    dismiss();
  };
  const onCancel = () => { start = null; };
  const opts = { passive: true };
  el.addEventListener('touchstart', onStart, opts); el.addEventListener('touchmove', onMove, opts);
  el.addEventListener('touchend', onEnd, opts); el.addEventListener('touchcancel', onCancel, opts);
  return () => {
    el.removeEventListener('touchstart', onStart, opts); el.removeEventListener('touchmove', onMove, opts);
    el.removeEventListener('touchend', onEnd, opts); el.removeEventListener('touchcancel', onCancel, opts);
  };
}
