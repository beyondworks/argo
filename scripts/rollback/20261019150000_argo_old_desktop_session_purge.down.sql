-- 되돌림: supabase/migrations/20261019150000_argo_old_desktop_session_purge.sql의 함수를 지운다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 표·설정·요청 경로에 걸린 것이 없어 함수만 지우면 끝이다. 이미 지운 로그인 세션은 되살아나지 않는다(사용자가 다시 로그인한다).
-- argo_old_app_sessions에 남은 'bulk-purge …' 행은 #1107 보존 규칙(90일)대로 지워진다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261019150000_argo_old_desktop_session_purge.down.sql
begin;
drop function if exists public.argo_old_desktop_purge_run(int, text);
drop function if exists public.argo_old_desktop_purge_list();
drop function if exists public.argo_old_desktop_purge_preview();
drop function if exists public._argo_old_desktop_classify();
drop function if exists public._argo_old_desktop_digest(uuid[]);
drop function if exists public._argo_old_desktop_ready();
commit;
