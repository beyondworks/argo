import { mergeConfig } from 'vite';
import base from '../vite.config.js';
import { fileURLToPath } from 'node:url';
// 보낸 뒤 대기 표시(2026-10-05) 화면 확인용 픽스처 — 운영 클라이언트·자격증명 0, 가짜 백엔드(send-feedback.supabase.mjs)만.
// apps/messenger에서: SF_TEST_PORT=5212 npx vite --config test/send-feedback.config.mjs → http://127.0.0.1:5212/?ch=general (꺼진 기기: &offline=1)
// 크루 방송·답은 콘솔에서 window.__sf.typing('general') · window.__sf.reply('general', '답') 으로 쏜다(게이트웨이 대역).
// 방송을 놓친 답(2026-10-07): ?ch=dm-p 에서 글을 보내 '준비 중'을 띄운 뒤 __sf.replyMissed('dm-p', '놓친 답') → 그대로 '준비 중'(방송 없음) →
//   __sf.status('u:user-me', 'CHANNEL_ERROR'); __sf.status('u:user-me', 'SUBSCRIBED') 로 u: 재연결 → 약 0.8초 뒤 답이 보이고 '준비 중'이 사라져야 한다.
//   또는 재연결 대신 __sf.reply('general', '다른 방 글') → 안 읽음 재집계(1.5초 뒤)가 dm-p에 모르는 글이 있다고 해 따라잡는다. 요청 수는 __sf.queries.
const fake = fileURLToPath(new URL('./send-feedback.supabase.mjs', import.meta.url));
const resolvedBase = typeof base === 'function' ? await base({ command: 'serve', mode: 'development' }) : base;
export default mergeConfig(resolvedBase, {
  envDir: '/dev/null',
  plugins: [{ name: 'isolated-send-feedback-backend', enforce: 'pre', resolveId(source) { if (source === './supabase.js') return fake; } }],
  server: { host: '127.0.0.1', port: Number(process.env.SF_TEST_PORT || 5212), strictPort: true },
});
