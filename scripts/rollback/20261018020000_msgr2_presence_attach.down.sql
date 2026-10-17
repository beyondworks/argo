-- 되돌림: supabase/migrations/20261018020000_msgr2_presence_attach.sql(U6b — 접속 표시 토픽 권한·첨부 표지 방송)을 걷어 낸다. 표는 만들지 않았다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U6b → U2b → U2 → U3 → U1.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018020000_msgr2_presence_attach.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
revoke select (source_message_id, root_user_id, parent_work_id) on public.msgr2_works from authenticated;
drop policy if exists msgr2_presence_recv on realtime.messages;
drop policy if exists msgr2_presence_track on realtime.messages;
drop trigger if exists msgr2_on_attachment_broadcast on public.msgr2_attachments;
drop function if exists public.msgr2_on_attachment_broadcast();
drop function if exists public._msgr2_fanout(uuid, text, jsonb);
drop function if exists public._msgr2_rt_presence_ok(text, text);
notify pgrst, 'reload schema';
commit;
