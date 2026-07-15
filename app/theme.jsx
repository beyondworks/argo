'use client';
// 테마 — 디자인 토큰 세트 전환. <html data-theme>로 적용, localStorage argo-lang과 같은 패턴.
// 새 테마 추가: globals.css에 :root[data-theme='이름'] 토큰 블록 + 아래 THEMES 등록 + i18n 라벨.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';

export const THEMES = [
  'argo', 'argo-light', 'argo-dark', 'apple', 'apple-dark', 'glass', 'glass-dark',
  'clay', 'porcelain', 'mist', 'frost',
  'cream-pop', 'peach', 'retro', 'sketch',
  'tokyo-night', 'nord', 'everforest', 'dracula', 'monokai', 'rose-pine',
  // VS Code 임포트 (마켓플레이스 팔레트 정밀 이식)
  'codex-gh-light', 'codex-gh-dark', 'enjoyer', 'minimal-light', 'minimal-dark',
]; // 첫 항목이 기본값
const KEY = 'argo-theme';

function apply(theme) {
  const el = document.documentElement;
  if (theme === THEMES[0]) delete el.dataset.theme;
  else el.dataset.theme = theme;
  // 캔버스(기억 그래프)처럼 토큰을 직접 읽는 소비자에게 알림
  window.dispatchEvent(new Event('argo:theme'));
}

const ThemeCtx = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(THEMES[0]);

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (THEMES.includes(saved)) { setThemeState(saved); apply(saved); }
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
