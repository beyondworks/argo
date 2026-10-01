import { mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import base from '../vite.config.js';

const fake = fileURLToPath(new URL('./crew-face.supabase.mjs', import.meta.url));
// vite.config.js가 함수 설정(defineConfig(({ command, mode }) => …))이라 mergeConfig에 그대로 넘기면 'Cannot merge config in form of callback'으로 뜨지 않는다
export default (env) => mergeConfig(typeof base === 'function' ? base(env) : base, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-crew-face-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.CREW_FACE_TEST_PORT || 5219), strictPort: true },
});
