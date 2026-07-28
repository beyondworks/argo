// 결제 의사 신호 — 업그레이드 버튼 클릭 시 fire-and-forget POST. 부정 확정 게이트
// (ls_reconcile_empty_at)만 해제해, "설정 열기(대사가 empty 확정) → 곧장 결제 → 웹훅 유실"의
// 복구가 24시간 잠기는 것을 막는다(2차 검수 HIGH — 업그레이드 CTA가 대사 트리거와 같은 카드라
// 이 순서가 기본 동선이다). 시도 게이트(10분)는 안 풀린다 — 연타해도 LS 호출 증폭 없음.
// 신원은 세션에서만(본인 게이트만 해제 가능) — 쿠키 세션 우선, 기기 연동 세션 폴백(billing GET과 동일 구조).
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { currentUser } from '../../../../auth.mjs';
import { clearReconcileEmpty } from '../../../../../src/lsreconcile.mjs';

export async function POST() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return Response.json({ ok: true }); // 로컬 전용 — 결제 표면 없음
  try {
    let userId = null;
    if (anon) {
      const store = await cookies();
      const sb = createServerClient(url, anon, {
        cookies: { getAll: () => store.getAll(), setAll: () => { /* 갱신은 미들웨어 담당 */ } },
      });
      const { data: { user } } = await sb.auth.getUser();
      userId = user?.id ?? null;
    }
    if (!userId) {
      const user = await currentUser();
      userId = user?.id ?? null;
    }
    if (!userId || userId === 'local' || userId === 'guest') return Response.json({ ok: true });
    const sb = createClient(url, serviceKey, { auth: { persistSession: false } });
    await clearReconcileEmpty(sb, userId); // 실패는 내부에서 삼킨다(무해 — 로그만)
  } catch (e) {
    console.error('[argo] billing intent 실패(무해):', e?.message ?? e);
  }
  return Response.json({ ok: true }); // 신호일 뿐 — 어떤 실패도 결제 동선을 막지 않는다
}
