import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./u2-eject.supabase.mjs', import.meta.url));
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-u2-eject-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; }, load(id) { if (process.env.CH_BASELINE_REF && id.endsWith('/src/App.jsx')) return execFileSync('git', ['show', `${process.env.CH_BASELINE_REF}:apps/messenger/src/App.jsx`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } }],
  server: { host: '127.0.0.1', port: Number(process.env.U2_TEST_PORT || 5241), strictPort: true },
});
