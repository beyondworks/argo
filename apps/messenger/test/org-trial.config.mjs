import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

// base(../vite.config.js)가 cloud-config-gate 도입으로 콜백 형태다 — mergeConfig는 객체만 받으므로 먼저 풀어준다.
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
const fake = fileURLToPath(new URL('./org-trial.supabase.mjs', import.meta.url));
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-org-trial-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.ORG_TRIAL_TEST_PORT || 5231), strictPort: true },
});
