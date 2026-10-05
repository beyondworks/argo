import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';

const fake = fileURLToPath(new URL('./session-recovery.supabase.mjs', import.meta.url));
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;

export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{
    name: 'isolated-session-recovery-backend', enforce: 'pre',
    resolveId(source) { if (source === './supabase.js') return fake; },
  }],
  server: { host: '127.0.0.1', port: Number(process.env.D56_TEST_PORT || 5216), strictPort: true },
});
