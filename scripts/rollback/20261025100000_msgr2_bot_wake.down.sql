-- 되돌림: supabase/migrations/20261025100000_msgr2_bot_wake.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: 깨움 트리거·함수·받기 정책을 지운다. 표·데이터는 바꾸지 않는다(이 마이그레이션은 표를 만들지 않았다).
-- 순서: 엣지(msgr-bot)를 먼저 되돌린 뒤 이 파일. 새 엣지는 깨움 채널에 들어간 뒤 방송이 오지 않으면 롱폴 끝까지 기다리므로,
--   이 파일만 먼저 실행하면 새 일이 봇에게 가기까지 최악 롱폴 한 번(옛 어댑터 58초, 새 어댑터 140초)이 걸린다(받기는 계속된다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261025100000_msgr2_bot_wake.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop trigger if exists msgr2_bot_wake on public.msgr2_works;
drop function if exists public._msgr2_bot_wake();
drop function if exists public._msgr2_bot_wake_topic(text);
drop policy if exists msgr2_bot_wake_recv on realtime.messages;
commit;
