-- 되돌림: supabase/migrations/20261018010000_msgr2_realtime_storage.sql(U2b — 방송·토픽 권한·Storage 정책·보존 함수)를 걷어 낸다. 표는 만들지 않았으므로 지우는 표가 없다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U2b → U2 → U3 → U1. 앞 단위가 남아 있으면 그 단위를 먼저 되돌린다.
-- 빈 표만 지운다 — 행이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(기억 데이터·기록 보존, CLAUDE.md DB 위생 1). storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018010000_msgr2_realtime_storage.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop policy if exists msgr2_realtime_recv on realtime.messages;
drop policy if exists msgr2_files_select on storage.objects;
drop policy if exists msgr2_files_insert on storage.objects;
drop policy if exists msgr2_files_update on storage.objects;
drop trigger if exists msgr2_on_message_broadcast on public.msgr2_messages;
drop trigger if exists msgr2_on_user_gen on public.msgr2_user_gen;
do $t$ begin
  if to_regclass('public.msgr_settings') is not null then drop trigger if exists msgr2_on_pause_setting on public.msgr_settings; end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then -- cron.job은 확장이 있을 때만 있다(같은 if에 두면 확장 없는 DB에서 오류)
    if exists (select 1 from cron.job where jobname = 'msgr2-retention-prune') then perform cron.unschedule('msgr2-retention-prune'); end if;
  end if;
end $t$;
do $d$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array['_msgr2_msg_payload', '_msgr2_room_humans', '_msgr2_rt_topic_ok', '_msgr2_send_s', '_msgr2_send_u', '_msgr2_storage_read', '_msgr2_storage_room', '_msgr2_storage_write', 'msgr2_on_message_broadcast', 'msgr2_on_pause_setting', 'msgr2_on_user_gen', 'msgr2_retention_prune']) loop
    execute format('drop function %s', f);
  end loop;
end $d$;
notify pgrst, 'reload schema';
commit;
