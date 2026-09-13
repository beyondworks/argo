import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

const fake = fileURLToPath(new URL('./work-panel.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-work-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.WORK_TEST_PORT || 5217), strictPort: true },
});
