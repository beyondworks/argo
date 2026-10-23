-- 되돌림: supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: msgr2_seat_ensure·_msgr2_session_untrusted를 지우고, msgr_delete_me 감싸개·사람 글 넣기 정책·msgr2_link_send·msgr2_link_upload_slot·_msgr2_rt_send_ok·_msgr2_storage_read·msgr2_message_ready·msgr2_lite_guard·msgr2_device_revoke를 직전 본문으로, msgr2_attachment_add·_msgr2_storage_write·_msgr2_bf_agents를 직전 본문(20261020200200·20261020200800·20261020200700)으로 되돌린다. 표·행은 바꾸지 않았다.
-- 앱이 msgr2_seat_ensure를 쓰기 시작한 뒤라면 되돌림 뒤 방에 넣기가 함수 없음으로 실패한다 — 앱을 먼저 되돌리거나 함께 되돌린다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr2_seat_ensure(uuid, uuid);
create or replace function public.msgr2_attachment_add(p_message bigint, p_index int, p_name text, p_mime text, p_bytes bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; sp uuid; nm text; obj text; aid bigint;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into m from public.msgr2_messages where id = p_message for update;
  if not found or m.author_kind <> 'user' or m.author_user_id <> uid or m.deleted_at is not null or not (select (public.msgr2_access(m.room_id)).write) then
    raise exception 'msgr2_message_not_found' using errcode = '42501';
  end if;
  nm := regexp_replace(regexp_replace(normalize(coalesce(p_name, ''), NFC), '[/\\[:cntrl:]]', '_', 'g'), '\.\.+', '_', 'g');
  if p_index is null or p_index not between 0 and 19 or nm in ('', '.') or char_length(nm) > 200 or p_bytes is null or p_bytes not between 0 and 52428800
     or (p_mime is not null and char_length(p_mime) > 200) then
    raise exception 'msgr2_bad_attachment' using errcode = '22023';
  end if;
  select r.space_id into sp from public.msgr2_rooms r where r.id = m.room_id;
  obj := sp::text || '/' || m.room_id::text || '/' || m.id::text || '/' || p_index::text || '-' || nm;
  select a.id into aid from public.msgr2_attachments a where a.message_id = m.id and a.storage_path like 'msgr/' || sp::text || '/' || m.room_id::text || '/' || m.id::text || '/' || p_index::text || '-%';
  if aid is not null then
    return jsonb_build_object('ok', true, 'attachment_id', aid, 'bucket', 'msgr', 'path', (select substr(storage_path, 6) from public.msgr2_attachments where id = aid), 'existing', true);
  end if;
  insert into public.msgr2_attachments (message_id, room_id, storage_path, name, mime, bytes) values (m.id, m.room_id, 'msgr/' || obj, nm, p_mime, p_bytes) returning id into aid;
  return jsonb_build_object('ok', true, 'attachment_id', aid, 'bucket', 'msgr', 'path', obj, 'existing', false);
end $$;

create or replace function public._msgr2_storage_write(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record; full_path text := 'msgr/' || p_name;
begin
  if rid is null or auth.uid() is null or public._msgr2_paused() then return false; end if;
  if split_part(p_name, '/', 1) = 'p' then return false; end if; -- 옛 개인 방 파일은 읽기 전용(덮어쓰지 않는다)
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
revoke all on function public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;
create or replace function public._msgr2_bf_agents(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  select count(*) into n from public.msgr_crews where agent_id is null;
  if n > 0 then raise exception 'msgr2_backfill_agent_ids_missing: % crews', n using errcode = '55000', hint = '먼저 select public.msgr_agents_backfill() (런북 2단계)'; end if;
  select count(*) into n from public.msgr2_agents v join public.msgr_agents a on (a.owner_user_id, a.ws_id, a.slug) = (v.owner_user_id, v.ws_id, v.slug) where a.id <> v.id;
  if n > 0 then raise exception 'msgr2_backfill_agent_id_conflict: % agents', n using errcode = '55000', hint = 'v2 agent.sync가 옛 에이전트와 다른 id로 먼저 등록했다(런북 함정 1)'; end if;
  insert into public.msgr2_agents as t (id, owner_user_id, ws_id, slug, display_name, role_text, face, hosting, status, created_at)
  select a.id, a.owner_user_id, a.ws_id, a.slug, left(coalesce(rep.display_name, a.slug), 80), left(coalesce(rep.role_text, ''), 200), rep.face,
         case when coalesce(bool_and_bot.all_bot, false) then 'bot' else 'local' end, case when rep.status = 'paused' then 'paused' else 'active' end, a.created_at
    from public.msgr_agents a
    left join lateral (select c.* from public.msgr_crews c where c.agent_id = a.id order by (c.org_id is null) desc, c.registered_at desc, c.id limit 1) rep on true
    left join lateral (select bool_and(c.hosting = 'bot') as all_bot from public.msgr_crews c where c.agent_id = a.id) bool_and_bot on true
  on conflict (id) do update set display_name = excluded.display_name, role_text = excluded.role_text, face = excluded.face,
    hosting = excluded.hosting, status = excluded.status, updated_at = now()
  where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from (excluded.display_name, excluded.role_text, excluded.face, excluded.hosting, excluded.status);
  get diagnostics written = row_count;
  done := true;
end $$;
do $do$ begin
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    execute $w$
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 계정 삭제를 잠시 막는다(스위치 직후 다시 열린다)'; end if;
  return public._msgr_delete_me_body();
end $f$
$w$;
    revoke all on function public.msgr_delete_me() from public, anon;
    grant execute on function public.msgr_delete_me() to authenticated;
  end if;
end $do$;

drop policy if exists msgr2_messages_insert on public.msgr2_messages;
create policy msgr2_messages_insert on public.msgr2_messages for insert to authenticated with check (
  author_kind = 'user' and author_user_id = (select auth.uid()) and author_agent_id is null and kind = 'text'
  and deleted_at is null and edited_at is null and meta = '{}'::jsonb
  and (reply_to is null or (select public._msgr2_msg_in_room(reply_to, room_id)))
  and (select (public.msgr2_access(room_id)).write));

create or replace function public.msgr2_link_send(p_env jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); dv record; c text; t text; d jsonb; w public.msgr2_works; ev public.msgr2_work_events; ns record;
  st text; same boolean; v_until timestamptz := now() + make_interval(secs => public._msgr2_setting_int('msgr2_lease_s', 600));
  lg int; mid bigint; x jsonb; slots uuid[]; n int; agents jsonb := '[]'::jsonb; v_late boolean; meta jsonb; ecode text; ap_exp timestamptz;
  feats text[]; posts jsonb; np int; nwid uuid;
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
    if not public._msgr2_pro_ok(uid) then return public._msgr2_rej('pro_required'); end if; -- A+ 메신저 Pro 전용(약속 v1.1)
    -- 저장은 정해진 필드만 골라 담는다(화이트리스트) — 본체가 bot.url·키를 실어 보내도 서버에 남지 않는다. 봇은 hosting='bot'만 기록
    perform public.msgr2_agent_sync(coalesce((select jsonb_agg(jsonb_build_object('ws_id', a->>'ws', 'slug', a->>'slug', 'display_name', a->>'name',
      'role_text', a->>'role', 'face', case when jsonb_typeof(a->'face_hash') = 'string' then jsonb_build_object('hash', a->>'face_hash') end,
      'hosting', case when a->>'kind' = 'bot' then 'bot' else 'local' end))
      from jsonb_array_elements(d->'agents') a), '[]'::jsonb));
    -- 기능 알림(v1.1). 없으면 v1.0 본체 = 빈 목록. 값이 바뀔 때만 쓴다(쉬는 동안 쓰기 0)
    select coalesce(array_agg(distinct f order by f), '{}') into feats from jsonb_array_elements_text(coalesce(d->'features', '[]'::jsonb)) f;
    update public.msgr2_devices set features = feats where id = dv.id and features is distinct from feats;
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
    -- A+ 회의 결과(약속 v1.1 서버 규칙): 회의가 아닌 일에 posts, 회의 일에 handoffs(posts 유무와 무관), 참가자 밖 글쓴이·라운드·개수 초과 → post_denied
    posts := coalesce(d->'posts', '[]'::jsonb); np := jsonb_array_length(posts);
    if (np > 0 and w.kind <> 'meeting') or (w.kind = 'meeting' and jsonb_array_length(d->'handoffs') > 0)
       or (np > 0 and (np > cardinality(w.meeting_agents) * w.meeting_rounds
                       or exists (select 1 from jsonb_array_elements(posts) p where not ((p->>'agent')::uuid = any (w.meeting_agents)) or (p->>'round')::int > w.meeting_rounds))) then
      return public._msgr2_rej('post_denied');
    end if;
    select coalesce(array_agg((f #>> '{}')::uuid), '{}') into slots from jsonb_array_elements(d->'files') f;
    if cardinality(slots) <> (select count(distinct s) from unnest(slots) s)
       or (select count(*) from public.msgr2_work_files wf where wf.id = any (slots) and wf.work_id = w.id) <> cardinality(slots) then
      return public._msgr2_rej('upload_slot_invalid');
    end if;
    meta := jsonb_build_object('work', w.id) || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end;
    if np > 0 then -- 회의: 에이전트별 글(글쓴이 = post.agent, meta.round). 요약 text는 방에 넣지 않는다. 파일은 마지막 글에
      for x in select p from jsonb_array_elements(posts) with ordinality as e(p, i) order by i loop
        insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
        values (w.room_id, w.topic_id, 'agent', (x->>'agent')::uuid, 'text', x->>'text',
                meta || jsonb_build_object('meeting', true, 'round', (x->>'round')::int), w.id) returning id into mid;
      end loop;
    else
      insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
      values (w.room_id, w.topic_id, 'agent', w.agent_id, 'text', d->>'text', meta, w.id) returning id into mid;
    end if;
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
      nwid := public._msgr2_make_offer(w.room_id, w.topic_id, (x->>'agent')::uuid, 'agent', w.agent_id, w.root_user_id, x->>'text', mid, w.id, w.depth + 1);
      -- R9: 넘김을 만들 때마다 연속 답장 수를 올린다 — 결과 1개가 넘김 8개를 한꺼번에 통과시키지 못하게(앞은 반복 전 한 번만 올렸다)
      if nwid is not null then perform public._msgr2_bump_streak(w.room_id); end if;
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

create or replace function public.msgr2_link_upload_slot(p_work uuid, p_name text, p_bytes bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); dv record; w public.msgr2_works; st text; nm text; sid uuid := gen_random_uuid(); obj text; sp uuid;
begin
  if uid is null then return public._msgr2_rej('device_unknown'); end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null then return public._msgr2_rej(dv.code); end if;
  if dv.kind not in ('runner', 'resident') then return public._msgr2_rej('device_unknown'); end if;
  if public._msgr2_paused() then return public._msgr2_rej('service_paused'); end if;
  select * into w from public.msgr2_works where id = p_work for update;
  if not found or w.owner_user_id <> uid then return public._msgr2_rej('work_not_found'); end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  if st in ('done', 'failed', 'cancelled', 'expired') then return public._msgr2_rej('work_closed'); end if;
  if w.lease_device is distinct from dv.id or st = 'stalled' then return public._msgr2_rej('not_lease_holder'); end if;
  if st not in ('accepted', 'running') then return public._msgr2_rej('invalid_transition'); end if;
  if w.tier = 'guest' then return public._msgr2_rej('tier_denied'); end if;
  nm := regexp_replace(coalesce(p_name, ''), '[/\\[:cntrl:]]', '_', 'g');
  nm := regexp_replace(nm, '\.\.+', '_', 'g'); -- 첨부 경로 검사(U1)가 '..'을 거부한다
  if nm in ('', '.', '..') or char_length(nm) > 200 or p_bytes is null or p_bytes < 0 or p_bytes > 52428800
     or (select count(*) from public.msgr2_work_files where work_id = w.id) >= 20 then
    return public._msgr2_rej('upload_slot_invalid');
  end if;
  select r.space_id into sp from public.msgr2_rooms r where r.id = w.room_id;
  obj := sp::text || '/' || w.room_id::text || '/' || sid::text || '/' || nm;
  insert into public.msgr2_work_files (id, work_id, room_id, name, bytes, storage_path) values (sid, w.id, w.room_id, nm, p_bytes, 'msgr/' || obj);
  return jsonb_build_object('ok', true, 'slot', sid, 'bucket', 'msgr', 'path', obj);
end $$;

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

create or replace function public.msgr2_message_ready(p_message bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; w public.msgr2_msg_waits; have int; ok int; k int;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into m from public.msgr2_messages where id = p_message;
  if m.id is null or m.author_kind <> 'user' or m.author_user_id <> uid then raise exception 'msgr2_message_not_found' using errcode = '42501'; end if;
  if exists (select 1 from public.msgr2_msg_waits x where x.author_user_id = uid and x.message_id <> p_message) then perform public._msgr2_flush_waits(null, uid); end if; -- 폴백 ②
  select * into w from public.msgr2_msg_waits where message_id = p_message for update;
  if w.message_id is null then return jsonb_build_object('ok', true, 'offers', 0); end if; -- 이미 만들었다(또는 기다림 없는 글)
  select count(*), count(*) filter (where exists (select 1 from storage.objects o
           where o.bucket_id = split_part(a.storage_path, '/', 1) and o.name = substr(a.storage_path, position('/' in a.storage_path) + 1)))
    into have, ok from public.msgr2_attachments a where a.message_id = m.id;
  if have < m.files_expected or ok < have then raise exception 'msgr2_attachment_missing' using errcode = '22023', detail = format('%s/%s', ok, m.files_expected); end if;
  delete from public.msgr2_msg_waits where message_id = p_message;
  k := public._msgr2_user_offers(m);
  return jsonb_build_object('ok', true, 'offers', k);
end $$;

create or replace function public.msgr2_lite_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s public.msgr2_spaces; r public.msgr2_rooms; n int; lite boolean; people boolean;
begin
  if uid is null then return new; end if; -- 서비스·이전 문맥
  lite := public._msgr2_lite(); people := public._msgr2_people();
  if not lite and not people and tg_table_name <> 'msgr2_room_members' then return new; end if;

  if tg_table_name = 'msgr2_spaces' then
    if lite and new.kind <> 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people and new.kind = 'team' and not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_space_invites' then
    if lite then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_space_invites i where i.created_by = uid and i.created_at > now() - interval '1 day';
      if n >= public._msgr2_clamp('msgr2_limit_invites_day', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'invites_day'; end if;
    end if;
    return new; -- 받는 사람의 요금제는 보지 않는다(수락 때 공간 멤버 관문)
  end if;

  if tg_table_name = 'msgr2_space_members' then
    if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if; -- 들어오기·되살리기만
    if people and exists (select 1 from public.msgr2_spaces x where x.id = new.space_id and x.kind = 'team') then -- 개인 공간(주인 1행)은 관문 밖
      if not public._msgr2_pro_ok(new.user_id) then
        raise exception '%', case when new.user_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
      end if;
      select count(*) into n from public.msgr2_space_members m
       where m.space_id = new.space_id and m.removed_at is null and m.user_id <> new.user_id and (m.expires_at is null or m.expires_at > now());
      if n >= public._msgr2_clamp('msgr2_limit_space_members', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'space_members'; end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_messages' then
    if new.author_kind <> 'user' then return new; end if;
    if lite and not public._msgr2_lite_room_ok(new.room_id) then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.author_kind = 'user' and m.author_user_id = uid and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_user_msg_min', 30, 120) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'user_messages'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.room_id = new.room_id and m.author_kind = 'user' and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_room_msg_min', 60, 300) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_messages'; end if;
    end if;
    return new;
  end if;

  -- msgr2_room_members: 새로 넣거나 빠졌던 멤버를 되살릴 때
  if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  if people and new.member_kind = 'user' then
    if not public._msgr2_pro_ok(new.member_id) then
      raise exception '%', case when new.member_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
    end if;
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'user' and m.removed_at is null and m.member_id <> new.member_id;
    if n >= public._msgr2_clamp('msgr2_limit_room_members', 50, 50) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_members'; end if;
  end if;
  if lite then
    if s.kind is distinct from 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if new.member_kind = 'user' then
      if new.member_id <> s.owner_user_id then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
      return new;
    end if;
    if not exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.owner_user_id = s.owner_user_id) then
      raise exception 'msgr2_lite_only' using errcode = '42501';
    end if;
  end if;
  if new.member_kind = 'agent' then
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id <> new.member_id;
    if r.meeting then -- 회의방 상한은 lite와 상관없이 늘
      if exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.hosting = 'bot') then
        raise exception 'msgr2_meeting_no_bot' using errcode = '22023';
      end if;
      if n >= public._msgr2_clamp('msgr2_meeting_agents', 5, 5) then raise exception 'msgr2_meeting_full' using errcode = '22023'; end if;
    elsif lite and n >= 1 then
      raise exception 'msgr2_lite_only' using errcode = '42501'; -- lite: 회의방이 아닌 방은 에이전트 1명(1:1)
    end if;
  end if;
  return new;
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
drop function if exists public._msgr2_session_untrusted();
drop function if exists public._msgr2_owner_active(uuid, uuid);
-- b(대화 삭제): 새 함수·정책을 지우고 msgr2_rate_guard·_msgr2_storage_gate를 직전 본문(20261020201600·20261020200300)으로
drop policy if exists msgr2_files_delete on storage.objects;
drop function if exists public.msgr2_room_delete(uuid);
drop function if exists public.msgr2_room_delete_files(uuid);
create or replace function public.msgr2_rate_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_people() then return coalesce(new, old); end if;
  if tg_table_name = 'msgr2_reactions' then
    perform public._msgr2_rate('reactions', 'minute', public._msgr2_clamp('msgr2_limit_reactions_min', 60, 120));
  elsif tg_op = 'INSERT' then -- msgr2_rooms
    perform public._msgr2_rate('room_create', 'minute', public._msgr2_clamp('msgr2_limit_room_create_min', 10, 30));
    perform public._msgr2_rate('room_create', 'day', public._msgr2_clamp('msgr2_limit_room_create_day', 200, 500));
  elsif new.archived_at is distinct from old.archived_at then
    perform public._msgr2_rate('room_archive', 'minute', public._msgr2_clamp('msgr2_limit_room_archive_min', 10, 30));
  end if;
  return coalesce(new, old);
end $$;
create or replace function public._msgr2_storage_gate(p_name text, p_op text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_storage_room(p_name) is null then return true; end if;
  return case p_op when 'select' then public._msgr2_storage_read(p_name) when 'write' then public._msgr2_storage_write(p_name) else false end;
end $$;
drop function if exists public._msgr2_storage_delete(text);
drop function if exists public._msgr2_room_delete_check(uuid, uuid);
drop function if exists public._msgr2_room_deletable(uuid, uuid);
-- F7: 새 함수만 지운다(표·행은 바꾸지 않았다)
drop function if exists public.msgr2_room_set(uuid, text, boolean, boolean);
drop function if exists public.msgr2_space_display_name_set(uuid, text);
drop function if exists public.msgr2_message_edit(bigint, text);
drop function if exists public.msgr2_message_delete(bigint);
-- S1·S3: 직전 본문(20261020201500·20261020200600)으로
create or replace function public._msgr2_user_offers(m public.msgr2_messages) returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[]; v_meeting boolean; parts uuid[]; k int := 0; w uuid;
begin
  if m.deleted_at is not null or m.author_kind <> 'user' then return 0; end if;
  select r.meeting into v_meeting from public.msgr2_rooms r where r.id = m.room_id;
  if coalesce(v_meeting, false) then
    select array_agg(q.member_id order by q.added_at, q.member_id) into parts from (
      select mm.member_id, mm.added_at from public.msgr2_room_members mm join public.msgr2_agents g on g.id = mm.member_id and g.status = 'active' and g.hosting = 'local'
       where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null
         and (cardinality(m.mentions) = 0 or mm.member_id = any (m.mentions))
       order by mm.added_at, mm.member_id limit public._msgr2_clamp('msgr2_meeting_agents', 5, 5)) q;
    if cardinality(parts) > 0 then
      w := public._msgr2_make_offer_x(m.room_id, m.topic_id, parts[1], 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0, parts);
      if w is not null then k := 1; end if;
    end if;
    return k;
  end if;
  if cardinality(m.mentions) > 0 then
    select array_agg(distinct mm.member_id) into targets from public.msgr2_room_members mm
      where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null and mm.member_id = any (m.mentions);
  elsif (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'user' and mm.removed_at is null and mm.member_id <> m.author_user_id) = 0
        and (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null) = 1 then
    select array_agg(mm.member_id) into targets from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null;
  end if;
  foreach ag in array coalesce(targets, '{}') loop
    w := public._msgr2_make_offer(m.room_id, m.topic_id, ag, 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0);
    if w is not null then k := k + 1; end if;
  end loop;
  return k;
end $$;

create or replace function public._msgr2_space_drop(p_space uuid, p_uid uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  update public.msgr2_space_members set removed_at = now() where space_id = p_space and user_id = p_uid and removed_at is null;
  perform public._msgr2_space_close(p_space, p_uid);
  perform public._msgr2_send_u(p_uid, 'spaces', jsonb_build_object('space_id', p_space, 'removed', true));
end $$;

commit;
