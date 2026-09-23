-- 메시지 작성 시각은 서버가 정한다(재검수 #689 LOW, 2026-09-24): 멤버가 created_at을 과거로 넣은 글과 진행 중 트랜잭션의 멘션이 겹치면,
-- 봇 커서 전진(20260923200000_msgr_bot_cursor_skip.sql — "10분 넘은 글까지만")이 그 과거 글을 기준으로 늦게 커밋된 낮은 id의 멘션을 건너뛰었다(재현 R).
-- 삽입 때만 now()로 덮는다 — 앱·브리지·SQL 어디도 created_at을 지정해 넣지 않는다(2026-09-24 전수 수색). 이후 update는 막지 않는다(운영 도구·테스트의 시각 조정).
create or replace function public.msgr_messages_server_time() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  new.created_at := now();
  return new;
end $$;
drop trigger if exists msgr_messages_server_time on public.msgr_messages;
create trigger msgr_messages_server_time before insert on public.msgr_messages for each row execute function public.msgr_messages_server_time();
