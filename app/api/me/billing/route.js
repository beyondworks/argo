// 내 구독 상태 — 설정 카드의 연체 배너·구독 관리(LS 포털) 링크의 원천.
// 서비스 롤로 본인 행만 읽어 필요한 필드만 내보낸다(LS 내부 id는 클라에 불필요 — 노출 최소화).
import { currentUser } from '../../../auth.mjs';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  const user = await currentUser();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!user?.id || !url || !key) return Response.json({ billing: null }); // 로컬 전용·미설정 — 결제 표면 없음
  try {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb.from('entitlements')
      .select('plan, ls_status, portal_url, ends_at').eq('user_id', user.id).maybeSingle();
    if (error) throw new Error(error.message);
    return Response.json({
      billing: data ? { plan: data.plan, status: data.ls_status ?? null, portal: data.portal_url ?? null, endsAt: data.ends_at ?? null } : null,
    });
  } catch (e) {
    console.error('[argo] me/billing 조회 실패:', e?.message ?? e);
    return Response.json({ billing: null }); // 조회 실패로 설정 화면을 깨지 않는다 — 배너만 사라진다
  }
}
