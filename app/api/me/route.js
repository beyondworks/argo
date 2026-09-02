import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { deviceSessionDead, deviceSessionDeadInfo } from '../../../src/devicesession.mjs';

/** 현재 사용자 — 사이드바 사용자 표시·로그아웃 노출 판단의 원천.
    sessionDead: 기기 세션이 "만료 + 갱신 사망(리프레시 거절 마커)"인 상태. 숨기면 피드백·동기화가
    "로그인됨" 표시 아래에서 조용히 전멸한다(실사고 2026-08-26: 8/19부터 죽어 있었음).
    판정은 **회전 없이**(deviceSessionDead — 파일만 읽음): 이 라우트가 갱신을 트리거하면 상주·사이드카
    이중 회전으로 세션 가족이 폐기되는 2026-08-14 사고 구조를 UI 마운트마다 재생산한다(분리 검수 M4).
    마커가 아직 없으면(첫 감지 전) 다음 피드백·동기화 시도가 남긴 뒤 표시된다 — 지연은 있어도 오탐은 없다. */
export async function GET() {
  const user = await currentUser();
  let sessionDead = false;
  let sessionDeadInfo = null; // 거절 사유(마커 JSON) — 사이드바 툴팁이 "왜"를 보여준다(2026-09-02 재발 제보)
  if (AUTH_ON && user && user.id !== 'local' && deviceSessionDead()) {
    // 기기 세션이 사망 마커 상태여도 **유효한** 쿠키 세션이 있으면 클라우드 기능은 산다.
    // 쿠키 "존재"만 보면 안 된다 — 무효 쿠키가 남은 브라우저에서 표시가 조용히 꺼진다
    // (라이브 재현 2026-08-26: 마커 존재 + 무효 sb 쿠키 → sessionDead 미표시). 유효성 검증은
    // 마커 상태에서만 도니 건강한 기기의 /api/me 비용은 0이다(feedback 라우트와 같은 판정).
    const store = await cookies();
    let cookieAlive = false;
    if (store.getAll().some((c) => c.name.startsWith('sb-'))) {
      const sb = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 */ } } },
      );
      cookieAlive = !!(await sb.auth.getUser()).data?.user;
    }
    sessionDead = !cookieAlive;
    if (sessionDead) {
      const i = deviceSessionDeadInfo();
      if (i) sessionDeadInfo = { kind: i.kind, reason: i.reason, at: i.at, count: i.count }; // reason은 devicesession.mjs가 토큰 모양을 가린 값
    }
  }
  return Response.json({ authOn: AUTH_ON, user, ...(sessionDead ? { sessionDead: true, sessionDeadInfo } : {}) });
}
