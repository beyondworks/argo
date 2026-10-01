// 터미널 명령 argo — 설정 화면 카드의 상태 조회·등록·제거·PATH 추가(src/cli-install.mjs, 2026-10-01).
// 데스크톱 사이드카(ARGO_PARENT_PID)에서만 응답한다 — 셀프호스트 웹에서 서버 사용자의 셸 파일을 고치지 못하게 404.
// 루프백 + 같은 출처 요청만. 셸 파일(~/.zprofile 등)은 action:'path'(사용자가 버튼을 누른 요청)에서만 고친다.
import { currentUser, authError, requestLang } from '../../auth.mjs';
import { cliInstallStatus, cliInstallAction, cliInstallRequestDenied } from '../../../src/cli-install.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const gate = async (req) => {
  const denied = cliInstallRequestDenied({ host: req.headers.get('host'), secFetchSite: req.headers.get('sec-fetch-site') });
  if (denied) return Response.json({ error: denied.error }, { status: denied.status });
  if (!(await currentUser())) return authError('auth_required', await requestLang());
  return null;
};

export async function GET(req) {
  const denied = await gate(req); if (denied) return denied;
  return Response.json(await cliInstallStatus(), { headers: { 'cache-control': 'no-store' } });
}

export async function POST(req) {
  const denied = await gate(req); if (denied) return denied;
  try {
    const { action } = await req.json();
    return Response.json(await cliInstallAction(action), { headers: { 'cache-control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: String(e?.message || e).slice(0, 200) }, { status: 400 });
  }
}
