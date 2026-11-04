// 앱 셸 자동 업데이트의 작업 중 확인 — "지금 이 서버에서 실행 중인 턴이 있는가"(src-tauri/src/auto_update_policy.rs probe_work가 루프백으로 묻는다).
// 셸은 세션 쿠키가 없어 공개 경로다(middleware.js isPublic). 실행 수 말고는 아무것도 싣지 않고, CORS 헤더를 달지 않아 다른 사이트가 읽지 못한다.
// 실행 등록부는 프로세스 전역(globalThis — src/turn-abort.mjs)이라 게이트웨이(메신저·텔레그램·루틴)가 시작한 턴도 여기서 보인다.
import { activeTurnCount } from '../../../src/turn-abort.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  // 호스팅 테넌트 워커는 데스크톱 셸이 없다 — 로그인 없이 다른 회사의 실행 수가 보이지 않게 닫는다(검수 사소 1)
  if (process.env.ARGO_TENANT_OWNER?.trim()) return new Response(null, { status: 404 });
  const turns = activeTurnCount();
  return Response.json({ busy: turns > 0, turns }, { headers: { 'cache-control': 'no-store' } });
}
