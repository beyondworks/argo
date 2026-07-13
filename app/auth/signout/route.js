// 로그아웃 — 세션 쿠키 제거 후 로그인 화면으로.
import { NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { publicUrl } from '../../http-origin.mjs';

// CSRF 방어 — same-origin(Origin/Referer가 요청 host와 일치)만 허용. 크로스사이트 강제 로그아웃 차단.
function sameOrigin(req) {
  const src = req.headers.get('origin') || req.headers.get('referer');
  if (!src) return false; // Origin·Referer 없는 크로스 요청은 거부
  try { return new URL(src).host === req.headers.get('host'); } catch { return false; }
}

export async function POST(req) {
  if (!sameOrigin(req)) return NextResponse.json({ error: '잘못된 요청' }, { status: 403 });
  const res = NextResponse.redirect(publicUrl(req, '/login'), { status: 303 });
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return NextResponse.redirect(publicUrl(req, '/'), { status: 303 });
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
  await supabase.auth.signOut().catch(() => {});
  return res;
}
