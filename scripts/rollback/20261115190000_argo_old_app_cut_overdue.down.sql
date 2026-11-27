-- 되돌림: supabase/migrations/20261115190000_argo_old_app_cut_overdue.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: 5분 cron 'argo-old-app-cut-overdue'를 해제하고 함수 argo_old_app_cut_overdue를 지운다. 부분 색인 argo_old_app_sessions_open_due도 지운다.
--   argo_old_app_check·관문 함수·표·스위치·등록(pgrst.db_pre_request)은 이 마이그레이션이 바꾸지 않았으므로 건드리지 않는다.
--   이미 끊긴 세션은 되살아나지 않는다(다시 로그인하면 된다). 표시 기록(cut_at)도 그대로 둔다(기록이다).
-- 스위치만 끄면(delete from public.msgr_settings where key = 'old_app_cutoff') 이 cron도 아무것도 하지 않는다 — 장치 전체를 멈추는 더 넓은 조치다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261115190000_argo_old_app_cut_overdue.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then -- pg_cron이 없는 곳(로컬 PG 시험)에서는 cron.job 표 자체가 없다
    if exists (select 1 from cron.job where jobname = 'argo-old-app-cut-overdue') then
      perform cron.unschedule('argo-old-app-cut-overdue');
    end if;
  end if;
end $$;
drop function if exists public.argo_old_app_cut_overdue();
drop index if exists public.argo_old_app_sessions_open_due;
commit;
