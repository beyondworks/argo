-- 되돌림: supabase/migrations/20261016171000_msgr_pause_push.sql의 함수만 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- msgr_push_broadcasts 표는 남긴다(발송 기록 — 지우지 않는다. 정책 없는 표라 사용자에게는 보이지 않는다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261016171000_msgr_pause_push.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr_pause_push(text, text, text, text);
notify pgrst, 'reload schema';
commit;
