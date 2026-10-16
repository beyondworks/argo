// 아르고 메신저 봇 API — 일시 중단판(2026-10-16). 메신저가 멈춘 동안 옛 연결 도구(Hermes·OpenClaw)의 반복 호출을 가장 적게 만드는 응답만 준다.
// DB·Storage·외부 호출이 전혀 없다(paused.js). 원래 함수(core.js·connect-bundle.js를 쓰는 판)는 git 이력과 맥 one 백업(~/argo-backups/2026-10-16-msgr-bot-fn)에 있다.
// 배포: `supabase functions deploy msgr-bot --no-verify-jwt` — 원래와 같이 verify_jwt = false(봇은 Supabase JWT가 없다).
import { pausedReply } from './paused.js';

Deno.serve((req) => {
  const r = pausedReply({ method: req.method, path: new URL(req.url).pathname, userAgent: req.headers.get('user-agent') ?? '' });
  return new Response(r.body, { status: r.status, headers: r.headers });
});
