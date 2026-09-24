// 폰 뷰포트 CSS 변수 판정(순수) — 테스트가 platform.js(빌드 시 환경 상수)를 피하도록 분리.
/** 키보드가 떠 있을 때만 변수를 낸다(null = 변수 제거 → CSS 100dvh). 짧은 가로 화면 표지는 별도. */
export function viewportVars({ keyboard, height, top = 0, width, coarse }) {
  return {
    vars: keyboard ? { '--msgr-viewport-height': `${height}px`, '--msgr-viewport-top': `${top}px` } : null,
    short: !!coarse && width > 720 && height <= 320,
  };
}

/** 키보드가 뜨는 칸 — 체크박스·라디오·파일·범위·버튼·색은 초점이 가도 키보드가 없다(안드로이드는 체크박스를 눌러도 초점을 줘 탭바가 사라졌다, 재검수 #699 M1) */
export const KEYBOARD_TARGET = 'input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]):not([type=button]):not([type=submit]):not([type=color]), textarea, [contenteditable="true"]';
export const keyboardTargetFor = (el) => !!el?.closest?.(KEYBOARD_TARGET);
