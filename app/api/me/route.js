import { cookies } from 'next/headers';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { deviceSessionDead } from '../../../src/devicesession.mjs';

/** 현재 사용자 — 사이드바 사용자 표시·로그아웃 노출 판단의 원천.
    sessionDead: 기기 세션이 "만료 + 갱신 사망(리프레시 거절 마커)"인 상태. 숨기면 피드백·동기화가
    "로그인됨" 표시 아래에서 조용히 전멸한다(실사고 2026-08-26: 8/19부터 죽어 있었음).
    판정은 **회전 없이**(deviceSessionDead — 파일만 읽음): 이 라우트가 갱신을 트리거하면 상주·사이드카
    이중 회전으로 세션 가족이 폐기되는 2026-08-14 사고 구조를 UI 마운트마다 재생산한다(분리 검수 M4).
    마커가 아직 없으면(첫 감지 전) 다음 피드백·동기화 시도가 남긴 뒤 표시된다 — 지연은 있어도 오탐은 없다. */
export async function GET() {
  const user = await currentUser();
  let sessionDead = false;
  if (AUTH_ON && user && user.id !== 'local') {
    const store = await cookies();
    if (!store.getAll().some((c) => c.name.startsWith('sb-'))) sessionDead = deviceSessionDead();
  }
  return Response.json({ authOn: AUTH_ON, user, ...(sessionDead ? { sessionDead: true } : {}) });
}
