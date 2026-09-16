import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./join.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-join-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.JOIN_TEST_PORT || 5201), strictPort: true },
});
