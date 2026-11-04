// 앱 셸 자동 업데이트의 작업 중 확인 — "지금 재시작하면 끊길 일이 있는가"(src-tauri/src/auto_update_policy.rs probe_work가 루프백으로 묻는다).
// 셸은 세션 쿠키가 없어 공개 경로다(middleware.js isPublic). 수만 싣고, CORS 헤더를 달지 않아 다른 사이트가 읽지 못한다.
// 세 가지를 센다:
//  ① 이 프로세스의 실행 등록부(globalThis — src/turn-abort.mjs) — 채팅·메신저·텔레그램·루틴·회의실 턴
//  ② 이 프로세스의 단발 실행(runOneShot — 야간 기억 정리 등)
//  ③ 같은 데이터 폴더의 신선한 턴 상태 파일(src/turn-status.mjs) — 앱과 같이 쓰는 argo CLI(다른 프로세스)의 턴. Windows 설치기는
//     같은 node.exe를 끝내므로(src-tauri/windows/hooks.nsh) 그 턴도 끊긴다.
import { activeTurnCount, activeOneShotCount } from '../../../src/turn-abort.mjs';
import { freshTurnStatusCount } from '../../../src/turn-status.mjs';

export const dynamic = 'force-dynamic';

export async function GET() {
  // 호스팅 테넌트 워커는 데스크톱 셸이 없다 — 로그인 없이 다른 회사의 실행 수가 보이지 않게 닫는다
  if (process.env.ARGO_TENANT_OWNER?.trim()) return new Response(null, { status: 404 });
  const turns = activeTurnCount();
  const oneShots = activeOneShotCount();
  const statusFiles = await freshTurnStatusCount().catch(() => 0);
  return Response.json({ busy: turns + oneShots + statusFiles > 0, turns, oneShots, statusFiles }, { headers: { 'cache-control': 'no-store' } });
}
