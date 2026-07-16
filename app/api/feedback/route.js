// 베타 피드백 — 인앱 폼(FeedbackModal)이 POST. 로그인 사용자 컨텍스트(쿠키)로 Supabase feedback 테이블에 insert.
// 브라우저(메일앱)를 열지 않는다. 메일 API 키 불필요. user_id는 DB default auth.uid()가 채운다.
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { AUTH_ON, currentUser } from '../../auth.mjs';

export async function POST(req) {
  if (!AUTH_ON) return Response.json({ error: '클라우드 모드(로그인)에서만 피드백을 보낼 수 있습니다' }, { status: 400 });
  const user = await currentUser();
  if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
  const { message } = await req.json().catch(() => ({}));
  const clean = String(message ?? '').trim().slice(0, 4000);
  if (!clean) return Response.json({ error: '내용이 필요합니다' }, { status: 400 });
  const store = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 */ } } },
  );
  const { error } = await supabase.from('feedback').insert({
    message: clean,
    email: user.email || null,
    meta: { ua: (req.headers.get('user-agent') || '').slice(0, 200) || null },
  });
  if (error) return Response.json({ error: '저장에 실패했습니다. 잠시 후 다시 시도해 주세요' }, { status: 500 });
  return Response.json({ ok: true });
}
