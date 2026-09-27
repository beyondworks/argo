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

/** 3차 검수 M-2(2026-09-27) — 실제 소프트 키보드가 떴다고 볼 조건. 키보드가 뜨는 칸에 초점이 있는 것만으로는
 * 부족하다(맥·윈도우 작은 창 로그인 화면에서 입력칸을 누르면 몸통이 fixed로 잠겨 스크롤을 못 하던 결함).
 * 터치 기기면 그대로 믿고(코스 포인터엔 늘 소프트 키보드), 그 외에는 visualViewport 높이가 창 높이보다
 * 뚜렷이(20% 이상) 줄었을 때만 — 브라우저 크롬의 미세한 높이 변화가 아니라 키보드 규모의 축소만 잡는다. */
export function keyboardLikelyOpen({ target, height, innerHeight, coarse }) {
  if (!target) return false;
  if (coarse) return true;
  return innerHeight > 0 && height < innerHeight * 0.8;
}
