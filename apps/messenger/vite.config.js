import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// 공유 순수 모듈은 별칭으로(복사 금지 — 사본 드리프트). 루트 워크스페이스 전환은 후속(lockfile·CI 파장).
const shared = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@argo/slash-match': shared('app/c/[ws]/slash-match.mjs') } },
  server: { fs: { allow: [shared('.')] } },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_ENV_'],
});
