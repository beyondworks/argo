// 이메일 토큰 확인 지점 — token_hash(매직링크·이메일 템플릿의 {{ .TokenHash }})를 세션으로 교환.
// /auth/callback(?code= PKCE)과 상호보완 — 관리자 발급 링크·커스텀 템플릿은 이 경로를 쓴다.
// 기기 연동 배선은 /auth/callback과 동일 구조를 미러링한다(회전 충돌 금지 — 세션의 단일 소유자는 기기 파일).
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from '../../http-origin.mjs';
import { saveDeviceSession } from '../../../src/devicesession.mjs';
import { ensureSync } from '../../../src/sync.mjs';
import { isLoopbackHost } from '../../auth.mjs';

export async function GET(req) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') ?? 'email';
  if (!tokenHash || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.redirect(publicUrl(req, '/login'));
  }
  const res = NextResponse.redirect(publicUrl(req, '/'));
  const isWorker = !!process.env.ARGO_TENANT_OWNER?.trim();
  // 기기 연동 모드는 비워커+루프백(로컬 기기)일 때만 — 공개 호스트의 비워커 배포는 기존 쿠키 모델로 폴백.
  const useDevice = !isWorker && isLoopbackHost(req.headers.get('host'));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        // 회전 충돌 금지 — 기기 연동 모드에서는 세션 쿠키를 아예 남기지 않는다(기기 파일이 단일 소유자).
        setAll: useDevice
          ? () => {}
          : (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
      },
    },
  );
  const { data, error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) return NextResponse.redirect(publicUrl(req, '/login'));
  // 기기 연동 — 이메일 매직링크(token_hash) 로그인도 기기 파일이 세션의 단일 소유자가 된다.
  if (useDevice && data?.session) {
    await saveDeviceSession({
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      session: data.session,
    });
    ensureSync(); // 자격이 방금 생겼다 — 재시작 없이 동기화 기동
    res.cookies.set('argo-device', '1', { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
  }
  return res;
}
