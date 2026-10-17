-- 메신저 v2 U2b — 사람 쪽 실시간 표지(v2:u:<uid>·v2:s:<space>), Realtime 토픽 권한, Storage 버킷 msgr의 v2 경로 정책, 누적 표 보존 규칙.
-- 설계 2026-10-17 4절(방송), 6절 함정(누적 표·Storage), D15. 총괄 지시 2026-10-17(U2 미룸 5건 → U2b).
-- 의존: U1(*_msgr2_space.sql), U3(*_msgr2_device.sql — msgr2_devices·msgr2_user_gen·_msgr2_device_ok/_kind), U2(*_msgr2_work.sql).
-- 원칙
--   · 토픽 이름은 약속 v1 TOPICS(v2:u·v2:w·v2:s·v2:wk). 옛 메신저 토픽(u:·org:·dm:)과 겹치지 않게 'v2:' 접두사를 둔다 —
--     옛 받기 정책 msgr_realtime_recv(20260918184500)가 'u:'||auth.uid()를 기기 확인 없이 허용하고, 허용 정책은 OR로 합쳐져 같은 이름이면 v2의 기기 확인이 무력해진다(검수 #1076 높음 1).
--     옛 u: 정책은 건드리지 않는다(옛 앱의 중단 방송 보존).
--   · 방송은 realtime.send(private) 한 곳(_msgr2_send_u·_msgr2_send_s)에서. 실패해도 글·기록은 남는다(앱은 재접속 때 msgr2_catch_up으로 따라잡는다).
--   · 글 1개 = 방의 사람 수만큼 v2:u:<uid> 방송(본문 4KB 이하면 글째, 넘으면 id·room_id만). 사람이 50명을 넘는 팀 open 방은 v2:s:<space> 한 번 +
--     그 토픽을 못 받는 방 멤버(손님 등)에게만 v2:u:. 글을 고치거나 지우면 같은 id로 다시 보낸다(U5가 갱신으로 받는다). 이전(U8) 백필은 방송하지 않는다(서비스 문맥 + msgr2.backfill = on).
--   · 토픽 권한(realtime.messages): 받기 — v2:u:<본인> = 유효한 기기, v2:w:<본인> = runner·resident 기기, v2:s:<공간> = 그 팀 공간의 owner·admin·member + 유효한 기기,
--     v2:wk:<일> = 그 일의 방을 읽을 수 있는 사람. 보내기 — v2:wk:<일>만, 그 일의 리스를 쥔 본체(work.progress). 그 밖의 토픽은 서버만 보낸다.
--   · Storage(버킷 msgr, 이름 = <공간>/<방>/…): 읽기 = 그 방을 읽을 수 있는 사람(msgr2_access) 또는 그 방에 진행 중인 일의 리스를 쥔 runner 기기.
--     쓰기·덮어쓰기 = msgr2_attachment_add(내 글)·msgr2_link_upload_slot(내 리스)이 만든 경로만. 지우기는 사람에게 늘 거짓. storage.objects를 SQL로 지우지 않는다.
--     옛 메신저 정책(msgr_files_*)은 v2 경로 <공간>/<방>/…을 옛 <조직>/<채널>로 판정하므로(U8 id 보존 때 옛 표 관리자가 v2 파일을 읽고 지운다 — 검수 #1076 높음 3),
--     v2 방 경로에는 restrictive 정책(msgr2_files_gate_*)으로 v2 판정만 따르게 한다. 옛 고아 경로에는 영향이 없다. 옛 용량 제한(restrictive insert)은 그대로 v2 업로드에도 걸린다.
--   · 옛 정리 작업(msgr_storage_sweep_list, 매시간)이 v2 파일을 지울 후보로 고르지 않게 v2 첨부·슬롯이 가리키는 객체와 v2 방 경로를 뺀다(검수 #1076 높음 2).
--     옛 본문은 그대로 두고 제외 조건만 더한다 — 라이브 적용 전 라이브 prosrc와 저장소 정의(20261011150000)를 대조해야 한다(DB 위생 7).
--   · 보존(DB 위생 4): 끝난 일의 봉투 기록(msgr2_work_events)과 일 없는 agent.sync 기록은 30일 뒤 지운다. 일·승인·효과·글은 지우지 않는다(일 행은 글·토픽이 가리키고, 글은 기억 데이터).
-- 지우는 SQL은 보존 함수의 msgr2_work_events 하나뿐이다.

-- ── 0. 병합된 U2·U3 함수 갱신(제자리 수정 금지 — 이미 U2·U3를 적용한 DB에도 닿게 여기서 create or replace, 총괄 지시 2026-10-17) ──
-- U2(20261018000000): _msgr2_send_w 토픽 'w:' → 'v2:w:'(약속 v1 TOPICS.runner, 검수 #1076 높음 1),
--   _msgr2_make_offer의 offer.attachments를 원글 첨부의 Storage 위치로(_msgr2_attachments_of, 총괄 지시 3),
--   msgr2_link_send의 accept 성공 답에 원글의 지금 첨부(사람 글의 첨부는 글을 넣은 뒤에 붙는다),
--   msgr2_work_status의 effects[].state(intent → unknown 계산, #1074 검수).
-- U3(20261017235000): msgr2_device_revoke의 토픽 'u:' → 'v2:u:'(약속 v1 TOPICS.user).
-- 아래 본문은 그 함수의 U2·U3 본문에 위 변경만 더한 것이다. 되돌림은 U2·U3 본문으로 되돌린다(시험이 prosrc 일치를 본다).
create or replace function public._msgr2_send_w(p_uid uuid, p_env jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('envelope', p_env), coalesce(p_env->>'type', 'event'), 'v2:w:' || p_uid::text, true); -- 토픽 이름은 약속 v1 TOPICS.runner
exception when others then null;
end $$;

create or replace function public._msgr2_attachments_of(p_message bigint) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'mime', q.mime, 'bytes', q.bytes, 'bucket', q.bucket,
           'path', substr(q.storage_path, char_length(q.bucket) + 2)) order by q.id), '[]'::jsonb)
    from (select a.id, left(coalesce(nullif(a.name, ''), 'file'), 200) as name, left(coalesce(nullif(a.mime, ''), 'application/octet-stream'), 200) as mime,
                 greatest(coalesce(a.bytes, 0), 0) as bytes, split_part(a.storage_path, '/', 1) as bucket, a.storage_path
            from public.msgr2_attachments a where p_message is not null and a.message_id = p_message and position('/' in a.storage_path) > 1
           order by a.id limit 20) q
$$;

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
    'context', ctx, 'attachments', public._msgr2_attachments_of(p_source), 'memory', r.memory, 'peers', public._msgr2_peers(p_room, p_agent, p_root_user, tier),
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
    || case when t = 'work.accept' then jsonb_build_object('lease_gen', lg, 'lease_until', to_char(v_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'attachments', public._msgr2_attachments_of(w.source_message_id)) else '{}'::jsonb end; -- 사람 글의 첨부는 글을 넣은 뒤에 붙어 offer에 없을 수 있다
end $$;

create or replace function public.msgr2_work_status(p_work uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w public.msgr2_works; st text;
begin
  select * into w from public.msgr2_works where id = p_work;
  if not found or not (select (public.msgr2_access(w.room_id)).read) then return null; end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  -- effects[].state: intent가 남았는데 일이 끝났거나 리스가 끝났으면(stalled) unknown — 재시작한 본체는 알릴 수 없어 서버가 읽을 때 계산한다(#1074 검수).
  return jsonb_build_object('work', w.id, 'state', st, 'late', w.late, 'error', w.error_code, 'has_result', w.has_result,
    'effects', coalesce((select jsonb_agg(jsonb_build_object('key', e.effect_key, 'kind', e.kind,
        'state', case when e.state = 'intent' and st in ('done', 'failed', 'cancelled', 'stalled') then 'unknown' else e.state end) order by e.at, e.effect_key)
      from public.msgr2_effects e where e.work_id = w.id), '[]'::jsonb),
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
  perform realtime.send(jsonb_build_object('device_id', t.id), 'device_revoked', 'v2:u:' || me::text, true); -- 약속 v1 TOPICS.user(옛 u: 토픽과 겹치지 않게, #1076 검수)
  return true;
end $$;
revoke all on function public._msgr2_attachments_of(bigint) from public, anon, authenticated;

-- ── 1. 방송 보조 ────────────────────────────────────────────────────────────────
create or replace function public._msgr2_send_u(p_uid uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(p_payload, p_event, 'v2:u:' || p_uid::text, true); -- 약속 v1 TOPICS.user
exception when others then null;
end $$;
create or replace function public._msgr2_send_s(p_space uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(p_payload, p_event, 'v2:s:' || p_space::text, true); -- 약속 v1 TOPICS.space
exception when others then null;
end $$;

-- 방의 사람(받을 사람) — msgr2_access가 read를 주는 사람과 같은 집합: 활동 중인 사람 방 멤버(팀이면 활동 중인 공간 멤버인 사람만) ∪ 팀 open 방의 owner·admin·member.
create or replace function public._msgr2_room_humans(p_room uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.member_id from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id join public.msgr2_spaces s on s.id = r.space_id
   where m.room_id = p_room and m.member_kind = 'user' and m.removed_at is null and s.deleted_at is null
     and (s.kind = 'personal' or exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = m.member_id
                                          and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())))
  union
  select sm.user_id from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id join public.msgr2_space_members sm on sm.space_id = s.id
   where r.id = p_room and s.kind = 'team' and s.deleted_at is null and r.kind = 'open' and sm.role in ('owner', 'admin', 'member')
     and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())
$$;

-- 방송할 글 모양(catch_up 항목과 같은 열). 4KB를 넘으면 body·meta를 빼고 id·room_id 등 머리만(U5가 그 글 하나만 읽는다).
create or replace function public._msgr2_msg_payload(m public.msgr2_messages) returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare j jsonb;
begin
  j := jsonb_build_object('id', m.id, 'room_id', m.room_id, 'topic_id', m.topic_id, 'author_kind', m.author_kind, 'author_user_id', m.author_user_id,
    'author_agent_id', m.author_agent_id, 'kind', m.kind, 'reply_to', m.reply_to, 'client_msg_id', m.client_msg_id, 'work_id', m.work_id,
    'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted_at', m.deleted_at);
  if m.deleted_at is not null then return jsonb_build_object('message', j); end if;
  if octet_length((j || jsonb_build_object('body', m.body, 'meta', m.meta))::text) <= 4096 then
    j := j || jsonb_build_object('body', m.body, 'meta', m.meta);
  end if;
  return jsonb_build_object('message', j);
end $$;

-- ── 2. 글 방송(v2:u:<uid> 'msg', 큰 open 방은 v2:s:<space> 'msg' + 그 토픽을 못 받는 방 멤버에게 v2:u:) ──────
create or replace function public.msgr2_on_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid; p jsonb;
begin
  -- 이전(U8) 백필: 서비스 문맥(auth.uid() 없음)에서 msgr2.backfill = on이면 방송하지 않는다(옛 글 수백만 건 = 방송 폭주). 사람 문맥은 이 설정과 무관하게 방송한다.
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if;
  if tg_op = 'UPDATE' and (new.body, new.meta, new.edited_at, new.deleted_at) is not distinct from (old.body, old.meta, old.edited_at, old.deleted_at) then return null; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  p := public._msgr2_msg_payload(new);
  select count(*) into n from public._msgr2_room_humans(new.room_id);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_setting_int('msgr2_fanout_max', 50) then
    perform public._msgr2_send_s(s.id, 'msg', p);
    -- v2:s:를 못 받는 사람(그 공간의 owner·admin·member가 아닌 방 멤버 — 손님 등)에게는 따로(검수 #1076 중간)
    for u in select h from public._msgr2_room_humans(new.room_id) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, 'msg', p);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(new.room_id) loop perform public._msgr2_send_u(u, 'msg', p); end loop;
  end if;
  return null;
end $$;
drop trigger if exists msgr2_on_message_broadcast on public.msgr2_messages;
create trigger msgr2_on_message_broadcast after insert or update on public.msgr2_messages for each row execute function public.msgr2_on_message_broadcast();

-- ── 3. 중단·기기 폐기 방송 ──────────────────────────────────────────────────────
-- 중단 스위치(msgr_settings key msgr2_paused)가 켜지거나 꺼지면 유효한 앱 기기를 가진 사람마다 u:<uid> 'pause' {paused, since}.
create or replace function public.msgr2_on_pause_setting() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; p jsonb;
begin
  if coalesce(new.key, old.key) <> 'msgr2_paused' then return null; end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return null; end if;
  p := case when tg_op = 'DELETE' or coalesce(new.value, '') = '' then jsonb_build_object('paused', false)
            else jsonb_build_object('paused', true, 'since', new.value) end;
  for u in select distinct d.user_id from public.msgr2_devices d
            where d.kind = 'app' and d.revoked_at is null and d.expires_at > now()
              and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0) loop
    perform public._msgr2_send_u(u, 'pause', p);
  end loop;
  return null;
end $$;
do $$ begin
  if to_regclass('public.msgr_settings') is not null then
    drop trigger if exists msgr2_on_pause_setting on public.msgr_settings;
    create trigger msgr2_on_pause_setting after insert or update or delete on public.msgr_settings for each row execute function public.msgr2_on_pause_setting();
  end if;
end $$;

-- 사용자 세대를 올리면(모든 기기 무효) u:<uid> 'device_revoked' {all:true}. 기기 하나 폐기는 U3 msgr2_device_revoke가 {device_id}로 보낸다.
create or replace function public.msgr2_on_user_gen() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.gen is not distinct from old.gen then return null; end if;
  if tg_op = 'INSERT' and new.gen = 0 then return null; end if;
  perform public._msgr2_send_u(new.user_id, 'device_revoked', jsonb_build_object('all', true));
  return null;
end $$;
drop trigger if exists msgr2_on_user_gen on public.msgr2_user_gen;
create trigger msgr2_on_user_gen after insert or update on public.msgr2_user_gen for each row execute function public.msgr2_on_user_gen();

-- ── 4. Realtime 토픽 권한(받기만) ───────────────────────────────────────────────
create or replace function public._msgr2_rt_topic_ok(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); k text; v_id uuid; w public.msgr2_works;
begin
  if uid is null or p_topic is null or p_topic !~* '^v2:(u|w|s|wk):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  k := split_part(p_topic, ':', 2); v_id := split_part(p_topic, ':', 3)::uuid;
  if k = 'u' then return v_id = uid and public._msgr2_device_ok(); end if;
  if k = 'w' then return v_id = uid and coalesce(public._msgr2_device_kind() in ('runner', 'resident'), false); end if;
  if k = 's' then
    return public._msgr2_device_ok() and exists (select 1 from public.msgr2_spaces s join public.msgr2_space_members sm on sm.space_id = s.id
      where s.id = v_id and s.kind = 'team' and s.deleted_at is null and sm.user_id = uid and sm.role in ('owner', 'admin', 'member')
        and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now()));
  end if;
  select * into w from public.msgr2_works x where x.id = v_id;
  return found and coalesce((public.msgr2_access(w.room_id)).read, false);
end $$;
revoke all on function public._msgr2_rt_topic_ok(text) from public, anon;
grant execute on function public._msgr2_rt_topic_ok(text) to authenticated;
drop policy if exists msgr2_realtime_recv on realtime.messages;
create policy msgr2_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public._msgr2_rt_topic_ok((select realtime.topic())));

-- 보내기: v2:wk:<일>만, 그 일의 리스를 쥔(리스가 살아 있는) 본체 기기(work.progress, 약속 v1 CHANNEL 'broadcast:wk'). 그 밖의 v2 토픽은 서버(realtime.send)만.
create or replace function public._msgr2_rt_send_ok(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare dv record;
begin
  if auth.uid() is null or p_topic is null or p_topic !~* '^v2:wk:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_works w where w.id = split_part(p_topic, ':', 3)::uuid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                   and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval'));
end $$;
revoke all on function public._msgr2_rt_send_ok(text) from public, anon;
grant execute on function public._msgr2_rt_send_ok(text) to authenticated;
drop policy if exists msgr2_realtime_send on realtime.messages;
create policy msgr2_realtime_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and public._msgr2_rt_send_ok((select realtime.topic())));

-- ── 5. Storage 버킷 msgr의 v2 경로 ──────────────────────────────────────────────
-- 이름에서 (공간, 방)을 꺼내 그 방이 그 공간의 방인지까지 본다. 모양이 아니면 null(옛 메신저 경로 <조직>/<채널>/…는 방이 없어 거짓).
create or replace function public._msgr2_storage_room(p_name text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a text := split_part(coalesce(p_name, ''), '/', 1); b text := split_part(coalesce(p_name, ''), '/', 2); rid uuid;
begin
  if a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or b !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_name like '%..%' or p_name like '%//%' then return null; end if;
  select r.id into rid from public.msgr2_rooms r where r.id = b::uuid and r.space_id = a::uuid;
  return rid;
end $$;

-- 읽기: 그 방을 읽을 수 있는 사람, 또는 그 방에 진행 중인(리스가 살아 있는) 일의 리스를 쥔 runner·resident 기기(offer 첨부를 받는 본체).
create or replace function public._msgr2_storage_read(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record;
begin
  if rid is null or auth.uid() is null then return false; end if;
  if coalesce((public.msgr2_access(rid)).read, false) then return true; end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_works w where w.room_id = rid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                   and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval'));
end $$;

-- 쓰기: 서버가 정한 경로만 — 내 사람 글의 첨부 행(msgr2_attachment_add) 또는 내 리스의 업로드 슬롯(msgr2_link_upload_slot).
create or replace function public._msgr2_storage_write(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record; full_path text := 'msgr/' || p_name;
begin
  if rid is null or auth.uid() is null or public._msgr2_paused() then return false; end if;
  if public._msgr2_device_ok() and coalesce((public.msgr2_access(rid)).write, false) and exists (
       select 1 from public.msgr2_attachments a join public.msgr2_messages m on m.id = a.message_id
        where a.storage_path = full_path and a.room_id = rid and m.author_kind = 'user' and m.author_user_id = auth.uid() and m.deleted_at is null) then
    return true;
  end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_work_files f join public.msgr2_works w on w.id = f.work_id
                  where f.storage_path = full_path and f.room_id = rid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                    and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval'));
end $$;
-- v2 방 경로 문지기(restrictive): v2 방 경로가 아니면 참(옛 정책에 맡김), v2 방 경로면 v2 판정만(지우기는 거짓). 정책 식은 부른 사람 권한으로 돌므로 이 함수만 연다.
create or replace function public._msgr2_storage_gate(p_name text, p_op text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_storage_room(p_name) is null then return true; end if;
  return case p_op when 'select' then public._msgr2_storage_read(p_name) when 'write' then public._msgr2_storage_write(p_name) else false end;
end $$;
revoke all on function public._msgr2_storage_room(text), public._msgr2_storage_read(text), public._msgr2_storage_write(text), public._msgr2_storage_gate(text, text)
  from public, anon, authenticated;
grant execute on function public._msgr2_storage_read(text), public._msgr2_storage_write(text), public._msgr2_storage_gate(text, text) to authenticated;

drop policy if exists msgr2_files_select on storage.objects;
create policy msgr2_files_select on storage.objects for select to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_read(name) else false end);
drop policy if exists msgr2_files_insert on storage.objects;
create policy msgr2_files_insert on storage.objects for insert to authenticated
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end);
-- 다시 올리기(upsert)는 같은 경로 덮어쓰기 — 같은 판정
drop policy if exists msgr2_files_update on storage.objects;
create policy msgr2_files_update on storage.objects for update to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end)
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end);

-- 옛 정책(msgr_files_select·insert·delete, 20260903120000)이 v2 방 경로를 옛 <조직>/<채널>로 판정하지 못하게 — v2 방 경로는 v2 판정만(검수 #1076 높음 3)
drop policy if exists msgr2_files_gate_select on storage.objects;
create policy msgr2_files_gate_select on storage.objects as restrictive for select to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_gate(name, 'select') else true end);
drop policy if exists msgr2_files_gate_insert on storage.objects;
create policy msgr2_files_gate_insert on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_gate(name, 'write') else true end);
drop policy if exists msgr2_files_gate_update on storage.objects;
create policy msgr2_files_gate_update on storage.objects as restrictive for update to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_gate(name, 'write') else true end)
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_gate(name, 'write') else true end);
drop policy if exists msgr2_files_gate_delete on storage.objects;
create policy msgr2_files_gate_delete on storage.objects as restrictive for delete to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_gate(name, 'delete') else true end);

-- 옛 정리 후보(msgr_storage_sweep_list)에서 v2 파일 빼기(검수 #1076 높음 2). 본문은 20261011150000 그대로 + 제외 조건 세 줄.
-- 옛 함수가 없는 DB(v2만 있는 시험)에서는 만들지 않는다. 라이브 적용 전 라이브 prosrc를 저장소 20261011150000 정의와 대조한다.
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
       and public._msgr2_storage_room(o.name) is null -- v2 방 경로(<공간>/<방>/…)는 옛 정리 대상이 아니다
       and not exists (select 1 from public.msgr2_attachments a2 where a2.storage_path = 'msgr/' || o.name)
       and not exists (select 1 from public.msgr2_work_files f2 where f2.storage_path = 'msgr/' || o.name)
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $b$;
$f$;
  end if;
end $sw$;

-- ── 6. 보존(DB 위생 4) ──────────────────────────────────────────────────────────
-- 끝난 일(done·failed·cancelled, 또는 기한이 지난 offered)의 봉투 기록과 일 없는 agent.sync 기록 중 30일 지난 것. 지울 행이 없으면 쓰기 0.
-- 진행 중인 일(stalled 포함)의 기록은 남긴다 — 늦은 결과·중복 판정에 쓴다.
create or replace function public.msgr2_retention_prune() returns integer
  language sql volatile security definer set search_path = public, pg_temp as $$
  with d as (
    delete from public.msgr2_work_events e
     where e.created_at < now() - interval '30 days'
       and (e.work_id is null or exists (select 1 from public.msgr2_works w where w.id = e.work_id
              and (w.state in ('done', 'failed', 'cancelled') or (w.state = 'offered' and w.expires_at < now() - interval '30 days'))))
    returning 1)
  select count(*)::int from d
$$;
revoke all on function public.msgr2_retention_prune() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr2-retention-prune', '23 3 * * *', $c$select public.msgr2_retention_prune()$c$);
  end if;
end $$;

-- ── 7. 실행 권한 ────────────────────────────────────────────────────────────────
revoke all on function public._msgr2_send_u(uuid, text, jsonb), public._msgr2_send_s(uuid, text, jsonb), public._msgr2_room_humans(uuid),
  public._msgr2_msg_payload(public.msgr2_messages), public.msgr2_on_message_broadcast(), public.msgr2_on_pause_setting(), public.msgr2_on_user_gen()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
