import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 공유 순수 모듈은 별칭으로(복사 금지 — 사본 드리프트). 루트 워크스페이스 전환은 후속(lockfile·CI 파장).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export default defineConfig({
  plugins: [react()],
  // React 사본 하나로(실사고 2026-09-07 v0.1.0: @argo/* 별칭이 루트 node_modules의 react를, 메신저 코드는 apps/messenger의
  // react를 들고 와 빌드에 React가 둘 실렸다 → "Cannot read properties of null (reading 'useState')"로 첫 발행 설치본이 빈 화면.
  // dev는 사전 번들이 가려 안 보였다 — 프로덕션 번들 실측이 필수인 이유).
  resolve: { dedupe: ['react', 'react-dom'], alias: {
    '@argo/slash-match': shared('app/c/[ws]/slash-match.mjs'),
    '@argo/globals.css': shared('app/globals.css'), // 디자인 시스템 정본 — 토큰·컴포넌트·테마 전부(사본 금지)
    '@argo/theme': shared('app/theme.jsx'),          // ThemeProvider·THEMES·DEFAULT_THEME(graphite) — localStorage 'argo-theme' 공유
    '@argo/ui': shared('app/ui.jsx'),                // Icon·Avatar·Markdown·DropUp·imeGuardWith
    '@argo/i18n': shared('app/i18n.jsx'),            // LangProvider(ui.jsx가 요구) + 테마 라벨
    '@argo/graph2d-core': shared('app/c/[ws]/graph2d-core.mjs'), // 그래프 구성(순수) — 3D 기억 그래프(graph3d.jsx)가 같은 구성을 쓴다(본체 2D 렌더러는 쓰지 않는다)
  } },
  server: { host: process.env.TAURI_DEV_HOST || false, strictPort: true, fs: { allow: [shared('.')] } },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
