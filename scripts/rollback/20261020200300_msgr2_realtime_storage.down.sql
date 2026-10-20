-- 되돌림: supabase/migrations/20261020200300_msgr2_realtime_storage.sql(U2b — 방송·토픽 권한·Storage 정책·보존 함수)를 걷어 낸다. 표는 만들지 않았으므로 지우는 표가 없다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U2b → U2 → U3 → U1. 앞 단위가 남아 있으면 그 단위를 먼저 되돌린다.
-- 빈 표만 지운다 — 행이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(기억 데이터·기록 보존, CLAUDE.md DB 위생 1). storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261020200300_msgr2_realtime_storage.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop policy if exists msgr2_realtime_recv on realtime.messages;
drop policy if exists msgr2_files_select on storage.objects;
drop policy if exists msgr2_files_insert on storage.objects;
drop policy if exists msgr2_files_update on storage.objects;
drop policy if exists msgr2_realtime_send on realtime.messages;
drop policy if exists msgr2_files_gate_select on storage.objects;
drop policy if exists msgr2_files_gate_insert on storage.objects;
drop policy if exists msgr2_files_gate_update on storage.objects;
drop policy if exists msgr2_files_gate_delete on storage.objects;
-- 옛 정리 후보를 20261011150000 본문으로 되돌린다(v2 제외 조건 빼기). 옛 함수가 없는 DB면 건너뛴다.
do $sw$ begin
  if to_regprocedure('public.msgr_storage_sweep_list(integer)') is not null then
    execute $f$
create or replace function public.msgr_storage_sweep_list(p_limit int default 200) returns setof text
  language plpgsql stable security definer set search_path = public, pg_temp as $b$
begin
  return query
    select o.name from public._msgr_live_objects() o
     where (not exists (select 1 from public.msgr_channels c where c.id = public.msgr_uuid_or_null(split_part(o.name, '/', 2)))
            or (o.created_at < now() - interval '24 hours'
                and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name)))
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $b$;
$f$;
  end if;
end $sw$;
drop trigger if exists msgr2_on_message_broadcast on public.msgr2_messages;
drop trigger if exists msgr2_on_user_gen on public.msgr2_user_gen;
do $t$ begin
  if to_regclass('public.msgr_settings') is not null then drop trigger if exists msgr2_on_pause_setting on public.msgr_settings; end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') then -- cron.job은 확장이 있을 때만 있다(같은 if에 두면 확장 없는 DB에서 오류)
    if exists (select 1 from cron.job where jobname = 'msgr2-retention-prune') then perform cron.unschedule('msgr2-retention-prune'); end if;
  end if;
end $t$;
-- 0절에서 갱신한 U2·U3 함수를 U2·U3 본문으로 되돌린다(20261020200200_msgr2_work.sql·20261020200100_msgr2_device.sql에서 그대로 옮김)
create or replace function public._msgr2_send_w(p_uid uuid, p_env jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('envelope', p_env), coalesce(p_env->>'type', 'event'), 'w:' || p_uid::text, true);
exception when others then null;
end $$;

create or replace function public._msgr2_make_offer(p_room uuid, p_topic uuid, p_agent uuid, p_from_kind text, p_from_id uuid, p_root_user uuid,
  p_text text, p_source bigint, p_parent uuid, p_depth int) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.msgr2_rooms; s public.msgr2_spaces; a public.msgr2_agents; seat public.msgr2_agent_seats; ctr public.msgr2_room_counters;
  wid uuid := gen_random_uuid(); tid uuid := p_topic; tier text; ctx jsonb := '[]'::jsonb; item jsonb; total int := 2; m record;
  lim text; dev uuid; ttl_s int := public._msgr2_setting_int('msgr2_offer_ttl_s', 1800); acc public.msgr2_access_t;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select * into a from public.msgr2_agents where id = p_agent;
  if r.id is null or s.deleted_at is not null or r.archived_at is not null or r.agent_policy = 'blocked' or a.id is null or a.status <> 'active' then return null; end if;
  if not exists (select 1 from public.msgr2_room_members where room_id = p_room and member_kind = 'agent' and member_id = p_agent and removed_at is null) then return null; end if;
  -- 에이전트 주인이 지금 그 방을 읽을 수 있어야 한다(문맥·지시가 주인 본체로 간다). 방에서 빠졌거나 공간에서 제거·만료되면 offer 없음(검수 1 #1075 지적 1).
  acc := public._msgr2_access_for(p_room, a.owner_user_id);
  if not coalesce(acc.read, false) then return null; end if;
  if s.kind = 'personal' then
    if p_root_user <> a.owner_user_id then return null; end if;
  else
    select * into seat from public.msgr2_agent_seats where agent_id = p_agent and space_id = s.id and removed_at is null;
    if seat.agent_id is null then return null; end if;
    if seat.allow = 'owner' and p_root_user <> a.owner_user_id then return null; end if;
    if seat.allow = 'list' and p_root_user <> a.owner_user_id and not (p_root_user = any (seat.allow_users)) then return null; end if;
  end if;
  -- 상한(D11): 연속 답장(에이전트가 촉발한 일만), 분당 에이전트·방, 토픽당, 주인 하루
  if p_from_kind = 'agent' then
    select * into ctr from public.msgr2_room_counters where room_id = p_room;
    if coalesce(ctr.agent_streak, 0) >= public._msgr2_setting_int('msgr2_limit_streak', 8) then
      if not coalesce(ctr.streak_noted, false) then
        update public.msgr2_room_counters set streak_noted = true where room_id = p_room;
        perform public._msgr2_system_msg(p_room, p_topic, null, jsonb_build_object('code', 'work.limit', 'limit', 'streak'));
      end if;
      return null;
    end if;
  end if;
  lim := case
    when (select count(*) from public.msgr2_works where agent_id = p_agent and created_at > now() - interval '1 minute') >= public._msgr2_setting_int('msgr2_limit_agent_min', 10) then 'agent_minute'
    when (select count(*) from public.msgr2_works where room_id = p_room and created_at > now() - interval '1 minute') >= public._msgr2_setting_int('msgr2_limit_room_min', 30) then 'room_minute'
    when p_topic is not null and (select count(*) from public.msgr2_works where topic_id = p_topic) >= public._msgr2_setting_int('msgr2_limit_topic', 30) then 'topic'
    when (select count(*) from public.msgr2_works where owner_user_id = a.owner_user_id and created_at > now() - interval '1 day') >= public._msgr2_setting_int('msgr2_limit_owner_day', 500) then 'owner_day'
  end;
  if lim is not null then
    perform public._msgr2_system_msg(p_room, p_topic, null, jsonb_build_object('code', 'work.limit', 'limit', lim, 'agent', p_agent));
    return null;
  end if;
  tier := coalesce(acc.tier, 'guest'); -- 등급은 방의 사람 구성(보는 사람과 무관) — 주인 기준 판정에서 가져온다
  for m in select x.id, x.author_kind, x.author_user_id, x.author_agent_id, x.body, x.created_at from public.msgr2_messages x
             where x.room_id = p_room and x.deleted_at is null and x.kind <> 'system' and (p_source is null or x.id <> p_source)
             order by x.id desc limit 200 loop
    item := jsonb_build_object('id', m.id,
      'author', jsonb_build_object('kind', m.author_kind, 'id', coalesce(m.author_user_id, m.author_agent_id)),
      'text', left(m.body, 20000), 'at', to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    total := total + octet_length(item::text) + 2;
    exit when total > 16384;
    ctx := jsonb_build_array(item) || ctx;
  end loop;
  if tid is null then
    insert into public.msgr2_topics (room_id, title, work_id) values (p_room, left(split_part(coalesce(p_text, ''), E'\n', 1), 40), wid) returning id into tid;
  end if;
  insert into public.msgr2_works (id, room_id, topic_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, source_message_id, parent_work_id, depth, tier, memory, text, expires_at)
  values (wid, p_room, tid, p_agent, a.owner_user_id, p_from_kind, p_from_id, p_root_user, p_source, p_parent, p_depth, tier, r.memory, left(coalesce(p_text, ''), 20000),
          now() + make_interval(secs => ttl_s));
  select l.device_id into dev from public.msgr2_agent_leases l where l.agent_id = p_agent and l.lease_until > now();
  perform public._msgr2_server_event(wid, 'work.offer', dev, jsonb_build_object(
    'room', p_room, 'topic', tid, 'from', jsonb_build_object('kind', p_from_kind, 'id', p_from_id), 'text', left(coalesce(p_text, ''), 20000),
    'context', ctx, 'attachments', '[]'::jsonb, 'memory', r.memory, 'peers', public._msgr2_peers(p_room, p_agent, p_root_user, tier),
    'limits', jsonb_build_object('tier', tier, 'max_turn_s', public._msgr2_setting_int('msgr2_max_turn_s', 900), 'budget', null),
    'expires_at', to_char((now() + make_interval(secs => ttl_s)) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  return wid;
end $$;

create or replace function public.msgr2_link_send(p_env jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); dv record; c text; t text; d jsonb; w public.msgr2_works; ev public.msgr2_work_events; ns record;
  st text; same boolean; v_until timestamptz := now() + make_interval(secs => public._msgr2_setting_int('msgr2_lease_s', 600));
  lg int; mid bigint; x jsonb; slots uuid[]; n int; agents jsonb := '[]'::jsonb; v_late boolean; meta jsonb; ecode text; ap_exp timestamptz;
begin
  c := public._msgr2_env_check(p_env, public._msgr2_setting_int('msgr2_link_min_v', 1), public._msgr2_setting_int('msgr2_link_max_v', 1));
  if c is not null then return public._msgr2_rej(c); end if;
  if uid is null then return public._msgr2_rej('device_unknown'); end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null then return public._msgr2_rej(dv.code); end if;
  if dv.kind not in ('runner', 'resident') or dv.id <> (p_env->>'device')::uuid then return public._msgr2_rej('device_unknown'); end if;
  if public._msgr2_paused() then return public._msgr2_rej('service_paused'); end if;
  t := p_env->>'type'; d := p_env->'data';

  -- 같은 봉투 다시 보내기(본체 재시도) — 쓰기 없이 같은 답
  select * into ev from public.msgr2_work_events where envelope_id = (p_env->>'id')::uuid;
  if found then
    if ev.sender = 'runner' and ev.device_id = dv.id and ev.type = t and ev.seq = (p_env->>'seq')::bigint
       and ev.work_id is not distinct from (p_env->>'work')::uuid then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    return public._msgr2_rej('seq_conflict');
  end if;

  if t = 'agent.sync' then
    perform public.msgr2_agent_sync(coalesce((select jsonb_agg(jsonb_build_object('ws_id', a->>'ws', 'slug', a->>'slug', 'display_name', a->>'name',
      'role_text', a->>'role', 'face', case when jsonb_typeof(a->'face_hash') = 'string' then jsonb_build_object('hash', a->>'face_hash') end))
      from jsonb_array_elements(d->'agents') a), '[]'::jsonb));
    select coalesce(jsonb_agg(jsonb_build_object('ws', g.ws_id, 'slug', g.slug, 'id', g.id) order by g.ws_id, g.slug), '[]'::jsonb) into agents
      from public.msgr2_agents g join jsonb_array_elements(d->'agents') a on g.ws_id = a->>'ws' and g.slug = a->>'slug' where g.owner_user_id = uid;
    insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope)
    values (null, 'runner', (p_env->>'seq')::bigint, t, (p_env->>'id')::uuid, dv.id, p_env - 'data'); -- 목록 본문은 에이전트 표에 있다
    return jsonb_build_object('ok', true, 'agents', agents);
  end if;

  select * into w from public.msgr2_works where id = (p_env->>'work')::uuid for update;
  if not found or w.owner_user_id <> uid or w.agent_id <> (p_env->>'agent')::uuid then return public._msgr2_rej('work_not_found'); end if;
  if exists (select 1 from public.msgr2_work_events e where e.work_id = w.id and e.sender = 'runner' and e.device_id = dv.id and e.seq = (p_env->>'seq')::bigint) then
    return public._msgr2_rej('seq_conflict');
  end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  same := w.lease_device is not distinct from dv.id;

  if t = 'work.progress' then
    if st in ('accepted', 'running', 'awaiting_approval') then
      return case when same then jsonb_build_object('ok', true, 'state', st) else public._msgr2_rej('not_lease_holder') end;
    end if;
    return public._msgr2_rej(case when st in ('done', 'failed', 'cancelled', 'expired') then 'work_closed' else 'invalid_transition' end);
  end if;
  -- 리스를 잡은 일에는 그 기기만(accept 제외 — accept는 상태표가 lease_held로 가른다). offered의 unsupported 답은 주인의 어느 본체든.
  if t <> 'work.accept' and w.lease_device is not null and not same and st <> 'stalled' then return public._msgr2_rej('not_lease_holder'); end if;

  select * into ns from public._msgr2_next_state(st, t, d, same, case when w.lease_gen > 0 then w.lease_gen end);
  if not ns.ok then return public._msgr2_rej(ns.code); end if;
  if not public._msgr2_tier_allows(w.tier, t, d) then return public._msgr2_rej('tier_denied'); end if;
  v_late := ns.mark is not null;

  if t = 'work.accept' then
    insert into public.msgr2_agent_leases as l (agent_id, device_id, lease_until, gen) values (w.agent_id, dv.id, v_until, 1)
    on conflict (agent_id) do update set device_id = excluded.device_id, lease_until = greatest(l.lease_until, excluded.lease_until),
      gen = l.gen + case when l.device_id = excluded.device_id then 0 else 1 end
    where l.lease_until <= now() or l.device_id = excluded.device_id;
    get diagnostics n = row_count;
    if n = 0 then return public._msgr2_rej('lease_held'); end if;
    if st = 'offered' then
      update public.msgr2_works set state = 'accepted', lease_device = dv.id, lease_gen = lease_gen + 1, lease_until = v_until, updated_at = now()
        where id = w.id returning lease_gen into lg;
    else -- 연장(같은 상태) 또는 이어 하기(stalled → running). 세대는 그대로.
      update public.msgr2_works set state = ns.to_state, lease_until = v_until, updated_at = now() where id = w.id returning lease_gen into lg;
    end if;
  elsif t = 'work.approval_request' then
    if exists (select 1 from public.msgr2_approvals where id = (d->>'approval_id')::uuid) then return public._msgr2_rej('invalid_envelope'); end if;
    ap_exp := least((d->>'expires_at')::timestamptz, now() + interval '7 days');
    mid := null;
    insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
    values (w.room_id, w.topic_id, 'agent', w.agent_id, 'card', d->>'summary',
      jsonb_build_object('code', 'approval.request', 'approval', d->>'approval_id', 'action', d->>'action', 'risk', d->>'risk',
        'expires_at', to_char(ap_exp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), w.id) returning id into mid;
    insert into public.msgr2_approvals (id, work_id, room_id, action, risk, summary, effect_key, card_message_id, expires_at)
    values ((d->>'approval_id')::uuid, w.id, w.room_id, d->>'action', d->>'risk', d->>'summary', d->>'effect_key', mid, ap_exp);
    update public.msgr2_works set state = 'awaiting_approval', updated_at = now() where id = w.id;
  elsif t = 'work.effect' then
    if d->>'state' = 'intent' then
      insert into public.msgr2_effects (owner_user_id, effect_key, work_id, kind, state) values (uid, d->>'effect_key', w.id, d->>'kind', 'intent')
      on conflict (owner_user_id, effect_key) do nothing;
      get diagnostics n = row_count;
      if n = 0 then return public._msgr2_rej('effect_exists'); end if;
    else
      update public.msgr2_effects set state = d->>'state', at = now()
        where owner_user_id = uid and effect_key = d->>'effect_key' and work_id = w.id and state = 'intent';
      get diagnostics n = row_count;
      if n = 0 then return public._msgr2_rej('effect_unknown'); end if;
    end if;
  elsif t = 'work.result' then
    select coalesce(array_agg((f #>> '{}')::uuid), '{}') into slots from jsonb_array_elements(d->'files') f;
    if cardinality(slots) <> (select count(distinct s) from unnest(slots) s)
       or (select count(*) from public.msgr2_work_files wf where wf.id = any (slots) and wf.work_id = w.id) <> cardinality(slots) then
      return public._msgr2_rej('upload_slot_invalid');
    end if;
    meta := jsonb_build_object('work', w.id) || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end;
    insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
    values (w.room_id, w.topic_id, 'agent', w.agent_id, 'text', d->>'text', meta, w.id) returning id into mid;
    insert into public.msgr2_attachments (message_id, room_id, storage_path, name, bytes)
      select mid, w.room_id, wf.storage_path, wf.name, wf.bytes from public.msgr2_work_files wf where wf.id = any (slots) order by array_position(slots, wf.id);
    update public.msgr2_works set state = 'done', has_result = true, late = v_late, updated_at = now() where id = w.id;
    perform public._msgr2_bump_streak(w.room_id);
    for x in select * from jsonb_array_elements(d->'handoffs') loop
      if w.depth + 1 > public._msgr2_setting_int('msgr2_limit_depth', 16) then
        perform public._msgr2_system_msg(w.room_id, w.topic_id, w.id, jsonb_build_object('code', 'work.limit', 'limit', 'depth', 'agent', x->>'agent'));
        exit;
      end if;
      continue when not exists (select 1 from jsonb_array_elements(public._msgr2_peers(w.room_id, w.agent_id, w.root_user_id, w.tier)) pe where pe->>'agent' = x->>'agent');
      perform public._msgr2_make_offer(w.room_id, w.topic_id, (x->>'agent')::uuid, 'agent', w.agent_id, w.root_user_id, x->>'text', mid, w.id, w.depth + 1);
    end loop;
  elsif t = 'work.error' then
    ecode := public._msgr2_norm_error(d->>'code');
    if ns.to_state = 'failed' then
      update public.msgr2_works set state = 'failed', error_code = ecode, late = v_late, updated_at = now() where id = w.id;
      perform public._msgr2_system_msg(w.room_id, w.topic_id, w.id, jsonb_build_object('code', 'work.error', 'error', ecode, 'agent', w.agent_id, 'work', w.id)
        || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end);
    end if; -- offered(unsupported)·cancelled는 기록만
  end if;

  insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope)
  values (w.id, 'runner', (p_env->>'seq')::bigint, t, (p_env->>'id')::uuid, dv.id, p_env);
  return jsonb_build_object('ok', true, 'state', ns.to_state)
    || case when t = 'work.accept' then jsonb_build_object('lease_gen', lg, 'lease_until', to_char(v_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else '{}'::jsonb end;
end $$;

create or replace function public.msgr2_work_status(p_work uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w public.msgr2_works; st text;
begin
  select * into w from public.msgr2_works where id = p_work;
  if not found or not (select (public.msgr2_access(w.room_id)).read) then return null; end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  return jsonb_build_object('work', w.id, 'state', st, 'late', w.late, 'error', w.error_code, 'has_result', w.has_result,
    'unknown_effects', case when st in ('done', 'failed', 'cancelled', 'stalled') then
      coalesce((select jsonb_agg(e.effect_key order by e.at) from public.msgr2_effects e where e.work_id = w.id and e.state = 'intent'), '[]'::jsonb) else '[]'::jsonb end);
end $$;

create or replace function public.msgr2_device_revoke(p_device uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); t public.msgr2_devices%rowtype;
begin
  if not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  select * into t from public.msgr2_devices where id = p_device and user_id = me;
  if not found then raise exception 'msgr2_device_not_found' using errcode = '42501'; end if;
  if t.revoked_at is not null then return false; end if;
  update public.msgr2_devices set revoked_at = now() where id = t.id and revoked_at is null;
  perform realtime.send(jsonb_build_object('device_id', t.id), 'device_revoked', 'u:' || me::text, true);
  return true;
end $$;

do $d$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array['_msgr2_attachments_of', '_msgr2_msg_payload', '_msgr2_room_humans', '_msgr2_rt_topic_ok', '_msgr2_rt_send_ok', '_msgr2_storage_gate', '_msgr2_send_s', '_msgr2_send_u', '_msgr2_storage_read', '_msgr2_storage_room', '_msgr2_storage_write', 'msgr2_on_message_broadcast', 'msgr2_on_pause_setting', 'msgr2_on_user_gen', 'msgr2_retention_prune']) loop
    execute format('drop function %s', f);
  end loop;
end $d$;
notify pgrst, 'reload schema';
commit;
