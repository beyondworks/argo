import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./ux3.supabase.mjs', import.meta.url));
// base(../vite.config.js)가 2026-09-25 cloud-config-gate 도입(b3ac2f16)으로 콜백 형태가 됐다 — mergeConfig는 객체만 받으므로 먼저 풀어준다(2026-09-26, 이 픽스처 하네스 한정 수리).
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-ux3-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.UX3_TEST_PORT || 5200), strictPort: true },
});
