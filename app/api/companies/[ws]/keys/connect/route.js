// 러너 OAuth Connect — 두 방식:
// · codex: 벤더 CLI 브라우저 로그인을 서버가 대신 실행(로컬/데스크톱 전용 — 브라우저가 서버 기기에서 열림)
// · claude: 웹 브리지 — setup-token을 서버가 대행, 인증 URL을 UI에 반환(사용자 기기에서 열림),
//   승인 코드를 받아 장기 토큰을 회사 자격으로 저장(암호화 동기화로 전 기기 전파). 워커·로컬 공통.
// POST { runner }: 시작. POST { runner:'claude', code }: 코드 제출. GET: 완료 폴링(읽기전용).
import {
  startRunnerLogin, runnerLoginStatus, RUNNER_AUTH,
  startClaudeSetup, submitClaudeSetupCode, loadRunnerCred,
} from '../../../../../../src/runners.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { runner, code } = await req.json();
  if (!RUNNER_AUTH[runner]) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude') {
    const r = code ? await submitClaudeSetupCode(ws, code) : await startClaudeSetup();
    return Response.json(r, { status: r.ok ? 200 : 400 });
  }
  const r = await startRunnerLogin(runner);
  if (!r.ok) return Response.json({ ok: false, reason: r.reason }, { status: 400 });
  return Response.json({ ok: true });
}

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const runner = new URL(req.url).searchParams.get('runner');
  if (!RUNNER_AUTH[runner]) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  if (runner === 'claude') {
    // 웹 브리지 완료 = 회사 자격 존재
    return Response.json({ supported: true, authed: !!(await loadRunnerCred(ws, 'claude')) });
  }
  return Response.json(await runnerLoginStatus(runner));
}
