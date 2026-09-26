-- 크루 작업 중단(유건 확정 2026-09-26): 그 턴을 시킨 사람(원본 메시지 작성자) 또는 그 크루의 주인만
-- 진행 중인 실행을 멈출 수 있다. 서버가 권한을 강제하고(RLS/RPC 재검증, 화면 숨김만으로는 부족),
-- 크루 소유자의 게이트웨이가 이미 구독하는 org:<org_id> 방송으로 깨운다(drain()의 message/approval/crew_request와 같은 토픽).
-- 중복 요청은 쓰기 0(DB 위생 규칙) — stop_requested_at이 이미 있으면 UPDATE 없이 true만 돌려준다.
alter table public.msgr_executions
  add column if not exists stop_requested_at timestamptz,
  add column if not exists stop_requested_by uuid references auth.users(id) on delete set null;

create or replace function public.msgr_request_stop(p_crew uuid, p_source bigint)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.msgr_crews; e public.msgr_executions; src public.msgr_messages; sender uuid; upd int;
begin
  if auth.uid() is null then raise exception 'msgr_not_allowed' using errcode = '42501'; end if;
  select * into c from public.msgr_crews where id = p_crew;
  select * into src from public.msgr_messages where id = p_source;
  if c.id is null or src.id is null then raise exception 'msgr_not_allowed' using errcode = '42501'; end if;
  -- 시킨 사람 = 원본 메시지가 사람 글이면 그 사람, 크루 넘김 글이면 그 크루의 주인(브리지 msgr_delivery_allowed와 같은 sender 규칙).
  if src.author_kind = 'user' then sender := src.author_user_id;
  elsif src.author_kind = 'crew' then select owner_user_id into sender from public.msgr_crews where id = src.crew_id;
  else sender := null; end if;
  -- 권한 판정을 실행 존재 여부 확인보다 먼저 한다 — 없는 실행의 상태를 미승인 호출자에게 흘리지 않는다.
  if auth.uid() is distinct from c.owner_user_id and auth.uid() is distinct from sender then
    raise exception 'msgr_not_allowed' using errcode = '42501';
  end if;
  select * into e from public.msgr_executions where crew_id = p_crew and source_msg_id = p_source for update;
  if e.crew_id is null or e.state <> 'running' then return false; end if; -- 끝났거나 없는 실행 — 조용히 무시(요구사항: 이미 끝난 턴은 무시)
  if e.stop_requested_at is not null then return true; end if; -- 이미 요청됨 — 재요청은 쓰기 0
  update public.msgr_executions set stop_requested_at = now(), stop_requested_by = auth.uid()
    where crew_id = p_crew and source_msg_id = p_source and state = 'running' and stop_requested_at is null;
  get diagnostics upd = row_count;
  if upd > 0 then -- 실제로 이 호출이 처음 기록했을 때만 깨우기 신호(경합에서 진 재시도는 방송하지 않는다)
    perform realtime.send(jsonb_build_object('crew_id', p_crew, 'source_msg_id', p_source), 'stop_request', 'org:' || c.org_id::text, true);
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
notify pgrst, 'reload schema';
