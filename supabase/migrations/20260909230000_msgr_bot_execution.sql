-- External runtimes share the resident execution ledger: no lease takeover and no offset-based execution rights.
-- Supabase may explicitly grant defaults to API roles; revoking PUBLIC alone leaves internal helpers exposed.
revoke execute on function public.msgr_bot_auth(text) from anon, authenticated;
revoke execute on function public.msgr_bot_hash(text) from anon, authenticated;

create or replace function public.msgr_bot_source(bot uuid, source bigint, channel uuid)
returns public.msgr_messages language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.msgr_crews; s public.msgr_messages; r public.msgr_messages; sender uuid; ch public.msgr_channels;
begin
  select * into c from public.msgr_crews where id = bot and hosting = 'bot' and status = 'active';
  select * into s from public.msgr_messages where id = source and channel_id = channel and deleted_at is null and kind = 'text';
  select * into ch from public.msgr_channels where id = channel and archived_at is null;
  if c.id is null or s.id is null or ch.id is null or c.org_id is distinct from s.org_id or ch.org_id is distinct from c.org_id
     or public.msgr_org_locked(c.org_id)
     or not exists (select 1 from public.msgr_org_members where org_id = c.org_id and user_id = c.owner_user_id and removed_at is null)
     or not (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members where channel_id = channel and member_kind = 'crew' and member_id = bot)) then
    raise exception 'msgr_not_allowed';
  end if;
  if s.author_kind = 'user' then
    r := s; sender := s.author_user_id;
  elsif s.author_kind = 'crew' and s.crew_id <> bot and s.meta->>'disposition' is distinct from 'done' then
    select * into r from public.msgr_messages where id = s.thread_root and author_kind = 'user' and deleted_at is null and channel_id = channel;
    select owner_user_id into sender from public.msgr_crews where id = s.crew_id and org_id = c.org_id and status = 'active';
    if (select count(*) from public.msgr_messages where thread_root = r.id and author_kind = 'crew' and kind = 'text') >= 10 then raise exception 'msgr_bot_handoff_limit'; end if;
  else raise exception 'msgr_not_allowed'; end if;
  if r.id is null or sender is null or not coalesce(public.msgr_can_instruct(bot, sender, channel), false)
     or not coalesce(public.msgr_can_instruct(bot, r.author_user_id, channel), false)
     or not exists (select 1 from public.msgr_org_members where org_id = c.org_id and user_id = r.author_user_id and removed_at is null)
     or not (s.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', bot::text))
       or (s.author_kind = 'user' and (ch.kind = 'dm' or exists (select 1 from public.msgr_messages p where p.id = s.reply_to and p.channel_id = channel and p.crew_id = bot)))) then
    raise exception 'msgr_not_allowed';
  end if;
  return s;
end $$;
revoke all on function public.msgr_bot_source(uuid, bigint, uuid) from public, anon, authenticated;

create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; s public.msgr_messages; attempt_id uuid; won uuid; lo bigint; peers jsonb; origin_user uuid; sent int := 0; root_msg public.msgr_messages; own_reply bigint; context_rows jsonb;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  update public.msgr_bots set last_seen_at = now() where id = b.id;
  update public.msgr_crews set last_seen_at = now(), cursor_msg_id = greatest(cursor_msg_id, coalesce(after_id, 0)) where id = b.crew_id returning cursor_msg_id into lo;
  -- No automatic takeover: surface uncertain long-running claims once instead of silently losing work.
  for s in select m.* from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
    where e.crew_id = b.crew_id and e.state = 'running' and e.heartbeat_at < now() - interval '10 minutes'
      and not exists (select 1 from public.msgr_messages notice where notice.channel_id = m.channel_id and notice.client_msg_id = 'unknown:' || b.crew_id::text || ':' || m.id::text) loop
    begin perform public.msgr_bot_source(b.crew_id, s.id, s.channel_id);
    exception when raise_exception then continue; end;
    insert into public.msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,meta)
      values(s.channel_id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),'unknown:' || b.crew_id::text || ':' || s.id::text,
        '외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. 자동으로 중복 실행하지 않습니다. / The external agent has not returned a result. Check its status; this request will not be executed again automatically.', '{"execution_status":"unknown","disposition":"done"}') on conflict do nothing;
  end loop;
  for s in select m.* from public.msgr_messages m where m.org_id = b.org_id and m.id > lo and m.deleted_at is null and m.kind = 'text'
    and m.author_kind in ('user', 'crew')
    and (m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', b.crew_id::text))
      or (m.author_kind = 'user' and (exists (select 1 from public.msgr_channels ch join public.msgr_channel_members cm on cm.channel_id = ch.id where ch.id = m.channel_id and ch.kind = 'dm' and cm.member_kind = 'crew' and cm.member_id = b.crew_id)
        or exists (select 1 from public.msgr_messages p where p.id = m.reply_to and p.channel_id = m.channel_id and p.crew_id = b.crew_id))))
    and not exists (select 1 from public.msgr_executions e where e.crew_id = b.crew_id and e.source_msg_id = m.id)
    order by m.id loop
    begin perform public.msgr_bot_source(b.crew_id, s.id, s.channel_id);
    exception when raise_exception then continue; end;
    if s.author_kind = 'user' then
      -- Mention order spans resident and external crews. Ineligible predecessors cannot block a turn.
      if s.created_at > now() - interval '10 minutes' and exists (
        select 1 from jsonb_array_elements(s.mentions) with ordinality prior(value, n)
        join public.msgr_crews c on c.id::text = prior.value->>'id' and prior.value->>'kind' = 'crew'
        where prior.n < (select min(n) from jsonb_array_elements(s.mentions) with ordinality own(value,n) where own.value->>'kind' = 'crew' and own.value->>'id' = b.crew_id::text)
          and c.status = 'active' and c.org_id = b.org_id and public.msgr_can_instruct(c.id, s.author_user_id, s.channel_id)
          and exists (select 1 from public.msgr_channels ch where ch.id = s.channel_id and (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'crew' and cm.member_id = c.id)))
          and not exists (select 1 from public.msgr_messages r where r.channel_id = s.channel_id and r.client_msg_id in ('reply:' || c.id::text || ':' || s.id::text, 'deny:' || c.id::text || ':' || s.id::text, 'stale:' || c.id::text || ':' || s.id::text, 'hopcap:' || c.id::text || ':' || s.id::text, 'ratecap:' || c.id::text || ':' || s.id::text))
      ) then return; end if; -- Preserve the oldest waiting source before any offset can acknowledge a later one.
    else
      select * into root_msg from public.msgr_messages where id = s.thread_root;
      if root_msg.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',b.crew_id::text)) then
        select min(id) into own_reply from public.msgr_messages where channel_id = s.channel_id and client_msg_id in
          ('reply:' || b.crew_id::text || ':' || root_msg.id::text, 'deny:' || b.crew_id::text || ':' || root_msg.id::text, 'stale:' || b.crew_id::text || ':' || root_msg.id::text);
        -- A handoff already visible to the bot's initial turn is context, not another execution.
        if own_reply is null or own_reply > s.id then continue; end if;
      end if;
    end if;
    attempt_id := gen_random_uuid(); won := null;
    insert into public.msgr_executions(crew_id, source_msg_id, attempt) values (b.crew_id, s.id, attempt_id)
      on conflict do nothing returning attempt into won;
    if won is null then continue; end if;
    if s.author_kind = 'user' then origin_user := s.author_user_id;
    else select author_user_id into origin_user from public.msgr_messages where id = s.thread_root; end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name)), '[]'::jsonb) into peers
      from public.msgr_crews c join public.msgr_channels ch on ch.id = s.channel_id
      where c.org_id = b.org_id and c.id <> b.crew_id and c.status = 'active'
        and public.msgr_can_instruct(c.id, origin_user, s.channel_id)
        and (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = s.channel_id and cm.member_kind = 'crew' and cm.member_id = c.id));
    select coalesce(jsonb_agg(row order by id), '[]'::jsonb) into context_rows from (
      select m.id, jsonb_build_object('message_id', m.id, 'text', m.body, 'author_kind', m.author_kind, 'crew_id', m.crew_id) as row
      from public.msgr_messages m where m.channel_id = s.channel_id and m.kind = 'text' and m.deleted_at is null
        and (m.id = case when s.author_kind = 'user' then s.id else s.thread_root end or m.thread_root = case when s.author_kind = 'user' then s.id else s.thread_root end)
        and (s.author_kind = 'user' or m.id <= s.id) order by m.id desc limit 12
    ) history;
    return next jsonb_build_object('update_id', s.id, 'message', jsonb_build_object(
      'message_id', s.id, 'execution_attempt', attempt_id, 'thread_root', coalesce(s.thread_root, s.id), 'origin_user_id', origin_user,
      'chat', (select jsonb_build_object('id', id, 'kind', kind, 'name', name) from public.msgr_channels where id = s.channel_id),
      'from', jsonb_build_object('id', coalesce(s.author_user_id, s.crew_id), 'kind', s.author_kind, 'name', coalesce(
        (select display_name from public.msgr_crews where id = s.crew_id),
        (select display_name from public.msgr_org_members where org_id = b.org_id and user_id = s.author_user_id), '')),
      'date', extract(epoch from s.created_at)::bigint, 'text', s.body, 'reply_to', s.reply_to, 'peers', peers, 'context', context_rows,
      'mentioned', s.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', b.crew_id::text))));
    sent := sent + 1;
    exit when sent >= greatest(1, least(coalesce(lim, 50), 100));
  end loop;
end $$;

create or replace function public.msgr_bot_finish(token text, channel uuid, body text, src_id bigint, attempt uuid, disposition text, mentions jsonb default '[]') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; s public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint; origin_user uuid; hop int; target jsonb; dest uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  s := public.msgr_bot_source(b.crew_id, src_id, channel);
  select * into e from public.msgr_executions where crew_id = b.crew_id and source_msg_id = src_id for update;
  if attempt is null or e.attempt is distinct from attempt then raise exception 'msgr_execution_not_owner'; end if;
  if e.state = 'completed' then return e.reply_id; end if;
  if disposition not in ('handoff', 'done') or disposition is null or jsonb_typeof(mentions) <> 'array' or mentions is null then raise exception 'msgr_bot_bad_disposition'; end if;
  if body is null or length(trim(body)) = 0 or length(body) > 20000 then raise exception 'msgr_bot_bad_body'; end if;
  root_id := case when s.author_kind = 'user' then s.id else s.thread_root end;
  select author_user_id into origin_user from public.msgr_messages where id = root_id;
  select count(*) into hop from public.msgr_messages where thread_root = root_id and author_kind = 'crew' and kind = 'text';
  if disposition = 'done' then mentions := '[]'; end if;
  if disposition = 'handoff' and (hop >= 10 or jsonb_array_length(mentions) > 5) then raise exception 'msgr_bot_handoff_limit'; end if;
  for target in select value from jsonb_array_elements(mentions) loop
    if target->>'kind' is distinct from 'crew' then raise exception 'msgr_not_allowed'; end if;
    begin dest := (target->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
    if dest is null or dest = b.crew_id or not exists (select 1 from public.msgr_crews c join public.msgr_channels ch on ch.id = channel
      where c.id = dest and c.org_id = b.org_id and c.status = 'active' and public.msgr_can_instruct(c.id, origin_user, channel)
      and public.msgr_can_instruct(c.id, (select owner_user_id from public.msgr_crews where id = b.crew_id), channel)
      and (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = channel and cm.member_kind = 'crew' and cm.member_id = c.id))) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', src_id, root_id, 'reply:' || b.crew_id::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;
revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;

-- Legacy replies use the same bot principal and its permanent claim; they cannot start a relay.
create or replace function public.msgr_bot_send(token text, channel uuid, body text, src_id bigint default null) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; mid bigint; legacy_attempt uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if src_id is not null then
    select e.attempt into legacy_attempt from public.msgr_executions e where e.crew_id = b.crew_id and e.source_msg_id = src_id;
    return public.msgr_bot_finish(token, channel, body, src_id, legacy_attempt, 'done', '[]');
  end if;
  if not exists (select 1 from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
  if public.msgr_org_locked(b.org_id) or not exists (select 1 from public.msgr_crews c join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = c.owner_user_id and m.removed_at is null where c.id = b.crew_id and c.status = 'active') then raise exception 'msgr_not_allowed'; end if;
  if not exists (select 1 from public.msgr_channels ch where ch.id = channel and (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members where channel_id = channel and member_kind = 'crew' and member_id = b.crew_id))) then raise exception 'msgr_bot_not_member'; end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', body, '[]', '{"disposition":"done"}') returning id into mid;
  return mid;
end $$;
notify pgrst, 'reload schema';
