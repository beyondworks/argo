// History API 라우터 — 라이브러리 없이 수십 줄. 주소가 곧 상태다(새로고침·새 탭·뒤로 가기가 그대로 동작).
import { useSyncExternalStore } from 'react';

const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
if (typeof window !== 'undefined') window.addEventListener('popstate', emit);

export function navigate(to, { replace = false } = {}) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  emit();
}

/** 경로 + 쿼리(예: '/o/beyondworks/approvals?open=ap1') — 쿼리만 바뀌어도 다시 그린다 */
export const useUrl = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => location.pathname + location.search, () => '/');

/** '/o/:org/p/:id' 같은 패턴을 경로와 맞춘다 — 맞으면 params, 아니면 null */
export function match(pattern, path) {
  const p = pattern.split('/'), s = path.replace(/\/+$/, '').split('/');
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

/** 일반 클릭만 가로챈다 — ⌘/Ctrl/Shift 클릭은 브라우저 기본(새 탭)을 살린다 */
export function Link({ to, onClick, ...rest }) {
  return <a href={to} {...rest} onClick={(e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); navigate(to);
  }} />;
}
