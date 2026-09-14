// 격리 Vite 서버 — apps/messenger/test/ 에 두고 apps/messenger 에서 실행한다.
//   SB_TEST_PORT=5371 node node_modules/vite/bin/vite.js --config test/scrollback.config.mjs
//   FAKE_PLATFORM=ios SB_TEST_PORT=5372 …   ← isMobilePlatform 을 켜 모바일 재개 경로를 연다
import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';

const fake = fileURLToPath(new URL('./scrollback.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null', // 실 .env 를 읽지 않는다(자격증명 차단)
  // platform.js 의 isMobilePlatform 은 import.meta.env.TAURI_ENV_PLATFORM 을 본다 — Tauri 없이 켜는 유일한 손잡이.
  define: { 'import.meta.env.TAURI_ENV_PLATFORM': JSON.stringify(process.env.FAKE_PLATFORM || '') },
  plugins: [{ name: 'isolated-scrollback-backend', enforce: 'pre', resolveId(s) { if (s === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.SB_TEST_PORT || 5371), strictPort: true },
});
