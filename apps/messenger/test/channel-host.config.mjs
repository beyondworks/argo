import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./channel-host.supabase.mjs', import.meta.url));
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
// CH_BASELINE_REF=<커밋> — 그 커밋의 App.jsx로 같은 시나리오를 띄워 수정 전 화면을 비교한다(체크아웃은 바꾸지 않는다).
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-channel-host-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; }, load(id) { if (process.env.CH_BASELINE_REF && id.endsWith('/src/App.jsx')) return execFileSync('git', ['show', `${process.env.CH_BASELINE_REF}:apps/messenger/src/App.jsx`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } }],
  server: { host: '127.0.0.1', port: Number(process.env.CH_TEST_PORT || 5231), strictPort: true },
});
