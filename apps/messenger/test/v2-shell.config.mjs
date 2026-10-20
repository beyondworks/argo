// 메신저 v2 모드(기존 셸 + v2 어댑터, U6c-1b) 화면 픽스처 — 실제 서버 없이 기존 셸을 v2 표로 띄운다. 운영·qbwr에 접속하지 않는다.
// 실행: (apps/messenger에서) node node_modules/vite/bin/vite.js --config test/v2-shell.config.mjs → http://127.0.0.1:5291/test/v2-shell.fixture.html?lang=ko&theme=graphite-light&space=team
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
