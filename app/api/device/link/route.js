// 기기 링크 — 이미 발급된 Supabase 세션(access+refresh)을 검증해 기기 파일로 귀속시킨다.
// 사용처: 앱 브라우저 핸드오프(claim 결과), 헤드리스 E2E. 토큰 검증 실패 = 401.
import { createClient } from '@supabase/supabase-js';
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { AUTH_ON, isLoopbackHost } from '../../../auth.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 링크가 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 기기 링크를 쓸 수 없습니다' }, { status: 403 });
    // 루프백 한정 — 공개 호스트에서 기기 파일에 쓰면 미들웨어가 마커를 인정하지 않아 로그인 루프가 생긴다.
    if (!isLoopbackHost(req.headers.get('host'))) return Response.json({ error: '기기 링크는 로컬에서만 가능합니다' }, { status: 403 });
    const { access_token, refresh_token } = await req.json();
    if (!access_token || !refresh_token) return Response.json({ error: '토큰이 필요합니다' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: { user }, error } = await sb.auth.getUser(access_token); // 토큰 진위 검증
    if (error || !user) return Response.json({ error: '유효하지 않은 세션입니다' }, { status: 401 });
    await saveDeviceSession({ url, anonKey, session: { access_token, refresh_token, expires_at: 0, user } }); // expires 0 = 첫 사용 시 즉시 회전
    ensureSync();
    return Response.json({ ok: true, user: { id: user.id, email: user.email ?? '' } }, { headers: { 'Set-Cookie': marker() } });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
