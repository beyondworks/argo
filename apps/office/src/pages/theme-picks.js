// 설정 화면의 색상 견본·묶음(유건 10/1 "색 원 13개가 깔끔하게") — 설정 화면과 함께 지연 로드된다. 묶음 이름은 custom-i18n.js의 colorgroup.*.
// 견본 = [바탕, 사이드바, 강조] 라이트 값(정본은 tokens.css·themes.css). 표시용이라 다크 값은 두지 않는다.
export const SWATCH = {
  linen: ['#e9e6df', '#1f1e1b', '#e8e400'], graphite: ['#f2f2f2', '#ebebeb', '#1a1a1a'], cream: ['#fbf3e5', '#111111', '#f4b8dc'],
  sand: ['#e2dac7', '#f1f0ee', '#c62d26'], peach: ['#ede0d7', '#ffffff', '#f97723'], mist: ['#d0d1cc', '#f2f2ef', '#6f4fd6'],
  glow: ['linear-gradient(135deg, #f2c3b1, #f2e5b0)', '#fff9f1', '#c8a4ee'],
  sage: ['#e9eee6', '#dde5d9', '#3f7a59'], ocean: ['#e9eef4', '#dce4ee', '#2a6fdb'], rose: ['#f5ecec', '#ecdfe0', '#c25a7c'],
  lavender: ['#efedf8', '#e3dff2', '#6a52cc'], slate: ['#e9ecf0', '#dde2e8', '#4f7396'], ember: ['#f6f0eb', '#211a15', '#ea580c'],
};
// 중성 · 따뜻함 · 차가움 — 모든 가족이 한 번씩(test/themes.test.mjs가 잠근다)
export const COLOR_GROUPS = [
  ['neutral', ['linen', 'graphite', 'sand', 'mist']],
  ['warm', ['cream', 'peach', 'glow', 'rose', 'ember']],
  ['cool', ['sage', 'ocean', 'lavender', 'slate']],
];
