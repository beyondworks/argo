// 최상위 오류 화면(RootBoundary, diag.jsx)의 문구·색(2026-10-05 분리 검증 MSG-12). 이 화면은 언어·테마 Provider 밖이라 훅을 못 쓴다 —
// 사전(i18n.js t)은 순수 함수라 그대로 쓰고, 색은 테마 토큰(var(--fg) 등 — <html data-theme>은 오류 뒤에도 남는다)에 토큰이 없을 때의 대체값을 단다.
// 종전에는 한국어 고정·글자색 #1a1a1a 고정이라 다크 바탕에서 거의 보이지 않았다.
import { t } from './i18n.js';
const LIGHT = { fg: '#1f1d19', fg2: '#5c574b', bg: '#f2efe8', card: '#ffffff', border: '#cfc9bc' };
const DARK = { fg: '#ece8df', fg2: '#b8b2a5', bg: '#1f1e1b', card: '#2b2a26', border: '#4a463e' };
/** 다크로 그릴까 — 저장 테마가 '-dark'이거나, 시스템 자동 테마(linen·graphite·argo·미지정)에서 OS가 다크일 때 */
export function prefersDark({ theme = '', systemDark = false } = {}) {
  if (/-dark$/.test(theme)) return true;
  if (/-light$/.test(theme)) return false;
  return ['', 'argo', 'linen', 'graphite'].includes(theme) ? !!systemDark : false;
}
export function rootErrorView({ lang = 'ko', dark = false, phone = false } = {}) {
  const c = dark ? DARK : LIGHT;
  return { title: t('root.error.title', lang), hint: t('root.error.hint', lang, { path: t(phone ? 'diag.path.phone' : 'diag.path.desktop', lang) }), reload: t('root.error.reload', lang),
    fg: `var(--fg, ${c.fg})`, fg2: `var(--fg-2, ${c.fg2})`, bg: `var(--bg, ${c.bg})`, btnBg: `var(--card, ${c.card})`, border: `var(--border, ${c.border})` };
}
