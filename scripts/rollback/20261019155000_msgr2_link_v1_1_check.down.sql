-- 되돌림: supabase/migrations/20261019155000_msgr2_link_v1_1_check.sql(약속 v1.1 봉투 검사)을 20261018000000 정의로 되돌린다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 20261019160000(A+)을 먼저 되돌린 뒤 실행한다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261019155000_msgr2_link_v1_1_check.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
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
    end loop;
  end if;
  return null;
end $$;
commit;
