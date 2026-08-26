import { cookies } from 'next/headers';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { loadDeviceSession, getFreshDeviceSession } from '../../../src/devicesession.mjs';

/** 현재 사용자 — 사이드바 사용자 표시·로그아웃 노출 판단의 원천.
    sessionDead: 기기 세션 파일은 있는데(화면엔 로그인됨으로 보임) 토큰이 만료됐고 갱신도 죽은 상태
    (Invalid Refresh Token 계열 — 회전 유실 사고의 후유증). 이 상태를 숨기면 피드백·동기화 같은
    클라우드 기능이 "로그인됨" 표시 아래에서 조용히 전멸한다(실사고 2026-08-26: 8/19부터 죽어 있었음).
    로컬 기능은 기기 파일 신원으로 계속 동작하므로 user는 그대로 주고 표시만 정직하게 한다. */
export async function GET() {
  const user = await currentUser();
  let sessionDead = false;
  if (AUTH_ON && user && user.id !== 'local') {
    const store = await cookies();
    const hasCookie = store.getAll().some((c) => c.name.startsWith('sb-'));
    if (!hasCookie) {
      const dev = loadDeviceSession();
      // 만료 60초 전부터 갱신을 시도해 보고, 갱신이 죽어 있으면(가족 폐기 등) 정직하게 알린다.
      if (dev && (dev.expires_at ?? 0) * 1000 < Date.now() + 60_000) {
        sessionDead = !(await getFreshDeviceSession().catch(() => null));
      }
    }
  }
  return Response.json({ authOn: AUTH_ON, user, ...(sessionDead ? { sessionDead: true } : {}) });
}
