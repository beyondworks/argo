-- 되돌림: supabase/migrations/20261022180000_msgr2_agent_rooms.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: 함수 msgr2_agent_rooms·_msgr2_scope_notify·_msgr2_scope_quiet와 'agent.scope' 알림 트리거 4개(+ 트리거 함수)를 지운다. 봉투 검사 _msgr2_env_check는 20261020201300 본문으로 되돌린다. 표·인덱스·그 밖의 함수·권한은 이 마이그레이션이 바꾸지 않았다.
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
drop function if exists public._msgr2_scope_quiet(text);
-- 봉투 검사를 20261020201300 본문으로 되돌린다(agent.scope를 다시 unsupported_type으로)
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
               'work.result', 'work.error', 'agent.sync') then return 'unsupported_type'; end if;
  if octet_length(e::text) > 131072 then return 'too_large'; end if;
  if t in ('work.offer', 'work.cancel', 'work.approval_decision') then return 'wrong_direction'; end if;
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

drop function if exists public.msgr2_agent_rooms(uuid[]);
commit;
