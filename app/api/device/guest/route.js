// 게스트(로컬 전용) 시작 — 로그인 없이 이 컴퓨터에서만 쓰는 모드를 켠다.
// 기기 로그인(login/route.js)과 같은 3중 계약: 루프백 한정 + 기기 파일(권한) + 마커 쿠키(UX 게이트).
// 비루프백(호스티드 웹)은 게스트 격리가 불가능하므로 거부 — 소셜 로그인만 허용된다.
import { AUTH_ON, isLoopbackHost } from '../../../auth.mjs';
import { enableGuestMode } from '../../../../src/gueststate.mjs';

const marker = () => `argo-guest=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 이미 로그인이 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 게스트 모드를 쓸 수 없습니다' }, { status: 403 });
    if (!isLoopbackHost(req.headers.get('host'))) {
      return Response.json({ error: '로컬 전용 시작은 이 컴퓨터(데스크톱 앱·로컬 서버)에서만 가능합니다' }, { status: 403 });
    }
    await enableGuestMode();
    return Response.json({ ok: true }, { headers: { 'Set-Cookie': marker() } });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 500 });
  }
}
