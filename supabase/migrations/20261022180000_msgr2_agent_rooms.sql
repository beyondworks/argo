-- 본체 조직 기억 회수(2026-10-22 유건 지시 "본체가 조직 대화를 개인 기억에 섞어 쓰고 조직을 나가도 회수 안 되는 결함부터 고쳐 주세요") — 서버 쪽 두 가지.
-- 설계: side-session-notes body-org-memory-leak-design.md (총괄 결정 D1·D4, 2026-10-22 22:5x KST).
--
-- 1) msgr2_agent_rooms(p_rooms uuid[]) — 읽기 전용. 본체(runner·resident 기기)가 "내 에이전트가 이 방들에 아직 있나"와 방의 공간·종류를 묻는다.
--    본체는 이 답으로 ① 조직(팀) 방 대화를 볼트 밖 조직 칸에 쓰고(공간 종류), ② 빠진 방의 조직 칸·모델 전사를 지운다(agents).
--    · 넣은 방마다 정확히 1행을 돌려준다(중복·null 제거, 최대 500개). 행이 있다 = 서버가 판정했다(명시). 호출이 실패하면 본체는 아무것도 지우지 않는다.
--    · agents = 그 방에서 지금 일할 수 있는 내(auth.uid()) 에이전트 id 목록. 조건(모두):
--        방이 있고 공간이 지워지지 않음, 에이전트가 방의 활동 멤버(removed_at null), 에이전트 주인 = 나, 에이전트가 은퇴하지 않음,
--        팀 공간이면 파견 행이 활동 중이고 내가 그 공간의 활동 멤버(removed_at null·만료 전).
--      주인이 방을 더는 못 읽게 되면 서버가 그 주인 에이전트의 방 멤버 행을 닫는다(_msgr2_space_close 등, 20261020200600) —
--      그래서 조직 탈퇴·방 탈퇴·파견 해제·방에서 빼기가 모두 이 조건으로 판정된다. 손님 만료는 행을 닫지 않으므로 공간 멤버의 expires_at을 따로 본다.
--    · space_id·space_kind는 agents가 비어 있지 않을 때만 준다. 내 에이전트가 없는 방·남의 방·없는 방은 (room, '{}', null, null) — 방이 있는지조차 알리지 않는다.
--    · 기기: 유효한 기기 세션(_msgr2_need_device) 중 runner·resident만(앱 기기는 msgr2_runner_only). Pro 관문·v2 중단은 보지 않는다 — 회수는 무료가 된 뒤에도 돼야 한다.
--    · 쓰기 0(stable). 주기 호출을 만들지 않는다 — 본체가 시작·재연결·아래 알림 때 1번, 처음 보는 방의 첫 일 때 1번 부른다.
-- 2) 'agent.scope' 알림 — 내 에이전트가 방·공간에서 빠지면(에이전트 방 멤버 행·파견 행·내 공간 멤버 행이 닫히거나 지워짐, 손님 기한을 지금 이전으로 당김, 공간 삭제)
--    그 주인의 본체 토픽(v2:w:<uid>)으로 일 없는 봉투 1개를 보낸다(데이터 없음 = "다시 확인하라"). 한 트랜잭션에 여러 행이 닫혀도 사람마다 1번.
--    옛 본체는 모르는 type·일 없는 봉투라 기록만 하고 답하지 않는다(packages/agent-link/link.mjs unknownType, contract unsupportedReply).
--    방송 실패는 무시한다(_msgr2_send_w) — 본체는 다음 시작·재연결 때 따라잡는다. 시각이 지나 손님 기한이 끝나는 것은 사건이 없어 시작·재연결 때만 반영된다(총괄 수용).
-- 부하: 기기 N대 × (시작 + 재연결 + 빠짐 사건). 예) 100대 × 하루 재연결 10회 = 하루 1,000회 ≈ 분당 0.7회. 쓰기 0. 알림 = 빠짐 사건마다 주인 1명당 방송 1회.
-- 되돌림: scripts/rollback/20261022180000_msgr2_agent_rooms.down.sql · 시험: test/msgr2-agent-rooms-pg.test.mjs

-- 0) 봉투 검사(_msgr2_env_check, 마지막 정의 20261020201300)에 agent.scope를 서버 → 본체 type으로 더한다 — 본체가 이 type을 보내면 계약 validateEnvelope와 같이
--    wrong_direction(종전 unsupported_type). 본문은 20261020201300의 것에 그 두 줄만 바꾼 것이다(test/msgr2-work-contract-pg.test.mjs가 계약 예제 전부와 대조).
create or replace function public._msgr2_env_check(e jsonb, p_min_v int, p_max_v int) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare t text; d jsonb; x jsonb; sync boolean;
begin
  if jsonb_typeof(e) is distinct from 'object' then return 'invalid_envelope'; end if;
  if not public._msgr2_j_int(e->'v', 1) then return 'invalid_envelope'; end if;
  if (e->>'v')::numeric < p_min_v or (e->>'v')::numeric > p_max_v then return 'link_version_unsupported'; end if;
  if jsonb_typeof(e->'type') is distinct from 'string' then return 'invalid_envelope'; end if;
  t := e->>'type';
  if t not in ('work.offer', 'work.cancel', 'work.approval_decision', 'work.accept', 'work.progress', 'work.approval_request', 'work.effect',
               'work.result', 'work.error', 'agent.sync', 'agent.scope') then return 'unsupported_type'; end if;
  if octet_length(e::text) > 131072 then return 'too_large'; end if;
  if t in ('work.offer', 'work.cancel', 'work.approval_decision', 'agent.scope') then return 'wrong_direction'; end if; -- agent.scope = 서버→본체 빠짐 알림(아래)
  sync := t = 'agent.sync';
  -- 봉투 필드(v1: id·work·seq·agent·device·at·data — 모두 있어야 한다. agent.sync는 work가 null, agent는 null 허용)
  if not public._msgr2_j_uuid(e->'id') or not public._msgr2_j_int(e->'seq', 0) or not public._msgr2_j_uuid(e->'device') or not public._msgr2_j_ts(e->'at')
     or jsonb_typeof(e->'data') is distinct from 'object' or not (e ? 'work') or not (e ? 'agent') then return 'invalid_envelope'; end if;
  if sync then
    if jsonb_typeof(e->'work') <> 'null' then return 'invalid_envelope'; end if;
    if jsonb_typeof(e->'agent') <> 'null' and not public._msgr2_j_uuid(e->'agent') then return 'invalid_envelope'; end if;
  elsif not public._msgr2_j_uuid(e->'work') or not public._msgr2_j_uuid(e->'agent') then return 'invalid_envelope'; end if;
  d := e->'data';
  if t = 'work.accept' then
    if not public._msgr2_j_opt(d->'lease_gen', public._msgr2_j_int(d->'lease_gen', 1)) then return 'invalid_envelope'; end if;
  elsif t = 'work.progress' then
    if (d->>'stage') is null or (d->>'stage') not in ('thinking', 'tool', 'writing') or jsonb_typeof(d->'stage') <> 'string'
       or not public._msgr2_j_opt(d->'note', public._msgr2_j_str(d->'note', 0, 200)) then return 'invalid_envelope'; end if;
  elsif t = 'work.approval_request' then
    if not public._msgr2_j_uuid(d->'approval_id') or not public._msgr2_j_str(d->'action', 1, 200) or jsonb_typeof(d->'risk') is distinct from 'string'
       or (d->>'risk') not in ('low', 'medium', 'high') or not public._msgr2_j_str(d->'summary', 1, 2000)
       or not (d ? 'effect_key') or not public._msgr2_j_opt(d->'effect_key', public._msgr2_j_str(d->'effect_key', 1, 200), true)
       or not public._msgr2_j_ts(d->'expires_at') then return 'invalid_envelope'; end if;
  elsif t = 'work.effect' then
    if not public._msgr2_j_str(d->'effect_key', 1, 200) or jsonb_typeof(d->'state') is distinct from 'string' or (d->>'state') not in ('intent', 'done', 'failed')
       or not public._msgr2_j_opt(d->'kind', public._msgr2_j_code(d->'kind')) then return 'invalid_envelope'; end if;
  elsif t = 'work.result' then
    if not public._msgr2_j_str(d->'text', 0, 20000) or jsonb_typeof(d->'files') is distinct from 'array' or jsonb_array_length(d->'files') > 20
       or jsonb_typeof(d->'handoffs') is distinct from 'array' or jsonb_array_length(d->'handoffs') > 8 then return 'invalid_envelope'; end if;
    for x in select * from jsonb_array_elements(d->'files') loop if not public._msgr2_j_uuid(x) then return 'invalid_envelope'; end if; end loop;
    for x in select * from jsonb_array_elements(d->'handoffs') loop
      if jsonb_typeof(x) <> 'object' or not public._msgr2_j_uuid(x->'agent') or not public._msgr2_j_str(x->'text', 1, 4000) then return 'invalid_envelope'; end if;
    end loop;
    -- v1.1 회의 결과 posts[]{agent, round 1..2, text 1..3000}(≤10). posts가 있으면 text(요약) ≤ 2000·handoffs 0
    if d ? 'posts' then
      if jsonb_typeof(d->'posts') <> 'array' or jsonb_array_length(d->'posts') > 10 then return 'invalid_envelope'; end if;
      for x in select * from jsonb_array_elements(d->'posts') loop
        if jsonb_typeof(x) <> 'object' or not public._msgr2_j_uuid(x->'agent') or not public._msgr2_j_int(x->'round', 1) or (x->>'round')::numeric > 2
           or not public._msgr2_j_str(x->'text', 1, 3000) then return 'invalid_envelope'; end if;
      end loop;
      if jsonb_array_length(d->'posts') > 0 and (length(d->>'text') > 2000 or jsonb_array_length(d->'handoffs') > 0) then return 'invalid_envelope'; end if;
    end if;
    if d ? 'usage' and jsonb_typeof(d->'usage') not in ('object', 'null') then return 'invalid_envelope'; end if;
    if jsonb_typeof(d->'usage') = 'object' and not (
         public._msgr2_j_opt(d->'usage'->'input_tokens', public._msgr2_j_int(d->'usage'->'input_tokens', 0))
     and public._msgr2_j_opt(d->'usage'->'output_tokens', public._msgr2_j_int(d->'usage'->'output_tokens', 0))
     and public._msgr2_j_opt(d->'usage'->'cost_usd', public._msgr2_j_num(d->'usage'->'cost_usd'))
     and public._msgr2_j_opt(d->'usage'->'runner', public._msgr2_j_str(d->'usage'->'runner', 0, 64))
     and public._msgr2_j_opt(d->'usage'->'model', public._msgr2_j_str(d->'usage'->'model', 0, 200))) then return 'invalid_envelope'; end if;
  elsif t = 'work.error' then
    if not public._msgr2_j_code(d->'code') or not (d ? 'runner') or not public._msgr2_j_opt(d->'runner', public._msgr2_j_str(d->'runner', 0, 64), true)
       or not public._msgr2_j_opt(d->'retry_at', public._msgr2_j_ts(d->'retry_at'), true) then return 'invalid_envelope'; end if;
  elsif t = 'agent.sync' then
    if jsonb_typeof(d->'agents') is distinct from 'array' or jsonb_array_length(d->'agents') > 500 then return 'invalid_envelope'; end if;
    for x in select * from jsonb_array_elements(d->'agents') loop
      if jsonb_typeof(x) <> 'object' or not public._msgr2_j_str(x->'ws', 1, 200) or not public._msgr2_j_str(x->'slug', 1, 200)
         or not public._msgr2_j_str(x->'name', 1, 200) or not public._msgr2_j_str(x->'role', 0, 2000)
         or not (x ? 'face_hash') or not public._msgr2_j_opt(x->'face_hash', public._msgr2_j_str(x->'face_hash', 0, 128), true) then return 'invalid_envelope'; end if;
      -- v1.1 외부 봇: kind(열린 값 코드), bot{kind 코드, profile ≤ 200} 또는 null
      if not public._msgr2_j_opt(x->'kind', public._msgr2_j_code(x->'kind')) then return 'invalid_envelope'; end if;
      if x ? 'bot' and jsonb_typeof(x->'bot') <> 'null' and (jsonb_typeof(x->'bot') <> 'object' or not public._msgr2_j_code(x->'bot'->'kind')
         or not public._msgr2_j_opt(x->'bot'->'profile', public._msgr2_j_str(x->'bot'->'profile', 0, 200))) then return 'invalid_envelope'; end if;
    end loop;
    -- v1.1 기능 알림 features[](열린 값 코드, ≤ 16)
    if d ? 'features' then
      if jsonb_typeof(d->'features') <> 'array' or jsonb_array_length(d->'features') > 16 then return 'invalid_envelope'; end if;
      for x in select * from jsonb_array_elements(d->'features') loop if not public._msgr2_j_code(x) then return 'invalid_envelope'; end if; end loop;
    end if;
  end if;
  return null;
end $$;

create or replace function public.msgr2_agent_rooms(p_rooms uuid[])
  returns table (room_id uuid, agents uuid[], space_id uuid, space_kind text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._msgr2_need_device();
  ids uuid[];
begin
  if coalesce(public._msgr2_device_kind(), '') not in ('runner', 'resident') then raise exception 'msgr2_runner_only' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct x), '{}') into ids from unnest(coalesce(p_rooms, '{}'::uuid[])) x where x is not null;
  if cardinality(ids) > 500 then raise exception 'msgr2_too_many_rooms' using errcode = '22023'; end if;
  return query
  with mine as (
    select m.room_id as rid, m.member_id as aid, s.id as sid, s.kind as skind
      from public.msgr2_room_members m
      join public.msgr2_agents a on a.id = m.member_id and a.owner_user_id = uid and a.status <> 'retired'
      join public.msgr2_rooms r on r.id = m.room_id
      join public.msgr2_spaces s on s.id = r.space_id and s.deleted_at is null
     where m.room_id = any (ids) and m.member_kind = 'agent' and m.removed_at is null
       and (s.kind = 'personal' or (
             exists (select 1 from public.msgr2_agent_seats st where st.agent_id = m.member_id and st.space_id = s.id and st.removed_at is null)
         and exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = uid and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now()))))
  )
  select i.x, coalesce((select array_agg(k.aid order by k.aid) from mine k where k.rid = i.x), '{}'::uuid[]),
         (select k.sid from mine k where k.rid = i.x limit 1), (select k.skind from mine k where k.rid = i.x limit 1)
    from unnest(ids) i(x)
   order by i.x;
end $$;
revoke all on function public.msgr2_agent_rooms(uuid[]) from public, anon;
grant execute on function public.msgr2_agent_rooms(uuid[]) to authenticated, service_role;

-- 'agent.scope' 봉투를 그 사람의 본체 토픽으로 — 한 트랜잭션에 사람마다 1번(설정 msgr2.scope_sent에 보낸 사람을 적는다).
create or replace function public._msgr2_scope_notify(p_uid uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare sent text := coalesce(current_setting('msgr2.scope_sent', true), '');
begin
  if p_uid is null or position(p_uid::text in sent) > 0 then return; end if;
  perform set_config('msgr2.scope_sent', sent || p_uid::text || ',', true);
  perform public._msgr2_send_w(p_uid, jsonb_build_object('v', 1, 'id', gen_random_uuid(), 'work', null, 'seq', 0, 'type', 'agent.scope', 'agent', null, 'device', null,
    'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', '{}'::jsonb));
end $$;
revoke all on function public._msgr2_scope_notify(uuid) from public, anon, authenticated;

-- 알리지 않는 문맥: 백필(서비스 문맥 + msgr2.backfill = on, 20261020200700과 같은 규칙), 그리고 서비스 문맥의 행 삭제(이전 되돌림 scripts/msgr2-migrate-rollback.sql처럼
-- 사본 표를 비우는 운영 작업 — 사람의 빠짐은 행을 지우지 않고 removed_at을 쓴다).
create or replace function public._msgr2_scope_quiet(p_op text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is null and (coalesce(current_setting('msgr2.backfill', true), '') = 'on' or p_op = 'DELETE')
$$;
revoke all on function public._msgr2_scope_quiet(text) from public, anon, authenticated;

-- 방 멤버 행(에이전트): 닫히거나(removed_at null → 값) 지워지면 그 에이전트 주인에게
create or replace function public.msgr2_scope_on_room_member() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_scope_quiet(tg_op) then return null; end if;
  if old.member_kind = 'agent' and old.removed_at is null and (tg_op = 'DELETE' or new.removed_at is not null) then
    perform public._msgr2_scope_notify((select a.owner_user_id from public.msgr2_agents a where a.id = old.member_id));
  end if;
  return null;
end $$;
revoke all on function public.msgr2_scope_on_room_member() from public, anon, authenticated;
drop trigger if exists msgr2_scope_room_member on public.msgr2_room_members;
create trigger msgr2_scope_room_member after update of removed_at or delete on public.msgr2_room_members
  for each row execute function public.msgr2_scope_on_room_member();

-- 파견 행: 닫히거나 지워지면 그 에이전트 주인에게
create or replace function public.msgr2_scope_on_seat() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_scope_quiet(tg_op) then return null; end if;
  if old.removed_at is null and (tg_op = 'DELETE' or new.removed_at is not null) then
    perform public._msgr2_scope_notify((select a.owner_user_id from public.msgr2_agents a where a.id = old.agent_id));
  end if;
  return null;
end $$;
revoke all on function public.msgr2_scope_on_seat() from public, anon, authenticated;
drop trigger if exists msgr2_scope_seat on public.msgr2_agent_seats;
create trigger msgr2_scope_seat after update of removed_at or delete on public.msgr2_agent_seats
  for each row execute function public.msgr2_scope_on_seat();

-- 공간 멤버 행(사람): 닫히거나 지워지거나 손님 기한을 지금 이전으로 당기면 그 사람에게
create or replace function public.msgr2_scope_on_space_member() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_scope_quiet(tg_op) then return null; end if;
  if old.removed_at is null and (tg_op = 'DELETE' or new.removed_at is not null
     or (new.expires_at is not null and new.expires_at <= now() and (old.expires_at is null or old.expires_at > now()))) then
    perform public._msgr2_scope_notify(old.user_id);
  end if;
  return null;
end $$;
revoke all on function public.msgr2_scope_on_space_member() from public, anon, authenticated;
drop trigger if exists msgr2_scope_space_member on public.msgr2_space_members;
create trigger msgr2_scope_space_member after update of removed_at, expires_at or delete on public.msgr2_space_members
  for each row execute function public.msgr2_scope_on_space_member();

-- 공간 삭제(deleted_at null → 값): 그 공간에 파견된 에이전트의 주인 모두에게
create or replace function public.msgr2_scope_on_space() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid;
begin
  if public._msgr2_scope_quiet(tg_op) then return null; end if;
  if old.deleted_at is null and new.deleted_at is not null then
    for u in select distinct a.owner_user_id from public.msgr2_agent_seats st join public.msgr2_agents a on a.id = st.agent_id
              where st.space_id = new.id and st.removed_at is null loop
      perform public._msgr2_scope_notify(u);
    end loop;
  end if;
  return null;
end $$;
revoke all on function public.msgr2_scope_on_space() from public, anon, authenticated;
drop trigger if exists msgr2_scope_space on public.msgr2_spaces;
create trigger msgr2_scope_space after update of deleted_at on public.msgr2_spaces
  for each row execute function public.msgr2_scope_on_space();
