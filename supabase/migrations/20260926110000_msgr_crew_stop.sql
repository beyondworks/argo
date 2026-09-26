-- 크루 작업 중단(유건 확정 2026-09-26, 분리 검수 반영 2026-09-26·2차 2026-09-26): 그 턴을 시킨 사람(원본 메시지 작성자 —
-- 크루 넘김이면 그 턴을 처음 지시한 사람(meta->>'origin')과 스레드 뿌리의 최초 지시자 모두, 총괄 결정 L-6·재검수 M-A)
-- 또는 그 크루의 주인만 진행 중인 실행을 멈출 수 있다. "넘긴 크루의 주인" 자체는 허용자가 아니다 — 유건님이 정한
-- 규칙은 "시킨 사람과 크루 주인만"이고 넘긴 크루의 주인은 둘 다 아니기 때문(재검수 2026-09-26 M-A).
-- 서버가 권한을 강제하고(RPC 재검증, 화면 숨김만으로는 부족),
-- **크루 소유자 본인의 u:<owner_user_id> 방송**으로 깨운다 — org:<org_id>였다면 그 조직 멤버 누구나
-- msgr_realtime_send(org:% 발신 허용)로 위조 방송을 보내 남의 크루 턴을 멈출 수 있었다(검수 H-1).
-- u:<uid>는 RLS 수신 정책만 있고 발신 정책이 없어(20260918184500) 클라이언트가 남의 u:는커녕 자기 u:로도 쓰지 못한다 —
-- 오직 이 함수(security definer의 realtime.send)만 쓸 수 있다.
-- 중복 요청은 쓰기 0(DB 위생 규칙) — stop_requested_at이 이미 있으면 UPDATE 없이 true만 돌려준다.
-- 원본 작성자·뿌리 지시자 판정에는 지금도 조직 멤버이고 그 채널을 읽을 수 있어야 한다는 조건을 더한다(검수 L-1) —
-- 나간 멤버가 예전 지시로 계속 멈출 수 있던 구멍. 봇 크루(hosting='bot')는 이번 범위 밖이라 기록·방송 없이 false —
-- 이 판정은 권한 검사를 통과한 뒤에만 한다. 앞에 두면 권한 없는 호출자도 크루가 봇인지 탐지할 수 있다(재검수 2026-09-26 L-a).
alter table public.msgr_executions
  add column if not exists stop_requested_at timestamptz,
  add column if not exists stop_requested_by uuid references auth.users(id) on delete set null;

create or replace function public.msgr_request_stop(p_crew uuid, p_source bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.msgr_crews; e public.msgr_executions; src public.msgr_messages; sender uuid; root_author uuid; allowed boolean; upd int;
begin
  if auth.uid() is null then raise exception 'msgr_not_allowed' using errcode = '42501'; end if;
  select * into c from public.msgr_crews where id = p_crew;
  select * into src from public.msgr_messages where id = p_source;
  if c.id is null or src.id is null then raise exception 'msgr_not_allowed' using errcode = '42501'; end if;
  -- 시킨 사람 = 원본 메시지가 사람 글이면 그 사람, 크루 넘김 글이면 그 턴을 처음 지시한 사람(meta->>'origin' —
  -- 브리지가 답글에 새기는 값, msgr.mjs metaBase.origin과 같다) + 스레드 뿌리의 최초 지시자(사람 글일 때).
  -- "넘긴 크루의 주인" 자체는 허용자가 아니다(재검수 2026-09-26 M-A). meta.origin이 없거나 uuid가 아니면
  -- (그 관례가 생기기 전 옛 글 등) sender는 null로 두고 거부 쪽으로 — 보수적 실패, 폴백 없음.
  if src.author_kind = 'user' then sender := src.author_user_id;
  elsif src.author_kind = 'crew' then
    begin sender := (src.meta->>'origin')::uuid; exception when invalid_text_representation then sender := null; end;
  end if;
  if src.thread_root is not null then
    select author_user_id into root_author from public.msgr_messages where id = src.thread_root and author_kind = 'user';
  end if;
  -- 권한 판정을 실행 존재 여부 확인보다 먼저 한다 — 없는 실행의 상태를 미승인 호출자에게 흘리지 않는다.
  -- sender·root_author가 null일 때(핸드오프 없는 일반 글, 뿌리를 못 찾음) "= null"은 SQL에서 unknown이라
  -- coalesce 없이 or로 엮으면 allowed 전체가 unknown이 되고, plpgsql의 if는 unknown을 거짓이 아니라 "실행 안 함"으로
  -- 다뤄 거부해야 할 제3자를 그냥 통과시켰다(실측 2026-09-26 pg 드릴: 무관한 제3자가 통과) — 각 항을 boolean으로 접어 막는다.
  allowed := (auth.uid() = c.owner_user_id)
    or (coalesce(auth.uid() = sender, false) and public.msgr_is_member(c.org_id) and public.msgr_can_read_channel(src.channel_id))
    or (coalesce(auth.uid() = root_author, false) and public.msgr_is_member(c.org_id) and public.msgr_can_read_channel(src.channel_id)); -- L-1: 나간 멤버는 옛 지시로도 못 멈춘다
  if not coalesce(allowed, false) then raise exception 'msgr_not_allowed' using errcode = '42501'; end if;
  -- 봇 여부 확인은 권한 판정 뒤에 — 앞에 두면 권한 없는 호출자도 "false(=봇)"와 "예외(=권한 없음)"를
  -- 구분해 크루가 봇인지 탐지할 수 있었다(재검수 2026-09-26 L-a).
  if c.hosting = 'bot' then return false; end if; -- 서버 봇(Hermes·OpenClaw·VPS) 턴은 이번 범위 밖(L-2)
  select * into e from public.msgr_executions where crew_id = p_crew and source_msg_id = p_source for update;
  if e.crew_id is null or e.state <> 'running' then return false; end if; -- 끝났거나 없는 실행 — 조용히 무시(요구사항: 이미 끝난 턴은 무시)
  if e.stop_requested_at is not null then return true; end if; -- 이미 요청됨 — 재요청은 쓰기 0
  update public.msgr_executions set stop_requested_at = now(), stop_requested_by = auth.uid()
    where crew_id = p_crew and source_msg_id = p_source and state = 'running' and stop_requested_at is null;
  get diagnostics upd = row_count;
  if upd > 0 then -- 실제로 이 호출이 처음 기록했을 때만 깨우기 신호(경합에서 진 재시도는 방송하지 않는다)
    perform realtime.send(jsonb_build_object('crew_id', p_crew, 'source_msg_id', p_source), 'stop_request', 'u:' || c.owner_user_id::text, true);
  end if;
  return true;
end $$;
revoke all on function public.msgr_request_stop(uuid, bigint) from public, anon;
grant execute on function public.msgr_request_stop(uuid, bigint) to authenticated;

-- 실행 심박은 브리지가 30초마다 이미 부르는 왕복이다 — 방송을 놓쳐도 다음 심박 안에 중단 요청을 읽는 폴백.
-- 반환 모양이 boolean→jsonb로 바뀐다(호출부는 heartbeatExecution() 반환값을 그동안 쓰지 않았다 — src/gateway/msgr-execution.mjs).
drop function if exists public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid);
create or replace function public.msgr_execution_heartbeat(p_ws text, p_crew uuid, p_source bigint, p_channel uuid, p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare ok boolean; stop_req boolean;
begin
  perform public.msgr_execution_source(p_ws, p_crew, p_source, p_channel);
  update public.msgr_executions set heartbeat_at = now()
    where crew_id = p_crew and source_msg_id = p_source and attempt = p_attempt and state = 'running';
  ok := found;
  select (stop_requested_at is not null) into stop_req from public.msgr_executions
    where crew_id = p_crew and source_msg_id = p_source and attempt = p_attempt;
  return jsonb_build_object('ok', ok, 'stop_requested', coalesce(stop_req, false));
end $$;
revoke all on function public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid) from public, anon;
grant execute on function public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid) to authenticated;
grant execute on function public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid) to service_role; -- 재검수 2026-09-26: 상주 노드 등 서비스 계정 경로도 명시적으로 허용
notify pgrst, 'reload schema';
