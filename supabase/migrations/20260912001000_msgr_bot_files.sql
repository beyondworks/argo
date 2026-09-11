-- 봇(외부 에이전트) 첨부 전달 — 유건 제보 2026-09-11 밤: 사람이 파일을 붙여 지시해도 VPS 크루(헤르메스 봇)에게 파일이 안 갔다.
-- 노드 크루는 attachmentsOf로 vault에 내려받지만 봇 API는 본문만 넘겼다. ① getUpdates 메시지에 attachments 목록(텔레그램 모양 file_id·file_name·mime_type·file_size)
-- ② getFile용 RPC msgr_bot_file — 봇이 그 채널에 있을 때만(msgr_crew_in_channel) 저장 경로를 돌려주고, 엣지 펑션이 서명 URL을 만든다(버킷 정책은 사람 세션 기준이라 봇은 서명 URL로만).
-- msgr_bot_updates 본문은 20260909230000의 정의를 그대로 복사하고 attachments 키 한 줄만 더했다(생성 스크립트가 원문에서 복사 — 손으로 옮기지 않았다).
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
      'date', extract(epoch from s.created_at)::bigint, 'text', s.body, 'reply_to', s.reply_to,
      'attachments', (select coalesce(jsonb_agg(jsonb_build_object('file_id', a.id, 'file_name', a.name, 'mime_type', a.mime, 'file_size', a.bytes) order by a.created_at), '[]'::jsonb) from public.msgr_attachments a where a.message_id = s.id),
      'peers', peers, 'context', context_rows,
      'mentioned', s.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', b.crew_id::text))));
    sent := sent + 1;
    exit when sent >= greatest(1, least(coalesce(lim, 50), 100));
  end loop;
end $$;

create or replace function public.msgr_bot_file(token text, attachment uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; a public.msgr_attachments; ch uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select a2.* into a from public.msgr_attachments a2 where a2.id = attachment and a2.org_id = b.org_id;
  if a.id is null then raise exception 'msgr_bot_no_file'; end if;
  select m.channel_id into ch from public.msgr_messages m where m.id = a.message_id and m.deleted_at is null;
  if ch is null then raise exception 'msgr_bot_no_file'; end if;
  if not public.msgr_crew_in_channel(ch, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  return jsonb_build_object('file_id', a.id, 'file_name', a.name, 'mime_type', a.mime, 'file_size', a.bytes, 'storage_path', a.storage_path);
end $$;
revoke all on function public.msgr_bot_file(text, uuid) from public;
grant execute on function public.msgr_bot_file(text, uuid) to anon, authenticated;
notify pgrst, 'reload schema';
