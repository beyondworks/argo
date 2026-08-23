'use client';
// 테마 — 디자인 토큰 세트 전환. <html data-theme>로 적용, localStorage argo-lang과 같은 패턴.
// 새 테마 추가: globals.css에 :root[data-theme='이름'] 토큰 블록 + 아래 THEMES 등록 + i18n 라벨.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const THEMES = [
  'argo', 'argo-light', 'argo-dark', 'calm', 'calm-dark', 'apple', 'apple-dark', 'glass', 'glass-dark',
  'clay', 'porcelain', 'mist', 'frost',
  'cream-pop', 'peach', 'retro', 'sketch',
  'tokyo-night', 'nord', 'everforest', 'dracula', 'monokai', 'rose-pine',
  // VS Code 임포트 (마켓플레이스 팔레트 정밀 이식)
  'codex-gh-light', 'codex-gh-dark', 'enjoyer', 'minimal-light', 'minimal-dark',
  // 중성 회색(유건 지정 2026-08-01). 'graphite'는 **시스템 자동** — argo와 같은 방식으로 다크/라이트를 따라간다.
  'graphite', 'graphite-light', 'graphite-dark',
];
// 기본값 — 그래파이트(시스템 자동). 유건 지시 2026-08-23: 기본 테마를 그래파이트로, 아르고는 선택 가능하게 유지.
// 'argo'만 data-theme 없이(:root 토큰) 렌더되므로 기본값이 바뀌어도 argo 분기는 그대로 둔다.
export const DEFAULT_THEME = 'graphite';
const KEY = 'argo-theme';

function apply(theme) {
  const el = document.documentElement;
  if (theme === 'argo') delete el.dataset.theme;
  else el.dataset.theme = theme;
  // 캔버스(기억 그래프)처럼 토큰을 직접 읽는 소비자에게 알림
  window.dispatchEvent(new Event('argo:theme'));
}

const ThemeCtx = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(DEFAULT_THEME);

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (THEMES.includes(saved)) { setThemeState(saved); apply(saved); } else apply(DEFAULT_THEME);
  }, []);

  const setTheme = useCallback((next) => {
    if (!THEMES.includes(next)) return;
    setThemeState(next);
    apply(next);
    try { localStorage.setItem(KEY, next); } catch { /* 사파리 프라이빗 등 */ }
  }, []);

  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error('useTheme은 ThemeProvider 안에서만');
  return ctx;
}
