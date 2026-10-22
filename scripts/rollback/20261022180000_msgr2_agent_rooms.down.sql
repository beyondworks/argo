-- 되돌림: supabase/migrations/20261022180000_msgr2_agent_rooms.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: 함수 msgr2_agent_rooms·_msgr2_scope_notify와 'agent.scope' 알림 트리거 4개(+ 트리거 함수)를 지운다. 표·인덱스·다른 함수·권한은 이 마이그레이션이 바꾸지 않았다.
-- 본체가 이 함수를 쓰기 시작한 뒤라면: 본체는 함수가 없으면(오류) 아무것도 지우지 않고, 공간 종류를 못 알면 그 턴 일지를 끈다(fail-closed) — 데이터는 잃지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261022180000_msgr2_agent_rooms.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop trigger if exists msgr2_scope_room_member on public.msgr2_room_members;
drop trigger if exists msgr2_scope_seat on public.msgr2_agent_seats;
drop trigger if exists msgr2_scope_space_member on public.msgr2_space_members;
drop trigger if exists msgr2_scope_space on public.msgr2_spaces;
drop function if exists public.msgr2_scope_on_room_member();
drop function if exists public.msgr2_scope_on_seat();
drop function if exists public.msgr2_scope_on_space_member();
drop function if exists public.msgr2_scope_on_space();
drop function if exists public._msgr2_scope_notify(uuid);
drop function if exists public.msgr2_agent_rooms(uuid[]);
commit;
