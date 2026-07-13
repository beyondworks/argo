// 이메일 토큰 확인 지점 — token_hash(매직링크·이메일 템플릿의 {{ .TokenHash }})를 세션으로 교환.
// /auth/callback(?code= PKCE)과 상호보완 — 관리자 발급 링크·커스텀 템플릿은 이 경로를 쓴다.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from '../../http-origin.mjs';

export async function GET(req) {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type') ?? 'email';
  if (!tokenHash || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.redirect(publicUrl(req, '/login'));
  }
  const res = NextResponse.redirect(publicUrl(req, '/'));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => { for (const { name, value, options } of list) res.cookies.set(name, value, options); },
      },
    },
  );
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) return NextResponse.redirect(publicUrl(req, '/login'));
  return res;
}
