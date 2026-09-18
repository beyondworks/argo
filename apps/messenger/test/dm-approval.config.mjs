import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./dm-approval.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-dm-approval-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; }, load(id) { if (process.env.DM_BASELINE_REF && id.endsWith('/src/App.jsx')) return execFileSync('git', ['show', `${process.env.DM_BASELINE_REF}:apps/messenger/src/App.jsx`], { encoding: 'utf8' }); } }],
  server: { host: '127.0.0.1', port: Number(process.env.DM_APPROVAL_PORT || 5198), strictPort: true },
});
