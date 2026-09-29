import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

const fake = fileURLToPath(new URL('./work-panel.supabase.mjs', import.meta.url));
// base(../vite.config.js)가 2026-09-25 cloud-config-gate 도입(b3ac2f16)으로 콜백 형태가 됐다 — mergeConfig는 객체만 받으므로 먼저 풀어준다(2026-09-26, 이 픽스처 하네스 한정 수리).
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-work-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.WORK_TEST_PORT || 5217), strictPort: true },
});
