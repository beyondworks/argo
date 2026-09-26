import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const fake = fileURLToPath(new URL('./msgr-ui-feedback.supabase.mjs', import.meta.url));
// UF_BASELINE_REF를 주면 그 커밋의 App.jsx를 불러온다 — 수정 전후를 같은 픽스처로 잰다.
// 체크아웃의 파일은 바꾸지 않는다(git show로 읽기만 한다).
// base(../vite.config.js)가 2026-09-25 cloud-config-gate 도입(b3ac2f16)으로 콜백 형태가 됐다 — mergeConfig는 객체만 받으므로 먼저 풀어준다(2026-09-26, 이 픽스처 하네스 한정 수리).
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{
    name: 'isolated-ui-feedback-backend', enforce: 'pre',
    resolveId(source) { if (source === './supabase.js') return fake; },
    load(id) { if (process.env.UF_BASELINE_REF && id.endsWith('/src/App.jsx')) return execFileSync('git', ['show', `${process.env.UF_BASELINE_REF}:apps/messenger/src/App.jsx`], { encoding: 'utf8' }); },
  }],
  server: { host: '127.0.0.1', port: Number(process.env.UF_TEST_PORT || 5211), strictPort: true },
});
