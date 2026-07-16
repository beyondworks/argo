// 베타 피드백 — 인앱 폼(FeedbackModal)이 POST. 로그인 사용자 컨텍스트로 Supabase feedback 테이블에 insert.
// 브라우저(메일앱)를 열지 않는다. 메일 API 키 불필요. user_id는 DB default auth.uid()가 채운다.
// 세션 출처는 currentUser와 같은 우선순위 — 기기 연동 모드는 쿠키가 없다(기기 파일이 세션의 단일 소유자,
// devicesession.mjs). 쿠키 클라이언트로만 insert하면 anon이 되어 RLS(42501)에 걸린다.
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { getFreshDeviceSession } from '../../../src/devicesession.mjs';

export async function POST(req) {
  if (!AUTH_ON) return Response.json({ error: '클라우드 모드(로그인)에서만 피드백을 보낼 수 있습니다' }, { status: 400 });
  const user = await currentUser();
  if (!user) return Response.json({ error: '로그인이 필요합니다' }, { status: 401 });
  const { message } = await req.json().catch(() => ({}));
  const clean = String(message ?? '').trim().slice(0, 4000);
  if (!clean) return Response.json({ error: '내용이 필요합니다' }, { status: 400 });
  let supabase = null;
  if (!process.env.ARGO_TENANT_OWNER?.trim()) {
    const sess = await getFreshDeviceSession(); // 만료 임박 시 자체 회전(단일 소유자 락)
    if (sess) {
      supabase = createClient(sess.url, sess.anonKey, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${sess.access_token}` } },
      });
    }
  }
  if (!supabase) {
    const store = await cookies();
    supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      { cookies: { getAll: () => store.getAll(), setAll: () => { /* 라우트에서는 세션 갱신 안 함 */ } } },
    );
  }
  const { error } = await supabase.from('feedback').insert({
    message: clean,
    email: user.email || null,
    meta: { ua: (req.headers.get('user-agent') || '').slice(0, 200) || null },
  });
  if (error) {
    console.error('[argo] feedback insert 실패:', error.code ?? '', error.message);
    return Response.json({ error: '저장에 실패했습니다. 잠시 후 다시 시도해 주세요' }, { status: 500 });
  }
  return Response.json({ ok: true });
}
