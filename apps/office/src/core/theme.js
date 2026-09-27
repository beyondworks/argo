// 테마 — linen(기본, 메신저 기본값)과 graphite 두 가족만. 각각 시스템 자동·라이트 고정·다크 고정.
// 첫 페인트 전 적용은 index.html 인라인 스크립트가 하고, 여기서는 바꿀 때와 시스템 변경만 처리한다.
export const THEMES = ['linen', 'linen-light', 'linen-dark', 'graphite', 'graphite-light', 'graphite-dark'];
const KEY = 'argo-office-theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

export function readTheme() {
  try { const v = localStorage.getItem(KEY); return THEMES.includes(v) ? v : 'linen'; } catch { return 'linen'; }
}

export function applyTheme(theme) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  // linen 시스템 자동의 다크는 토큰 파일이 .dark-emul 클래스로 정의한다(메신저와 같은 방식).
  el.classList.toggle('dark-emul', theme === 'linen' && !!mq?.matches);
  try { localStorage.setItem(KEY, theme); } catch { /* 사생활 보호 모드 — 이번 세션만 */ }
}

mq?.addEventListener('change', () => applyTheme(readTheme()));
