// 러너 OAuth Connect — 벤더 CLI 브라우저 로그인을 서버가 대신 실행(로컬/데스크톱 전용).
// POST: 로그인 시작(브라우저 열림). GET: 로그인 완료 폴링(읽기전용 status).
import { startRunnerLogin, runnerLoginStatus, RUNNER_AUTH } from '../../../../../../src/runners.mjs';
import { guardCompany } from '../../../../../auth.mjs';

export async function POST(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const { runner } = await req.json();
  if (!RUNNER_AUTH[runner]) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  const r = await startRunnerLogin(runner);
  if (!r.ok) return Response.json({ ok: false, reason: r.reason }, { status: 400 });
  return Response.json({ ok: true });
}

export async function GET(req, { params }) {
  const { ws } = await params;
  const denied = await guardCompany(ws); if (denied) return denied;
  const runner = new URL(req.url).searchParams.get('runner');
  if (!RUNNER_AUTH[runner]) return Response.json({ error: '알 수 없는 러너' }, { status: 400 });
  return Response.json(await runnerLoginStatus(runner));
}
