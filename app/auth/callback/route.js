// 매직링크·OAuth 복귀 지점 — 코드를 세션 쿠키로 교환하고 홈으로 보낸다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from '../../http-origin.mjs';
import { saveDeviceSession } from '../../../src/devicesession.mjs';
import { ensureSync } from '../../../src/sync.mjs';
import { isLoopbackHost } from '../../auth.mjs';

export async function GET(req) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const providerErr = url.searchParams.get('error_description') || url.searchParams.get('error');
  const fail = (msg) => NextResponse.redirect(publicUrl(req, `/login?error=${encodeURIComponent(String(msg).slice(0, 120))}`));
  // 실패를 조용히 삼키지 않는다 — /login?error= 로 보내 화면에 노출(진단 가능하게)
  if (providerErr) return fail(providerErr);
  if (!code || !process.env.NEXT_PUBLIC_SUPABASE_URL) return fail('no_code');
  const res = NextResponse.redirect(publicUrl(req, '/'));
  const isWorker = !!process.env.ARGO_TENANT_OWNER?.trim();
  // 기기 연동 모드는 비워커+루프백(로컬 기기)일 때만 — 공개 호스트의 비워커 배포는 기존 쿠키 모델로 폴백해
  // 로그인 루프를 막는다(미들웨어가 마커를 루프백에서만 인정하므로).
  const useDevice = !isWorker && isLoopbackHost(req.headers.get('host'));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        // 회전 충돌 금지 — 기기 연동 모드에서는 세션 쿠키를 아예 남기지 않는다(기기 파일이 단일 소유자).
        // 워커(TENANT) 또는 비루프백은 기존 쿠키 경로를 그대로 유지한다(회귀 0).
        setAll: useDevice
          ? () => {}
          : (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
      },
    },
  );
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return fail(error.message);
  // 기기 연동 — OAuth 로그인도 기기 파일이 세션의 단일 소유자가 된다(브라우저는 세션 쿠키를 아예 받지 않는다).
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
