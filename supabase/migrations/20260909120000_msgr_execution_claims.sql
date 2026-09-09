-- 두 기기가 같은 메시지를 읽어도 LLM/도구 실행은 한 번만. lease 만료로 실행권을 넘기지 않는다.
create table if not exists public.msgr_executions (
  crew_id uuid not null references public.msgr_crews(id) on delete cascade,
  source_msg_id bigint not null references public.msgr_messages(id) on delete cascade,
  attempt uuid not null,
  state text not null default 'running' check (state in ('running', 'completed')),
  started_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  reply_id bigint references public.msgr_messages(id) on delete set null,
  primary key (crew_id, source_msg_id)
);
alter table public.msgr_executions enable row level security;
revoke all on public.msgr_executions from anon, authenticated;
grant select on public.msgr_executions to authenticated;
drop policy if exists msgr_executions_select on public.msgr_executions;
create policy msgr_executions_select on public.msgr_executions for select to authenticated
  using (exists (select 1 from public.msgr_crews c where c.id = crew_id and c.owner_user_id = auth.uid())
    and exists (select 1 from public.msgr_messages m where m.id = source_msg_id and public.msgr_can_read_channel(m.channel_id)));

-- SECURITY DEFINER의 내부 관문: 요청 기기의 소유자·회사·채널·원문·원래 사람의 권한을 다시 확인한다.
create or replace function public.msgr_execution_source(p_ws text, p_crew uuid, p_source bigint, p_channel uuid)
returns public.msgr_messages language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.msgr_crews; src public.msgr_messages; root public.msgr_messages; sender uuid;
begin
  select * into c from public.msgr_crews where id = p_crew;
  if auth.uid() is null or c.owner_user_id is distinct from auth.uid() or c.ws_id is distinct from p_ws or c.status is distinct from 'active' then
    raise exception 'msgr_execution_forbidden' using errcode = '42501';
  end if;
  select * into src from public.msgr_messages where id = p_source;
  if src.id is null or src.deleted_at is not null or src.kind <> 'text' or src.org_id is distinct from c.org_id
     or src.channel_id is distinct from p_channel or not coalesce(public.msgr_can_write_channel(src.channel_id), false) then
    raise exception 'msgr_execution_source_forbidden' using errcode = '42501';
  end if;
  if not (src.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', p_crew::text)))
     and not (src.author_kind = 'user' and exists (select 1 from public.msgr_channels ch join public.msgr_channel_members m on m.channel_id = ch.id
       where ch.id = src.channel_id and ch.kind = 'dm' and m.member_kind = 'crew' and m.member_id = p_crew)) then
    raise exception 'msgr_execution_not_targeted' using errcode = '42501';
  end if;
  if src.author_kind = 'user' then
    root := src;
    sender := src.author_user_id;
  elsif src.author_kind = 'crew' and src.crew_id is distinct from p_crew and src.meta->>'origin' is not null then
    select * into root from public.msgr_messages where id = src.thread_root;
    select owner_user_id into sender from public.msgr_crews where id = src.crew_id and org_id = src.org_id;
  else
    raise exception 'msgr_execution_source_forbidden' using errcode = '42501';
  end if;
  if root.id is null or root.deleted_at is not null or root.author_kind <> 'user' or root.channel_id is distinct from src.channel_id
     or not coalesce(public.msgr_can_instruct(p_crew, sender, src.channel_id), false)
     or not coalesce(public.msgr_can_instruct(p_crew, root.author_user_id, src.channel_id), false) then
    raise exception 'msgr_execution_instruction_forbidden' using errcode = '42501';
  end if;
  return src;
end $$;
revoke all on function public.msgr_execution_source(text, uuid, bigint, uuid) from public, anon, authenticated;

create or replace function public.msgr_execution_claim(p_ws text, p_crew uuid, p_source bigint, p_channel uuid, p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.msgr_executions; won boolean;
begin
  perform public.msgr_execution_source(p_ws, p_crew, p_source, p_channel);
  if p_attempt is null then raise exception 'msgr_execution_attempt_required'; end if;
  insert into public.msgr_executions(crew_id, source_msg_id, attempt) values (p_crew, p_source, p_attempt)
    on conflict (crew_id, source_msg_id) do nothing returning * into e;
  won := found;
  if not won then select * into e from public.msgr_executions where crew_id = p_crew and source_msg_id = p_source; end if;
  return jsonb_build_object('acquired', won, 'state', e.state, 'heartbeat_at', e.heartbeat_at, 'reply_id', e.reply_id);
end $$;

create or replace function public.msgr_execution_heartbeat(p_ws text, p_crew uuid, p_source bigint, p_channel uuid, p_attempt uuid)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.msgr_execution_source(p_ws, p_crew, p_source, p_channel);
  update public.msgr_executions set heartbeat_at = now()
    where crew_id = p_crew and source_msg_id = p_source and attempt = p_attempt and state = 'running';
  return found;
end $$;

create or replace function public.msgr_execution_finish(p_ws text, p_crew uuid, p_source bigint, p_channel uuid, p_attempt uuid, p_reply jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare src public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint;
begin
  src := public.msgr_execution_source(p_ws, p_crew, p_source, p_channel);
  select * into e from public.msgr_executions where crew_id = p_crew and source_msg_id = p_source for update;
  if e.attempt is null or e.attempt is distinct from p_attempt then raise exception 'msgr_execution_not_owner' using errcode = '42501'; end if;
  if e.state = 'completed' then return jsonb_build_object('id', e.reply_id); end if;
  root_id := coalesce(src.thread_root, src.id);
  if p_reply->>'channel_id' is distinct from p_channel::text or p_reply->>'crew_id' is distinct from p_crew::text
     or p_reply->>'author_kind' is distinct from 'crew' or p_reply->>'kind' is distinct from 'text'
     or p_reply->>'client_msg_id' is distinct from ('reply:' || p_crew::text || ':' || p_source::text)
     or p_reply->>'reply_to' is distinct from p_source::text or p_reply->>'thread_root' is distinct from root_id::text then
    raise exception 'msgr_execution_reply_mismatch' using errcode = '42501';
  end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values (p_channel, 'crew', p_crew, 'text', p_source, root_id, 'reply:' || p_crew::text || ':' || p_source::text,
      p_reply->>'body', coalesce(p_reply->'mentions', '[]'::jsonb), coalesce(p_reply->'meta', '{}'::jsonb))
    on conflict do nothing returning id into rid;
  if rid is null then
    select id into rid from public.msgr_messages where channel_id = p_channel and author_kind = 'crew' and crew_id = p_crew
      and client_msg_id = 'reply:' || p_crew::text || ':' || p_source::text;
  end if;
  if rid is null then raise exception 'msgr_execution_reply_not_saved'; end if;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now()
    where crew_id = p_crew and source_msg_id = p_source;
  return jsonb_build_object('id', rid);
end $$;

revoke all on function public.msgr_execution_claim(text, uuid, bigint, uuid, uuid) from public, anon;
revoke all on function public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid) from public, anon;
revoke all on function public.msgr_execution_finish(text, uuid, bigint, uuid, uuid, jsonb) from public, anon;
grant execute on function public.msgr_execution_claim(text, uuid, bigint, uuid, uuid) to authenticated;
grant execute on function public.msgr_execution_heartbeat(text, uuid, bigint, uuid, uuid) to authenticated;
grant execute on function public.msgr_execution_finish(text, uuid, bigint, uuid, uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
