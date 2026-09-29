import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

const fake = fileURLToPath(new URL('./work-panel.supabase.mjs', import.meta.url));
// vite 7.3의 mergeConfig는 콜백 폼(defineConfig(({command,mode})=>...))을 그대로 안 받는다 — 먼저 호출해 객체로 풀어준다.
const resolvedBase = typeof base === 'function' ? base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-work-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.WORK_TEST_PORT || 5217), strictPort: true },
});
