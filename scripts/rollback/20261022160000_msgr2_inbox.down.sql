-- 되돌림: supabase/migrations/20261022160000_msgr2_inbox.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: 함수 msgr2_inbox 하나를 지운다. 표·인덱스·다른 함수·권한은 이 마이그레이션이 바꾸지 않았으므로 건드리지 않는다.
-- 메신저 화면이 아직 이 함수를 쓰지 않으면(1단계) 사용자 영향은 없다. 2단계 화면이 쓰기 시작한 뒤라면 화면을 먼저 되돌린다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261022160000_msgr2_inbox.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr2_inbox(int, boolean, timestamptz, uuid);
commit;
