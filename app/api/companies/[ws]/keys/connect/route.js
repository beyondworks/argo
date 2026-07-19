// 러너 OAuth Connect — 두 방식:
// · 웹 브리지(claude·codex·gemini): 서버가 PKCE 인증 URL을 UI에 반환(사용자 기기에서 열림),
//   승인 코드/리다이렉트 주소를 받아 토큰 교환 → 회사 자격 저장(암호화 동기화로 전 기기 전파). 워커·로컬 공통.
// · CLI 대행(codex — 레거시 폴백): 벤더 CLI 브라우저 로그인을 서버가 실행(로컬/데스크톱 전용).
// POST { runner }: 시작(url 반환). POST { runner, code }: 코드 제출. POST { runner, cli:true }: CLI 대행.
// POST { runner:'claude', setup:true }: 공식 setup-token PTY 대행(로컬 전용 — 원클릭 연결).
// GET: 완료 폴링(읽기전용). GET ?setup=1: setup-token 진행 상태.
import {
  startRunnerLogin, runnerLoginStatus, RUNNER_AUTH,
  startRunnerWebAuth, submitRunnerWebAuth, webAuthDone,
  startClaudeSetupToken, setupTokenStatus,
} from '../../../../../../src/runners.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { runner, code, cli, setup } = await req.json();
  const meta = RUNNER_AUTH[runner];
  if (!meta) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude' && setup) { // 원클릭 — 데스크톱 번들에서만 완주(startClaudeSetupToken이 ARGO_STANDALONE 게이트)
    const r = await startClaudeSetupToken(ws);
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  if (meta.webConnect && !cli) {
    const r = code ? await submitRunnerWebAuth(ws, runner, code) : startRunnerWebAuth(runner, ws); // wsId 전달 — 로컬 콜백 리스너가 자동 저장
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  const r = await startRunnerLogin(runner);
  if (!r.ok) return Response.json({ ok: false, reason: r.reason }, { status: 400 });
  return Response.json({ ok: true });
}

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const u = new URL(req.url);
  const runner = u.searchParams.get('runner');
  const meta = RUNNER_AUTH[runner];
  if (!meta) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude' && u.searchParams.get('setup')) {
    return Response.json(setupTokenStatus(ws)); // { status: idle|running|saved|failed, error }
  }
  if (meta.webConnect) {
    // 웹 브리지 완료 = "이번 브리지 세션의 저장 완료"(webAuthDone). 자격 '존재'로 판정하면 기존 자격
    // 보유 러너의 재연결·방식 전환이 승인 전에 거짓 '연결됨'이 된다(감사 2026-07-20).
    return Response.json({ supported: true, authed: webAuthDone(runner, ws) });
  }
  return Response.json(await runnerLoginStatus(runner));
}
