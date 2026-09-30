// 테마 — linen(기본, 메신저 기본값)·graphite에 레퍼런스 화면을 옮긴 cream·sand·peach·mist·glow까지 일곱 가족.
// 가족마다 시스템 자동(이름만)·라이트 고정(-light)·다크 고정(-dark) 세 가지. 새 다섯 가족의 토큰·모양은 themes.css.
// 첫 페인트 전 적용은 index.html 인라인 스크립트가 하고, 여기서는 바꿀 때와 시스템 변경만 처리한다.
export const FAMILIES = ['linen', 'graphite', 'cream', 'sand', 'peach', 'mist', 'glow'];
export const THEMES = FAMILIES.flatMap((f) => [f, `${f}-light`, `${f}-dark`]);
// 시스템 자동의 다크를 .dark-emul 클래스로 입히는 가족(graphite만 tokens.css의 @media로 처리한다).
export const EMUL = FAMILIES.filter((f) => f !== 'graphite');
const KEY = 'argo-office-theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function readTheme() {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'linen'; } catch { return 'linen'; }
}

export function applyTheme(theme) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  // 시스템 자동(이름만 있는 테마)의 다크는 토큰 파일이 .dark-emul 클래스로 정의한다(메신저와 같은 방식).
  el.classList.toggle('dark-emul', EMUL.includes(theme) && !!mq?.matches);
  try { localStorage.setItem(KEY, theme); } catch { /* 사생활 보호 모드 — 이번 세션만 */ }
}

mq?.addEventListener('change', () => applyTheme(readTheme()));
