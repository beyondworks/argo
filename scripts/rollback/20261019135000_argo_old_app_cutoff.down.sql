-- 되돌림: supabase/migrations/20261019135000_argo_old_app_cutoff.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 스위치만 끄려면 이 파일이 아니라: delete from public.msgr_settings where key = 'old_app_cutoff';
-- 하는 일: ① 스위치 끄기 ② 요청 전 함수를 아무것도 하지 않는 본문으로 바꾸기(지우지 않는다 — 등록 해제가 PostgREST 인스턴스에
--   반영되기 전에 함수가 없으면 GET을 포함한 모든 Data API 요청이 실패한다) ③ 등록 해제(값이 이 함수일 때만) ④ 관문을 20261013190000 본문으로
--   ⑤ cron 제거. 기록 표 두 개와 빈 함수는 남긴다(정책 없는 표라 사용자에게 보이지 않는다). 빈 함수는 반영을 확인한 뒤 따로 지워도 되고 남겨도 무해하다.
--   이미 폐기된 로그인 세션은 되살아나지 않는다(사용자가 다시 로그인한다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261019135000_argo_old_app_cutoff.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
delete from public.msgr_settings where key = 'old_app_cutoff';
delete from public.msgr_settings where key = 'old_app_cutoff_max'; -- 폐기 기준 버전 설정(2026-10-19)
create or replace function public.argo_old_app_check() returns void language sql as $$ select $$;
revoke all on function public.argo_old_app_check() from public;
grant execute on function public.argo_old_app_check() to anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
              where r.rolname = 'authenticator' and s.setdatabase = 0 and c = 'pgrst.db_pre_request=public.argo_old_app_check') then
    execute 'alter role authenticator reset pgrst.db_pre_request';
  end if;
end $$;
create or replace function public.argo_min_app_version(p_app text default 'desktop') returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select s.value from public.msgr_settings s
     where s.key = case p_app when 'desktop' then 'min_app_version' when 'messenger' then 'min_app_version_messenger' end
$$;
revoke all on function public.argo_min_app_version(text) from public;
grant execute on function public.argo_min_app_version(text) to anon, authenticated, service_role;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then -- cron 스키마가 없는 곳에서 계획 단계 오류가 나지 않게 동적 SQL로
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'purge-argo-app-sessions'$q$;
  end if;
end $$;
commit;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';
