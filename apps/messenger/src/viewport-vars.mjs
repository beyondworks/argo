// 폰 뷰포트 CSS 변수 판정(순수) — 테스트가 platform.js(빌드 시 환경 상수)를 피하도록 분리.
/** 키보드가 떠 있을 때만 변수를 낸다(null = 변수 제거 → CSS 100dvh). 짧은 가로 화면 표지는 별도. */
export function viewportVars({ keyboard, height, top = 0, width, coarse }) {
  return {
    vars: keyboard ? { '--msgr-viewport-height': `${height}px`, '--msgr-viewport-top': `${top}px` } : null,
    short: !!coarse && width > 720 && height <= 320,
  };
}
