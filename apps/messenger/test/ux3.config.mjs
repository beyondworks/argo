import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./ux3.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-ux3-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.UX3_TEST_PORT || 5200), strictPort: true },
});
