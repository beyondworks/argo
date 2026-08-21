// 기기 로그인 — OTP 검증을 서버가 수행하고 세션을 기기 파일에만 저장한다(브라우저에 세션 없음 —
// refresh 토큰 단일 소유자 원칙). 성공 시 동기화가 재시작 없이 기동된다.
import { createClient } from '@supabase/supabase-js';
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { guestModeOn } from '../../../../src/gueststate.mjs';
import { claimLocalToAccount } from '../../../../src/accountclaim.mjs';
import { AUTH_ON, isLoopbackHost } from '../../../auth.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
const dropGuest = () => 'argo-guest=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

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
    // 게스트(로컬 전용)로 쓰다가 로그인 — 같은 사람의 이어짐이다. 회사·계정 자격을 이 계정으로 자동 귀속
    // (유건 지시 2026-08-21: 새 계정으로 인식하지 말고 그대로 이어서). 루프백·비워커는 위에서 보장.
    // 실패해도 로그인은 성공으로 둔다 — 홈의 수동 귀속 배너가 남은 것을 받는다(조용한 소실 금지).
    let claimed = null;
    if (guestModeOn()) claimed = await claimLocalToAccount(data.session.user.id).catch((e) => ({ error: String(e?.message ?? e) }));
    ensureSync(); // 자격이 방금 생겼다 — 재시작 없이 동기화 기동
    const headers = new Headers();
    headers.append('Set-Cookie', marker());
    headers.append('Set-Cookie', dropGuest()); // 게스트 마커 쿠키 제거 — 이후 미들웨어는 실세션 경로만
    return Response.json(
      { ok: true, user: { id: data.session.user.id, email: data.session.user.email ?? '' }, claimed },
      { headers },
    );
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
