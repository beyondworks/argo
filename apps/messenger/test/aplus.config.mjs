// 축소판 A+ 화면 픽스처 — 실제 서버 없이 가짜 원본으로 띄운다. 운영·qbwr에 접속하지 않는다.
// 실행: (apps/messenger에서) node node_modules/vite/bin/vite.js --config test/aplus.config.mjs → http://127.0.0.1:5293/test/aplus.fixture.html?scenario=pro-many&lang=ko&theme=graphite-light
import { mergeConfig } from 'vite';
import base from '../vite.config.js';
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  server: { host: '127.0.0.1', port: Number(process.env.APLUS_TEST_PORT || 5293), strictPort: true },
});
