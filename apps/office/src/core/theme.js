// 테마 = 앱 셸(data-shell) × 색상(data-theme). 유건 9/30: "테마는 앱쉘 선택 + 컬러 선택으로".
// 색상: linen(기본, 메신저 기본값)·graphite·cream·sand·peach·mist·glow — 가족마다 시스템 자동(이름만)·라이트 고정(-light)·다크 고정(-dark).
// 셸: plain(기본)·float·window·panel·pill·glass — 모양은 themes.css. 둘은 자유롭게 섞인다.
// 첫 페인트 전 적용은 index.html 인라인 스크립트가 하고, 여기서는 바꿀 때와 시스템 변경만 처리한다.
export const FAMILIES = ['linen', 'graphite', 'cream', 'sand', 'peach', 'mist', 'glow'];
export const MODES = ['', '-light', '-dark']; // 시스템 · 라이트 · 다크
export const THEMES = FAMILIES.flatMap((f) => MODES.map((m) => f + m));
// 시스템 자동의 다크를 .dark-emul 클래스로 입히는 가족(graphite만 tokens.css의 @media로 처리한다).
export const EMUL = FAMILIES.filter((f) => f !== 'graphite');
export const SHELLS = ['plain', 'float', 'window', 'panel', 'pill', 'glass'];
// 셸이 따로 없던 때(색마다 모양이 붙어 있던 9/30 이전)에 고른 테마는 그때 모양을 그대로 받는다
export const SHELL_OF = { linen: 'plain', graphite: 'plain', cream: 'float', sand: 'window', peach: 'panel', mist: 'pill', glow: 'glass' };
const KEY = 'argo-office-theme', SHELL_KEY = 'argo-office-shell';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 사생활 보호 모드 — 이번 세션만 */ } };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

export const familyOf = (theme) => theme.replace(/-(light|dark)$/, '');
export const modeOf = (theme) => theme.slice(familyOf(theme).length);

export function readTheme() { const v = load(KEY); return THEMES.includes(v) ? v : 'linen'; }
export function readShell() { const v = load(SHELL_KEY); return SHELLS.includes(v) ? v : SHELL_OF[familyOf(readTheme())]; }

export function applyTheme(theme) {
  const el = document.documentElement;
  el.dataset.theme = theme;
  // 시스템 자동(이름만 있는 테마)의 다크는 토큰 파일이 .dark-emul 클래스로 정의한다(메신저와 같은 방식).
  el.classList.toggle('dark-emul', EMUL.includes(theme) && !!mq?.matches);
  save(KEY, theme);
  globalThis.__argoCustom?.(); // 커스텀 테마는 모드마다 값이 다르다
}

/** 셸을 입히고 저장한다 — 첫 실행에도 저장해 두어, 나중에 색을 바꿔도 셸이 옛 짝으로 따라 바뀌지 않는다 */
export function applyShell(shell) {
  document.documentElement.dataset.shell = shell;
  save(SHELL_KEY, shell);
}

/* 본문 폭(유건 9/30) — 가운데 보기 ⇄ 전체 너비. 사람별 편의라 이 기기에 저장(localStorage), 첫 페인트는 index.html이 같은 키로 입힌다 */
export const WIDTH_KEY = 'argo-office-width';
const widthSubs = new Set();
export const isFullWidth = () => document.documentElement.classList.contains('full-width');
export const onWidth = (f) => { widthSubs.add(f); return () => widthSubs.delete(f); };
export function toggleWidth() {
  save(WIDTH_KEY, document.documentElement.classList.toggle('full-width') ? 'full' : 'center');
  widthSubs.forEach((f) => f());
}

mq?.addEventListener('change', () => applyTheme(readTheme()));
