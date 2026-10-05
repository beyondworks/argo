import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
// 보낸 뒤 대기 표시(2026-10-05) 화면 확인용 픽스처 — 운영 클라이언트·자격증명 0, 가짜 백엔드(send-feedback.supabase.mjs)만.
// apps/messenger에서: SF_TEST_PORT=5212 npx vite --config test/send-feedback.config.mjs → http://127.0.0.1:5212/?ch=general (꺼진 기기: &offline=1)
// 크루 방송·답은 콘솔에서 window.__sf.typing('general') · window.__sf.reply('general', '답') 으로 쏜다(게이트웨이 대역).
const fake = fileURLToPath(new URL('./send-feedback.supabase.mjs', import.meta.url));
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-send-feedback-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.SF_TEST_PORT || 5212), strictPort: true },
});
