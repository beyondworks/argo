-- 되돌림: supabase/migrations/20261018052000_msgr2_migration_window.sql(이전 작업 창 동안 옛 계정 삭제·보관 조직 영구 삭제 막기)을 걷어 낸다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 감싸개를 지우고, 이름을 바꿔 둔 원래 함수를 원래 이름·원래 권한으로 되돌린다. 데이터는 바꾸지 않는다.
-- 표지(msgr_settings 'msgr2_migration_window')가 남아 있으면 멈춘다 — 이전 작업 창이 열린 채 막기만 사라지는 것을 막는다(먼저 표지를 지운다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018052000_msgr2_migration_window.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $g$ begin
  if exists (select 1 from public.msgr_settings where key = 'msgr2_migration_window') then
    raise exception 'msgr2_rollback_window_open: msgr_settings msgr2_migration_window 표지가 있다(먼저 지운다)'; end if;
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    drop function public.msgr_delete_me();
    alter function public._msgr_delete_me_body() rename to msgr_delete_me;
  end if;
  if to_regprocedure('public._msgr_purge_orgs_body()') is not null then
    drop function public.msgr_purge_orgs();
    alter function public._msgr_purge_orgs_body() rename to msgr_purge_orgs;
  end if;
end $g$;
-- 원래 권한(20261012160000과 같다)
revoke all on function public.msgr_delete_me() from public, anon;
grant execute on function public.msgr_delete_me() to authenticated;
revoke all on function public.msgr_purge_orgs() from public, anon, authenticated;
drop function if exists public._msgr2_migration_window();
commit;
