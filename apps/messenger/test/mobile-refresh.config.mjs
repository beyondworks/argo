import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./dm-lifecycle.supabase.mjs', import.meta.url));
export default (env) => mergeConfig(base(env), {
  envDir: '/dev/null',
  plugins: [{ name: 'mobile-refresh-fixture', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: 5219, strictPort: true },
});
