import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

const fake = fileURLToPath(new URL('./crew-face.supabase.mjs', import.meta.url));
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-crew-face-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.CREW_FACE_TEST_PORT || 5219), strictPort: true },
});
