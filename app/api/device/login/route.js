// 기기 로그인 — OTP 검증을 서버가 수행하고 세션을 기기 파일에만 저장한다(브라우저에 세션 없음 —
// refresh 토큰 단일 소유자 원칙). 성공 시 동기화가 재시작 없이 기동된다.
import { createClient } from '@supabase/supabase-js';
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { AUTH_ON, isLoopbackHost } from '../../../auth.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 로그인이 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 기기 로그인을 쓸 수 없습니다' }, { status: 403 });
    // 루프백 한정 — 공개 호스트에서 기기 파일에 쓰면 미들웨어가 마커를 인정하지 않아 로그인 루프가 생긴다.
    if (!isLoopbackHost(req.headers.get('host'))) return Response.json({ error: '기기 로그인은 로컬에서만 가능합니다' }, { status: 403 });
    const { email, token } = await req.json();
    if (!email?.trim() || !token?.trim()) return Response.json({ error: '이메일과 코드가 필요합니다' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const sb = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await sb.auth.verifyOtp({ email: email.trim(), token: token.trim(), type: 'email' });
    if (error || !data?.session) return Response.json({ error: error?.message || '코드가 올바르지 않습니다' }, { status: 401 });
    await saveDeviceSession({ url, anonKey, session: data.session });
    ensureSync(); // 자격이 방금 생겼다 — 재시작 없이 동기화 기동
    return Response.json(
      { ok: true, user: { id: data.session.user.id, email: data.session.user.email ?? '' } },
      { headers: { 'Set-Cookie': marker() } },
    );
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
