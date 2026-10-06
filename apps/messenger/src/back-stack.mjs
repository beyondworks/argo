// Android 하드웨어 뒤로(2026-10-05 분리 검증 MSG-10) — 시트·팝업은 화면(page)을 바꾸지 않는 상태 값으로 열려 history에 없다.
// 그래서 뒤로가 시트를 닫지 않고 아래 화면을 닫거나(대화 안), 맨 아래 탭에서는 앱을 바로 꺼 입력하던 내용(그룹 이름·검색어)이 사라졌다.
// 열린 시트·팝업이 자기 닫기를 이 목록에 올리고(use-back-close.js), 뒤로는 맨 위 것부터 닫는다. history 스택은 건드리지 않는다(화면 뒤로 규칙 그대로).
export function createBackStack() {
  const stack = [];
  return {
    push(close) { const e = { close }; stack.push(e); return () => { const i = stack.indexOf(e); if (i >= 0) stack.splice(i, 1); }; },
    closeTop() { const e = stack.pop(); if (!e) return false; try { e.close(); } catch { /* 닫기 실패가 뒤로를 막지 않게 */ } return true; },
    size: () => stack.length,
  };
}
export const appBackStack = createBackStack(); // 앱 하나에 하나

export const BACK_EXIT_MS = 2000;
/** 맨 아래 화면(깊이 0)에서 뒤로 → 'home'(다른 탭이면 홈 탭으로) | 'warn'(한 번 더 누르면 닫는다고 안내) | 'exit'(안내 뒤 2초 안에 또 누름) */
export function rootBackAction({ page, home, lastAt = 0, now = Date.now(), windowMs = BACK_EXIT_MS }) {
  if (page !== home) return 'home';
  return lastAt && now - lastAt <= windowMs ? 'exit' : 'warn';
}
