-- 쉬는 VPS 봇의 호출 줄이기(유건 2026-10-25 "vps에서 오는 호출도 줄여야 하는데", 총괄 지시) — DB 쪽: 새 일이 생기면 그 봇에게 "깨움" 방송 하나.
-- 지금: 엣지(msgr-bot v2.js)가 롱폴(최대 50초) 동안 5초마다 msgr2_bot_updates를 불러 쉬는 봇 1개 = RPC 분당 12회(요청마다 API 로그 1줄 — 10/13 로그 과금 사고와 같은 종류).
-- 바뀐 뒤: 엣지는 롱폴을 시작할 때 RPC 1회만 부르고, 그 뒤로는 이 방송을 기다렸다가 왔을 때만 다시 부른다(오지 않으면 RPC 없이 빈 응답).
--   새 일 → 봇이 받기까지의 지연은 늘지 않는다(방송 지연 ≈ 수백 ms). 방송을 놓쳐도 다음 롱폴 시작의 RPC가 찾는다(최악 = 롱폴 한 번 길이).
-- 토픽: 'botw:' || sha256('wake:' || 토큰 해시) — 토큰을 아는 엣지만 이름을 계산할 수 있다(토큰 해시는 DB에만, 토큰 원문은 봇·엣지에만). 본문은 빈 객체(일 내용·방 id 없음).
--   비공개 채널(private)이고, 받기 정책은 anon(엣지는 anon 키로 듣는다)에게 이 모양의 토픽만 연다 — 이름을 모르면 들을 수 없다.
-- 쓰기: 일이 offered로 만들어질 때 그 에이전트에 살아 있는 봇이 있으면 realtime.send 1회(일 1개당 1행). 쉬는 동안 쓰기 0(트리거는 일이 생길 때만 돈다).
-- 방송 실패는 일 만들기를 막지 않는다(예외를 삼킨다 — 엣지는 다음 롱폴의 RPC로 찾는다).
-- 되돌림: scripts/rollback/20261025100000_msgr2_bot_wake.down.sql(트리거·함수·정책 제거). 순서는 그 파일 머리말.

create or replace function public._msgr2_bot_wake_topic(p_token_hash text) returns text
  language sql immutable set search_path = public, pg_temp as $$
  select 'botw:' || encode(sha256(convert_to('wake:' || coalesce(p_token_hash, ''), 'utf8')), 'hex') $$;
revoke all on function public._msgr2_bot_wake_topic(text) from public, anon, authenticated;

create or replace function public._msgr2_bot_wake() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare h text;
begin
  begin
    select b.token_hash into h from public.msgr2_bots b where b.agent_id = new.agent_id and b.revoked_at is null;
    if h is null then return null; end if; -- 봇이 아닌 에이전트(본체 Argo)의 일 — 본체는 v2:u:<주인> 방송을 따로 받는다
    perform realtime.send('{}'::jsonb, 'wake', public._msgr2_bot_wake_topic(h), true);
  exception when others then null; -- 깨움은 덤이다: 실패해도(표가 되돌려져 없을 때 포함) 일 만들기를 막지 않는다
  end;
  return null;
end $$;
revoke all on function public._msgr2_bot_wake() from public, anon, authenticated;
drop trigger if exists msgr2_bot_wake on public.msgr2_works;
create trigger msgr2_bot_wake after insert on public.msgr2_works
  for each row when (new.state = 'offered') execute function public._msgr2_bot_wake();

-- 받기: anon(엣지)은 깨움 토픽 모양('botw:' + 16진 64자)의 방송만. 다른 v2 토픽(msgr2_realtime_recv — authenticated)은 그대로다.
drop policy if exists msgr2_bot_wake_recv on realtime.messages;
create policy msgr2_bot_wake_recv on realtime.messages for select to anon
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) ~ '^botw:[0-9a-f]{64}$');
