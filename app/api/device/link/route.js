// 기기 링크 — 이미 발급된 Supabase 세션(access+refresh)을 검증해 기기 파일로 귀속시킨다.
// 사용처: 앱 브라우저 핸드오프(claim 결과), 헤드리스 E2E. 토큰 검증 실패 = 401.
import { saveDeviceSession } from '../../../../src/devicesession.mjs';
import { ensureSync } from '../../../../src/sync.mjs';
import { guestModeOn } from '../../../../src/gueststate.mjs';
import { claimLocalToAccount } from '../../../../src/accountclaim.mjs';
import { AUTH_ON, isLoopbackHost, csrfDenied } from '../../../auth.mjs';
import { verifyAccessToken, linkFailure, describeFailure } from '../../../../src/auth-error.mjs';

const marker = () => `argo-device=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;

export async function POST(req) {
  try {
    // 교차 사이트 단순 요청(text/plain) 차단 — 악성 페이지가 자기 계정 토큰을 루프백으로 보내 이 기기를 그 계정에 묶고 게스트 회사까지 귀속시키지 못하게(2026-10-28 분리 검수).
    // 앱 로그인 화면의 fetch는 같은 출처(same-origin)라 통과, 헤더 없는 비브라우저 호출도 종전대로 통과(authmsg.mjs csrfDenied).
    const csrf = csrfDenied(req); if (csrf) return csrf;
    if (!AUTH_ON) return Response.json({ error: '로컬 모드에서는 링크가 필요 없습니다' }, { status: 400 });
    if (process.env.ARGO_TENANT_OWNER?.trim()) return Response.json({ error: '워커 인스턴스에서는 기기 링크를 쓸 수 없습니다' }, { status: 403 });
    // 루프백 한정 — 공개 호스트에서 기기 파일에 쓰면 미들웨어가 마커를 인정하지 않아 로그인 루프가 생긴다.
    if (!isLoopbackHost(req.headers.get('host'))) return Response.json({ error: '기기 링크는 로컬에서만 가능합니다' }, { status: 403 });
    const { access_token, refresh_token } = await req.json();
    if (!access_token || !refresh_token) return Response.json({ error: '토큰이 필요합니다' }, { status: 400 });
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    // 토큰 진위 검증 — 연결 실패(이 컴퓨터가 로그인 서버에 못 닿음, 502)와 토큰 거부(401)를 나눠 알린다. 로그에는 토큰 없이 오류 이름·status·code만.
    const { user, failure } = await verifyAccessToken({ url, anonKey, accessToken: access_token });
    if (failure) {
      console.warn(`[device/link] ${describeFailure(failure)}`);
      const { status, body } = linkFailure(failure);
      return Response.json(body, { status });
    }
    await saveDeviceSession({ url, anonKey, session: { access_token, refresh_token, expires_at: 0, user } }); // expires 0 = 첫 사용 시 즉시 회전
    // 게스트 → 로그인 자동 귀속 — 앱의 구글·깃허브 로그인(브라우저 핸드오프)이 이 라우트로 끝난다. device/login·auth/callback과 같은 계약(accountclaim.mjs).
    // 빠져 있어 앱으로 로그인한 사용자의 게스트 회사는 주인 없음으로 남아 동기화 대상 밖이었다(2026-10-28 고객 C: .guest-mode.json enabled:true 잔존).
    // 실패해도 로그인은 성공 — 홈 배너·설정 동기화 카드의 [이 계정에 연결]이 남은 것을 받는다.
    let claimed = null;
    if (guestModeOn()) claimed = await claimLocalToAccount(user.id).catch((e) => ({ error: String(e?.message ?? e) }));
    ensureSync();
    return Response.json({ ok: true, user: { id: user.id, email: user.email ?? '' }, claimed }, { headers: { 'Set-Cookie': marker() } });
  } catch (e) {
    return Response.json({ error: String(e.message || e) }, { status: 400 });
  }
}
