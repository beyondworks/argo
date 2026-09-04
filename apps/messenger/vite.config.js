import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 공유 순수 모듈은 별칭으로(복사 금지 — 사본 드리프트). 루트 워크스페이스 전환은 후속(lockfile·CI 파장).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: {
    '@argo/slash-match': shared('app/c/[ws]/slash-match.mjs'),
    '@argo/globals.css': shared('app/globals.css'), // 디자인 시스템 정본 — 토큰·컴포넌트·테마 전부(사본 금지)
    '@argo/theme': shared('app/theme.jsx'),          // ThemeProvider·THEMES·DEFAULT_THEME(graphite) — localStorage 'argo-theme' 공유
    '@argo/ui': shared('app/ui.jsx'),                // Icon·Avatar·Markdown·DropUp·imeGuardWith
    '@argo/i18n': shared('app/i18n.jsx'),            // LangProvider(ui.jsx가 요구) + 테마 라벨
    '@argo/graph2d': shared('app/c/[ws]/graph2d.jsx'),
    '@argo/graph2d-core': shared('app/c/[ws]/graph2d-core.mjs'), // 그래프 구성(순수) — 3D 활동 그래프(graph3d.jsx)가 같은 구성을 쓴다 // 기억 그래프 2D(캔버스·테마 토큰) — 활동 페이지가 조직·채널·사람·크루·문서 관계를 같은 룩으로 그린다
  } },
  server: { fs: { allow: [shared('.')] } },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
