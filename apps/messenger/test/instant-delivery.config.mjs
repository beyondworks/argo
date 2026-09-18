import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./instant-delivery.supabase.mjs', import.meta.url));
// IN_BASELINE_REF를 주면 그 커밋의 App.jsx를 불러온다 — 수정 전후를 같은 픽스처로 잰다.
// 체크아웃의 파일은 바꾸지 않는다(git show로 읽기만 한다).
export default mergeConfig(base, {
  envDir: '/dev/null',
  plugins: [{
    name: 'isolated-instant-backend', enforce: 'pre',
    resolveId(source) { if (source === './supabase.js') return fake; },
    load(id) { if (process.env.IN_BASELINE_REF && id.endsWith('/src/App.jsx')) return execFileSync('git', ['show', `${process.env.IN_BASELINE_REF}:apps/messenger/src/App.jsx`], { encoding: 'utf8' }); },
  }],
  server: { host: '127.0.0.1', port: Number(process.env.IN_TEST_PORT || 5201), strictPort: true },
});
