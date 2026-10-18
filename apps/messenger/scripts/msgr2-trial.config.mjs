// 메신저 v2 체험(유건님 직접 체험) vite 설정 — scripts/msgr2-trial-web.sh가 쓴다. 직접 부르지 않는다(관문을 건너뛴다).
// .env 파일을 읽지 않는다(envDir /dev/null): 서버 주소·공개 키·v2 플래그는 실행 스크립트가 관문을 통과한 값으로만 넣는다(VITE_SUPABASE_URL·VITE_SUPABASE_ANON_KEY·VITE_MSGR_V2=1).
// MSGR2_TRIAL_FAKE=1이면 v2 셸 가짜 서버(test/v2-shell.supabase.mjs)를 끼운다 — qbwr가 준비되기 전에 스크립트가 뜨는지만 본다(그때 화면은 /test/v2-shell.fixture.html).
import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
const fake = process.env.MSGR2_TRIAL_FAKE === '1' ? fileURLToPath(new URL('../test/v2-shell.supabase.mjs', import.meta.url)) : null;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: fake ? [{ name: 'msgr2-trial-fake-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }] : [],
  server: { host: '127.0.0.1', port: Number(process.env.MSGR2_TRIAL_WEB_PORT || 5310), strictPort: true },
});
