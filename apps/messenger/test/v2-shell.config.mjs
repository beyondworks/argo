// 메신저 v2 셸(U6b) 화면 픽스처 — 실제 서버 없이 v2 화면(공간 목록·방·일 카드·시스템 글)을 띄운다. 운영·qbwr에 접속하지 않는다.
// 실행: (apps/messenger에서) node node_modules/vite/bin/vite.js --config test/v2-shell.config.mjs → http://127.0.0.1:5291/test/v2-shell.fixture.html?lang=ko&theme=graphite-light
import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
const fake = fileURLToPath(new URL('./v2-shell.supabase.mjs', import.meta.url));
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-v2-shell-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.V2_SHELL_TEST_PORT || 5291), strictPort: true },
});
