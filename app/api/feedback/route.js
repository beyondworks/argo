// 베타 피드백 — 인앱 폼(FeedbackModal)이 POST. 로그인 사용자 컨텍스트로 Supabase feedback 테이블에 insert.
// 브라우저(메일앱)를 열지 않는다. 메일 API 키 불필요. user_id는 DB default auth.uid()가 채운다.
// 세션 출처는 currentUser와 같은 우선순위 — 기기 연동 모드는 쿠키가 없다(기기 파일이 세션의 단일 소유자,
// devicesession.mjs). 쿠키 클라이언트로만 insert하면 anon이 되어 RLS(42501)에 걸린다.
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';
import { AUTH_ON, currentUser } from '../../auth.mjs';
import { getFreshDeviceSession } from '../../../src/devicesession.mjs';
import { createFeedbackIssue } from '../../../src/feedback-issue.mjs';

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
  // 참조번호는 **우리가 만든다** — insert().select()로 행 id를 되받으면 select RLS에 묶여
  // 정책 하나 바뀔 때 저장까지 실패로 보고된다(쓰기는 됐는데 사용자는 실패로 안다).
  // 이슈에는 이 ref만 나가고 이메일은 Supabase에만 남는다(레포 public).
  const ref = randomBytes(4).toString('hex');
  const ua = (req.headers.get('user-agent') || '').slice(0, 200) || null;
  const { error } = await supabase.from('feedback').insert({
    message: clean,
    email: user.email || null,
    meta: { ua, ref },
  });
  if (error) {
    console.error('[argo] feedback insert 실패:', error.code ?? '', error.message);
    return Response.json({ error: '저장에 실패했습니다. 잠시 후 다시 시도해 주세요' }, { status: 500 });
  }
  // 깃헙 이슈는 **사본**이다 — 실패해도 제보는 이미 저장됐으므로 성공으로 답한다.
  // 토큰이 없으면 skipped로 조용히 지나간다(기능 꺼짐이 기본값).
  const mirrored = await createFeedbackIssue({ message: clean, ref, ua });
  if (!mirrored.ok && !mirrored.skipped) console.error('[argo] feedback 이슈 미러링 실패:', mirrored.status ?? mirrored.error ?? '');
  return Response.json({ ok: true });
}
