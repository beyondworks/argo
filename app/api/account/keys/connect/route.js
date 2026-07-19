// 계정 스코프 러너 OAuth Connect(온보딩) — companies/[ws]/keys/connect와 같은 계약, 저장만 사용자별 계정 스코프.
// POST { runner }: 웹 브리지 시작(url 반환). POST { runner, code }: 코드 제출. POST { runner, cli:true }: CLI 대행.
// POST { runner:'claude', setup:true }: 공식 setup-token PTY 대행(로컬 전용 — 원클릭 연결).
// GET: 완료 폴링. GET ?setup=1: setup-token 진행 상태.
import {
  accountScope, startRunnerLogin, runnerLoginStatus, RUNNER_AUTH,
  startRunnerWebAuth, submitRunnerWebAuth, loadRunnerCred,
  startClaudeSetupToken, setupTokenStatus,
} from '../../../../../src/runners.mjs';
import { currentUser, tenantDenied } from '../../../../auth.mjs';

/** 통과 시 { scope }(그 사용자의 계정 스코프), 위반 시 { denied: Response }. */
async function guardAccount() {
  const user = await currentUser();
  if (!user) return { denied: Response.json({ error: '로그인이 필요합니다' }, { status: 401 }) };
  const td = tenantDenied(user); if (td) return { denied: td };
  return { scope: accountScope(user.id) };
}

export async function POST(req) {
  const g = await guardAccount(); if (g.denied) return g.denied;
  const { runner, code, cli, setup } = await req.json();
  const meta = RUNNER_AUTH[runner];
  if (!meta) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude' && setup) { // 원클릭 — 데스크톱 번들에서만 완주(ARGO_STANDALONE 게이트, companies 라우트와 동일)
    const r = await startClaudeSetupToken(g.scope);
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  if (meta.webConnect && !cli) {
    const r = code ? await submitRunnerWebAuth(g.scope, runner, code) : startRunnerWebAuth(runner, g.scope); // 자동 수신
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  const r = await startRunnerLogin(runner);
  if (!r.ok) return Response.json({ ok: false, reason: r.reason }, { status: 400 });
  return Response.json({ ok: true });
}

export async function GET(req) {
  const g = await guardAccount(); if (g.denied) return g.denied;
  const u = new URL(req.url);
  const runner = u.searchParams.get('runner');
  const meta = RUNNER_AUTH[runner];
  if (!meta) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude' && u.searchParams.get('setup')) {
    return Response.json(setupTokenStatus(g.scope)); // { status: idle|running|saved|failed, error }
  }
  if (meta.webConnect) {
    // 웹 브리지 완료 = 계정 자격 존재
    return Response.json({ supported: true, authed: !!(await loadRunnerCred(g.scope, runner)) });
  }
  return Response.json(await runnerLoginStatus(runner));
}
