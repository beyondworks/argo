-- DM delegates have request-scoped capabilities, never channel membership or channel RLS access.
alter table public.msgr_crews add column dm_delivery_protocol smallint not null default 0 check(dm_delivery_protocol in (0,1));
create table public.msgr_dm_grants (
 root_message_id bigint not null references public.msgr_messages(id) on delete cascade,
 crew_id uuid not null references public.msgr_crews(id) on delete cascade,
 role text not null check(role in ('to','cc')),
 source_message_id bigint not null references public.msgr_messages(id) on delete cascade,
 sender_crew_id uuid references public.msgr_crews(id) on delete cascade,
 primary key(root_message_id,crew_id,source_message_id)
);
alter table public.msgr_dm_grants enable row level security;
revoke all on public.msgr_dm_grants from public,anon,authenticated;

create function public.msgr_to_mentioned(p_mentions jsonb,p_crew uuid) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select exists(select 1 from jsonb_array_elements(coalesce(p_mentions,'[]')) x where x->>'kind'='crew' and x->>'id'=p_crew::text and coalesce(x->>'role','to')='to')
$$;
create function public.msgr_has_to(p_mentions jsonb) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select exists(select 1 from jsonb_array_elements(coalesce(p_mentions,'[]')) x where x->>'kind'='crew' and coalesce(x->>'role','to')='to')
$$;
create function public.msgr_dm_actor(p_crew uuid,p_root bigint) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from msgr_messages r join msgr_channels ch on ch.id=r.channel_id join msgr_crews c on c.id=p_crew and c.org_id=ch.org_id
 where r.id=p_root and r.author_kind='user' and r.deleted_at is null and ch.kind='dm' and ch.archived_at is null
 and not msgr_org_locked(ch.org_id) and c.status='active'
 and exists(select 1 from msgr_org_members m where m.org_id=ch.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()))
 and exists(select 1 from msgr_org_members m join msgr_channel_members cm on cm.channel_id=ch.id and cm.member_kind='user' and cm.member_id=m.user_id where m.org_id=ch.org_id and m.user_id=r.author_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()))
 and msgr_can_instruct(c.id,r.author_user_id,ch.id))
$$;
create function public.msgr_dm_grant_chain(p_crew uuid,p_root bigint,p_execute boolean,p_seen uuid[] default '{}') returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare g record;
begin
 if not msgr_dm_actor(p_crew,p_root) or p_crew=any(p_seen) or cardinality(p_seen)>12 then return false; end if;
 if exists(select 1 from msgr_messages r where r.id=p_root and msgr_crew_in_channel(r.channel_id,p_crew)) then return true; end if;
 for g in select d.*,sender.owner_user_id,s.meta,s.mentions,r.channel_id from msgr_dm_grants d
 join msgr_messages s on s.id=d.source_message_id and s.deleted_at is null and s.thread_root=d.root_message_id
 join msgr_messages r on r.id=d.root_message_id
 left join msgr_crews sender on sender.id=d.sender_crew_id and sender.status='active'
 where d.root_message_id=p_root and d.crew_id=p_crew and (not p_execute or d.role='to') loop
   if g.sender_crew_id is null then return true; end if;
   if g.owner_user_id is not null and g.meta->>'disposition' is distinct from 'done'
   and msgr_can_instruct(p_crew,g.owner_user_id,g.channel_id)
   and msgr_dm_grant_chain(g.sender_crew_id,p_root,true,p_seen||p_crew) then return true; end if;
 end loop;
 return false;
end $$;
create function public.msgr_dm_access(p_crew uuid,p_root bigint,p_execute boolean default false) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select msgr_dm_grant_chain(p_crew,p_root,p_execute,'{}')
$$;
-- To is a per-message decision. A previous To grant must not turn a later CC into work.
create function public.msgr_delivery_target(p_crew uuid,p_source bigint) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from msgr_messages s join msgr_channels ch on ch.id=s.channel_id where s.id=p_source and s.deleted_at is null and s.kind='text'
 and (msgr_to_mentioned(s.mentions,p_crew)
 or (s.author_kind='user' and ch.kind='dm' and not msgr_has_to(s.mentions) and not exists(select 1 from jsonb_array_elements(s.mentions) cc where cc->>'kind'='crew' and cc->>'id'=p_crew::text and cc->>'role'='cc') and msgr_crew_in_channel(ch.id,p_crew))
 or (s.author_kind='user' and ch.kind<>'dm' and exists(select 1 from msgr_messages p where p.id=s.reply_to and p.channel_id=ch.id and p.crew_id=p_crew)))
 and (s.author_kind='user' or (s.author_kind='crew' and s.crew_id<>p_crew and s.meta->>'disposition' is distinct from 'done')))
$$;
create function public.msgr_delivery_allowed(p_crew uuid,p_source bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s msgr_messages; r msgr_messages; c msgr_crews; ch msgr_channels; sender uuid;
begin
 select * into s from msgr_messages where id=p_source;
 select * into ch from msgr_channels where id=s.channel_id;
 select * into c from msgr_crews where id=p_crew;
 select * into r from msgr_messages where id=case when s.author_kind='user' then coalesce(s.thread_root,s.id) else s.thread_root end;
 if not coalesce(msgr_delivery_target(p_crew,p_source),false) or c.id is null or c.status<>'active' or c.org_id is distinct from ch.org_id or ch.archived_at is not null or msgr_org_locked(ch.org_id)
 or r.id is null or r.author_kind<>'user' or r.deleted_at is not null or r.channel_id is distinct from ch.id then return false; end if;
 if not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=c.owner_user_id and removed_at is null and (expires_at is null or expires_at>now()))
 or not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=r.author_user_id and removed_at is null and (expires_at is null or expires_at>now())) then return false; end if;
 if s.author_kind='user' then sender:=s.author_user_id;
 else select owner_user_id into sender from msgr_crews where id=s.crew_id and org_id=c.org_id and status='active'; end if;
 if sender is null or not coalesce(msgr_can_instruct(c.id,sender,ch.id),false) or not coalesce(msgr_can_instruct(c.id,r.author_user_id,ch.id),false) then return false; end if;
 if ch.kind='dm' then
   if (not msgr_crew_in_channel(ch.id,c.id) and c.dm_delivery_protocol<1) or not msgr_dm_access(c.id,r.id,true) then return false; end if;
 else
   if not msgr_crew_in_channel(ch.id,c.id) then return false; end if;
 end if;
 if ch.kind='dm' and exists(select 1 from msgr_work_runs w where w.root_message_id=r.id and w.channel_id=ch.id and (w.status<>'running' or s.id<coalesce(w.last_resume_message_id,0))) then return false; end if;
 if s.author_kind='crew' and (select count(*) from msgr_messages where thread_root=r.id and channel_id=ch.id and author_kind='crew' and kind='text' and id>coalesce(msgr_work_round_start(r.id,ch.id),0))>=10 then return false; end if;
 return true;
end $$;

-- Passive copies are delivered without an execution claim or response authority.
create function public.msgr_cc_delivery_allowed(p_crew uuid,p_source bigint) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from msgr_messages s join msgr_channels ch on ch.id=s.channel_id and ch.kind='dm'
 where s.id=p_source and s.deleted_at is null and s.kind='text'
 and not msgr_to_mentioned(s.mentions,p_crew)
 and exists(select 1 from jsonb_array_elements(s.mentions) x where x->>'kind'='crew' and x->>'id'=p_crew::text and x->>'role'='cc')
 and (s.author_kind='user' or s.meta->>'disposition' is distinct from 'done')
 and msgr_dm_access(p_crew,coalesce(s.thread_root,s.id),false)
 and not exists(select 1 from msgr_work_runs w where w.root_message_id=coalesce(s.thread_root,s.id) and w.channel_id=ch.id and w.status<>'running'))
$$;

create function public.msgr_dm_candidates(p_channel uuid) returns setof jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not coalesce(msgr_can_write_channel(p_channel),false) or not exists(select 1 from msgr_channels where id=p_channel and kind='dm') then raise exception 'msgr_forbidden' using errcode='42501'; end if;
 return query select jsonb_build_object('id',c.id,'display_name',c.display_name,'role_text',c.role_text,'slug',c.slug,'owner_user_id',c.owner_user_id,'ws_id',c.ws_id,'delivery_protocol',c.dm_delivery_protocol,'delivery_ready',msgr_crew_in_channel(p_channel,c.id) or c.dm_delivery_protocol>=1)
 from msgr_crews c join msgr_channels ch on ch.id=p_channel and ch.org_id=c.org_id
 where c.status='active' and msgr_can_instruct(c.id,auth.uid(),p_channel)
 and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
end $$;

-- Human inserts can only authorize the message they actually posted. Crew inserts derive authority
-- from an existing source and recheck the sender's To grant; client-supplied origin/hop are not proof.
create function public.msgr_dm_message_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; r msgr_messages; s msgr_messages; dest uuid; x jsonb; sender uuid;
begin
 select * into ch from msgr_channels where id=new.channel_id;
 if ch.kind<>'dm' then return new; end if;
 if ch.archived_at is not null or msgr_org_locked(ch.org_id) then raise exception 'msgr_not_allowed'; end if;
 if new.author_kind='user' then
   if not exists(select 1 from msgr_channel_members where channel_id=ch.id and member_kind='user' and member_id=new.author_user_id) then raise exception 'msgr_not_allowed'; end if;
   if new.thread_root is null then new.thread_root:=new.id; end if;
   if new.thread_root<>new.id then
     select * into r from msgr_messages where id=new.thread_root and channel_id=ch.id and author_kind='user' and deleted_at is null;
     if r.id is null or r.author_user_id is distinct from new.author_user_id then raise exception 'msgr_not_allowed'; end if;
   end if;
   sender:=new.author_user_id;
 elsif new.author_kind='crew' then
   if new.reply_to is null and msgr_crew_in_channel(ch.id,new.crew_id) then
     new.mentions:='[]'; new.thread_root:=null; new.meta:=(coalesce(new.meta,'{}')-'origin'-'hop')||'{"disposition":"done"}'::jsonb; return new;
   end if;
   select * into s from msgr_messages where id=new.reply_to and channel_id=ch.id;
   if s.id is null or not msgr_delivery_allowed(new.crew_id,s.id) then raise exception 'msgr_not_allowed'; end if;
   new.thread_root:=coalesce(s.thread_root,s.id);
   select * into r from msgr_messages where id=new.thread_root;
   select owner_user_id into sender from msgr_crews where id=new.crew_id;
   new.meta:=coalesce(new.meta,'{}') || jsonb_build_object('origin',r.author_user_id,'hop',(select count(*) from msgr_messages where thread_root=r.id and channel_id=ch.id and author_kind='crew' and kind='text'));
   if new.meta->>'disposition'='done' then new.mentions:='[]'; end if;
 else return new; end if;
 for x in select value from jsonb_array_elements(coalesce(new.mentions,'[]')) loop
   if x->>'kind'<>'crew' then continue; end if;
   if coalesce(x->>'role','to') not in ('to','cc') then raise exception 'msgr_bad_delivery_role'; end if;
   begin dest:=(x->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
   if exists(select 1 from msgr_crews c where c.id=dest and c.org_id=ch.org_id and c.dm_delivery_protocol<1) and not msgr_crew_in_channel(ch.id,dest) then raise exception 'msgr_runtime_update_required'; end if;
   if not exists(select 1 from msgr_crews c where c.id=dest and c.org_id=ch.org_id and c.status='active'
     and msgr_can_instruct(c.id,sender,ch.id) and msgr_can_instruct(c.id,coalesce(r.author_user_id,new.author_user_id),ch.id)
     and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()))) then raise exception 'msgr_not_allowed'; end if;
 end loop;
 return new;
end $$;
create trigger b_msgr_dm_message_guard before insert on public.msgr_messages for each row execute function public.msgr_dm_message_guard();
create function public.msgr_dm_message_grant() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from msgr_channels where id=new.channel_id and kind='dm') and new.author_kind in ('user','crew') then
 insert into msgr_dm_grants(root_message_id,crew_id,role,source_message_id,sender_crew_id)
 select new.thread_root,(x->>'id')::uuid,case when bool_or(coalesce(x->>'role','to')='to') then 'to' else 'cc' end,new.id,new.crew_id
 from jsonb_array_elements(new.mentions) x where x->>'kind'='crew' group by x->>'id'
 on conflict(root_message_id,crew_id,source_message_id) do nothing;
 end if; return new;
end $$;
create trigger msgr_dm_message_grant after insert on public.msgr_messages for each row execute function public.msgr_dm_message_grant();
create or replace function public.msgr_messages_crew_scope_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.author_kind='crew' and new.crew_id is not null and not msgr_crew_in_channel(new.channel_id,new.crew_id)
 and not (exists(select 1 from msgr_channels where id=new.channel_id and kind='dm') and msgr_delivery_allowed(new.crew_id,new.reply_to)) then raise exception 'msgr_crew_not_in_channel' using errcode='42501',hint='이 채널에 초대되지 않았거나 내보낸 에이전트입니다'; end if;
 return new;
end $$;

create function public.msgr_crew_inbox(p_ws text,p_crew uuid,p_after bigint default 0,p_limit int default 100) returns setof public.msgr_messages
language plpgsql security definer set search_path=public,pg_temp as $$
declare c msgr_crews;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 if c.id is null then raise exception 'msgr_execution_forbidden' using errcode='42501'; end if;
 update msgr_crews set dm_delivery_protocol=1 where id=c.id;
 return query select m.* from msgr_messages m join msgr_channels ch on ch.id=m.channel_id where m.org_id=c.org_id and m.id>p_after and m.deleted_at is null
 and (msgr_can_read_channel(ch.id) or (ch.kind='dm' and (msgr_delivery_allowed(c.id,m.id) or msgr_cc_delivery_allowed(c.id,m.id)))) order by m.id limit greatest(1,least(p_limit,200));
end $$;
create function public.msgr_crew_context(p_ws text,p_crew uuid,p_source bigint,p_channel uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare c msgr_crews; s msgr_messages; r msgr_messages; ch msgr_channels; ctx jsonb; peers jsonb; actor uuid;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 select * into s from msgr_messages where id=p_source and channel_id=p_channel;
 if c.id is null or s.id is null or not (msgr_delivery_allowed(p_crew,p_source) or msgr_cc_delivery_allowed(p_crew,p_source)) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into ch from msgr_channels where id=p_channel;
 if ch.kind<>'dm' and not msgr_can_read_channel(p_channel) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 actor:=case when s.author_kind='user' then s.author_user_id else (select owner_user_id from msgr_crews where id=s.crew_id) end;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'slug',p.slug,'display_name',p.display_name,'role_text',p.role_text,'owner_user_id',p.owner_user_id,'ws_id',p.ws_id,'hosting',p.hosting,'allow',p.allow,'allow_users',p.allow_users,'work_protocol',p.work_protocol,'dm_delivery_protocol',p.dm_delivery_protocol)),'[]') into peers from msgr_crews p where p.org_id=c.org_id and p.status='active'
 and msgr_can_instruct(p.id,r.author_user_id,p_channel) and msgr_can_instruct(p.id,c.owner_user_id,p_channel)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(p_channel,p.id) or p.dm_delivery_protocol>=1) else msgr_crew_in_channel(p_channel,p.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=p.org_id and m.user_id=p.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into ctx from (
 select m.* from msgr_messages m where m.channel_id=p_channel and m.kind='text' and m.deleted_at is null
 and (case when ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id) then (m.id=r.id or m.thread_root=r.id) else (m.id<s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) end) order by m.id desc limit 12) h;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'id')::bigint=r.id) then ctx:=jsonb_build_array(to_jsonb(r))||ctx; end if;
 return jsonb_build_object('source',to_jsonb(s),'root',to_jsonb(r),'channel',jsonb_build_object('id',ch.id,'org_id',ch.org_id,'kind',ch.kind,'name',ch.name,'crew_memory',ch.crew_memory,'archived_at',ch.archived_at,'excluded_crew_ids',ch.excluded_crew_ids),'org',(select jsonb_build_object('id',o.id,'slug',o.slug,'name',o.name) from msgr_orgs o where o.id=ch.org_id),'peers',peers,'context',ctx,
 'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id),'delivery_role',case when msgr_cc_delivery_allowed(c.id,s.id) then 'cc' else 'to' end,'actor',actor,
 'attachments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from msgr_attachments a where a.message_id=s.id),
 'settled_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||s.id,'deny:'||c.id||':'||s.id,'stale:'||c.id||':'||s.id,'hopcap:'||c.id||':'||s.id,'ratecap:'||c.id||':'||s.id)),
 'settled_root',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id)),
 'settled_root_before_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id) and m.id<s.id),
 'auto_turns',(select count(*) from msgr_messages m where m.channel_id=ch.id and m.thread_root=r.id and m.author_kind='crew' and m.kind='text' and (m.meta->>'hop') ~ '^[1-9][0-9]*$' and m.id>coalesce(msgr_work_round_start(r.id,ch.id),0)),
 'settled_predecessors',(select coalesce(jsonb_agg(distinct m.crew_id),'[]') from msgr_messages m where m.channel_id=ch.id and m.reply_to=s.id and m.author_kind='crew' and m.client_msg_id in ('reply:'||m.crew_id||':'||s.id,'deny:'||m.crew_id||':'||s.id,'stale:'||m.crew_id||':'||s.id,'hopcap:'||m.crew_id||':'||s.id,'ratecap:'||m.crew_id||':'||s.id)));
end $$;

-- Keep public/private source checks, but add scoped DM authorization and role-aware targeting.
create or replace function public.msgr_execution_source(p_ws text,p_crew uuid,p_source bigint,p_channel uuid) returns public.msgr_messages
language plpgsql security definer set search_path=public,pg_temp as $$
declare c msgr_crews; s msgr_messages;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 select * into s from msgr_messages where id=p_source and channel_id=p_channel;
 if c.id is null then raise exception 'msgr_execution_forbidden' using errcode='42501'; end if;
 if s.id is null or not msgr_delivery_allowed(c.id,s.id) or (not msgr_can_write_channel(p_channel) and not exists(select 1 from msgr_channels where id=p_channel and kind='dm' and msgr_dm_access(c.id,coalesce(s.thread_root,s.id),true))) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 return s;
end $$;

create or replace function public.msgr_bot_source(bot uuid,source bigint,channel uuid) returns public.msgr_messages
language plpgsql security definer set search_path=public,pg_temp as $$
declare s msgr_messages;
begin
 select * into s from msgr_messages where id=source and channel_id=channel;
 if s.id is null or not exists(select 1 from msgr_crews where id=bot and hosting='bot') or not msgr_delivery_allowed(bot,source) then raise exception 'msgr_not_allowed'; end if;
 return s;
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
  select count(*) into hop from public.msgr_messages where thread_root = root_id and channel_id=channel and author_kind = 'crew' and kind = 'text' and id>coalesce(public.msgr_work_round_start(root_id,channel),0);
  if disposition = 'done' then mentions := '[]'; end if;
  if disposition = 'handoff' and (hop >= 10 or jsonb_array_length(mentions) > 5) then raise exception 'msgr_bot_handoff_limit'; end if;
  for target in select value from jsonb_array_elements(mentions) loop
    if target->>'kind' is distinct from 'crew' then raise exception 'msgr_not_allowed'; end if;
    begin dest := (target->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
    if dest is null or dest = b.crew_id or not exists (select 1 from public.msgr_crews c join public.msgr_channels ch on ch.id = channel
      where c.id = dest and c.org_id = b.org_id and c.status = 'active' and public.msgr_can_instruct(c.id, origin_user, channel)
      and public.msgr_can_instruct(c.id, (select owner_user_id from public.msgr_crews where id = b.crew_id), channel)
      and (ch.kind = 'dm' or ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = channel and cm.member_kind = 'crew' and cm.member_id = c.id))) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', src_id, root_id, 'reply:' || b.crew_id::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;
revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;


-- The work wrapper continues to decorate this function; never replace it with the old poll body.
create or replace function public.msgr_bot_updates_before_work(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; s msgr_messages; r msgr_messages; a uuid; won uuid; peers jsonb; ctx jsonb; n int:=0; lo bigint; actor uuid; ch msgr_channels;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 update msgr_bots set last_seen_at=now() where id=b.id;
 update msgr_crews set last_seen_at=now(),cursor_msg_id=greatest(cursor_msg_id,coalesce(after_id,0)) where id=b.crew_id returning cursor_msg_id into lo;
 for s in select m.* from msgr_executions e join msgr_messages m on m.id=e.source_msg_id
 where e.crew_id=b.crew_id and e.state='running' and e.heartbeat_at<now()-interval '10 minutes' and msgr_delivery_allowed(b.crew_id,m.id)
 and not exists(select 1 from msgr_messages x where x.channel_id=m.channel_id and x.client_msg_id='unknown:'||b.crew_id||':'||m.id) loop
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,meta)
 values(s.channel_id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),'unknown:'||b.crew_id||':'||s.id,'외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. / The external agent has not returned a result. Check its status.','{"execution_status":"unknown","disposition":"done"}') on conflict do nothing;
 end loop;
 for s in select m.* from msgr_messages m where m.org_id=b.org_id and (m.id>lo or (current_setting('argo.msgr_delivery_protocol',true)='1' and exists(select 1 from msgr_dm_grants g where g.source_message_id=m.id and g.crew_id=b.crew_id and g.role='to')))
 and (current_setting('argo.msgr_delivery_protocol',true)='1' or not exists(select 1 from msgr_channels d where d.id=m.channel_id and d.kind='dm' and not msgr_crew_in_channel(d.id,b.crew_id)))
 and (msgr_delivery_allowed(b.crew_id,m.id) or (current_setting('argo.msgr_delivery_protocol',true)='1' and msgr_cc_delivery_allowed(b.crew_id,m.id)))
 and not exists(select 1 from msgr_executions e where e.crew_id=b.crew_id and e.source_msg_id=m.id) order by m.id loop
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 select * into ch from msgr_channels where id=s.channel_id;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='user' and s.created_at>now()-interval '10 minutes' and exists(
   select 1 from jsonb_array_elements(s.mentions) with ordinality prev(x,pos)
   where prev.x->>'kind'='crew' and coalesce(prev.x->>'role','to')='to'
   and prev.pos<(select min(pos) from jsonb_array_elements(s.mentions) with ordinality own(x,pos) where own.x->>'id'=b.crew_id::text and coalesce(own.x->>'role','to')='to')
   and msgr_delivery_allowed((prev.x->>'id')::uuid,s.id)
   and not exists(select 1 from msgr_messages answer where answer.channel_id=s.channel_id and answer.crew_id::text=prev.x->>'id' and answer.reply_to=s.id)
 ) then return; end if;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='crew' and msgr_delivery_target(b.crew_id,r.id)
 and not exists(select 1 from msgr_messages answer where answer.channel_id=s.channel_id and answer.crew_id=b.crew_id and answer.reply_to=r.id and answer.id<s.id) then continue; end if;
 a:=null; won:=null;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) then
 a:=gen_random_uuid();
 insert into msgr_executions(crew_id,source_msg_id,attempt) values(b.crew_id,s.id,a) on conflict do nothing returning attempt into won;
 if won is null then continue; end if;
 end if;
 actor:=r.author_user_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.display_name)),'[]') into peers
 from msgr_crews c where c.org_id=b.org_id and c.status='active' and c.id<>b.crew_id
 and msgr_can_instruct(c.id,actor,ch.id) and msgr_can_instruct(c.id,(select owner_user_id from msgr_crews where id=b.crew_id),ch.id)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(ch.id,c.id) or c.dm_delivery_protocol>=1) else msgr_crew_in_channel(ch.id,c.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 select coalesce(jsonb_agg(h.row order by h.id),'[]') into ctx from (
 select m.id,jsonb_build_object('message_id',m.id,'text',m.body,'author_kind',m.author_kind,'crew_id',m.crew_id,'mentions',m.mentions) row
 from msgr_messages m where m.channel_id=ch.id and m.kind='text' and m.deleted_at is null and (case when ch.kind='dm' and msgr_crew_in_channel(ch.id,b.crew_id) then (m.id<=s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) else (m.id=r.id or m.thread_root=r.id) end)
 and (s.author_kind='user' or m.id<=s.id) order by m.id desc limit 12) h;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'message_id')::bigint=r.id) then ctx:=jsonb_build_array(jsonb_build_object('message_id',r.id,'text',r.body,'author_kind',r.author_kind,'crew_id',r.crew_id,'mentions',r.mentions))||ctx; end if;
 return next jsonb_build_object('update_id',s.id,'message',jsonb_build_object(
 'message_id',s.id,'execution_attempt',a,'delivery_role',case when a is null then 'cc' else 'to' end,'thread_root',r.id,'origin_user_id',actor,'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,b.crew_id),
 'chat',jsonb_build_object('id',ch.id,'kind',ch.kind,'name',ch.name),
 'from',jsonb_build_object('id',coalesce(s.author_user_id,s.crew_id),'kind',s.author_kind,'name',coalesce((select display_name from msgr_crews where id=s.crew_id),(select display_name from msgr_org_members where org_id=b.org_id and user_id=s.author_user_id),'')),
 'date',extract(epoch from s.created_at)::bigint,'text',s.body,'reply_to',s.reply_to,'peers',peers,'context',ctx,
 'attachments',(select coalesce(jsonb_agg(jsonb_build_object('file_id',f.id,'file_name',f.name,'mime_type',f.mime,'file_size',f.bytes)),'[]') from msgr_attachments f where f.message_id=s.id),
 'mentioned',msgr_to_mentioned(s.mentions,b.crew_id)));
 n:=n+1; exit when n>=greatest(1,least(coalesce(lim,50),100));
 end loop;
end $$;

-- Grant reads are separately available for passive CC; they never acquire an execution.
create function public.msgr_crew_thread(p_ws text,p_crew uuid,p_root bigint) returns setof public.msgr_messages
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws) or not msgr_dm_access(p_crew,p_root,false) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 return query select m.* from msgr_messages m join msgr_messages r on r.id=p_root where m.channel_id=r.channel_id and (m.id=r.id or m.thread_root=r.id) and m.deleted_at is null order by m.id;
end $$;

create or replace function public.msgr_bot_file(token text,attachment uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; a msgr_attachments; s msgr_messages; ch msgr_channels;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 select * into a from msgr_attachments where id=attachment and org_id=b.org_id;
 select * into s from msgr_messages where id=a.message_id and deleted_at is null;
 select * into ch from msgr_channels where id=s.channel_id and archived_at is null;
 if a.id is null or s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>s.org_id::text or split_part(a.storage_path,'/',2)<>s.channel_id::text or split_part(a.storage_path,'/',3)<>s.id::text then raise exception 'msgr_bot_no_file'; end if;
 if ch.kind='dm' then
   if not msgr_crew_in_channel(ch.id,b.crew_id) and not msgr_dm_access(b.crew_id,coalesce(s.thread_root,s.id),false) then raise exception 'msgr_bot_not_member'; end if;
 elsif not msgr_crew_in_channel(ch.id,b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
 return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
end $$;
-- Optional source/attempt identifies a currently running delegated turn; the legacy member call remains valid.
create function public.msgr_bot_typing(token text,channel uuid,src_id bigint,attempt uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 if not exists(select 1 from msgr_channels where id=channel and org_id=b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
 if not msgr_crew_in_channel(channel,b.crew_id) and not exists(select 1 from msgr_executions e join msgr_messages s on s.id=e.source_msg_id
 where e.crew_id=b.crew_id and e.source_msg_id=src_id and e.attempt=$4 and e.state='running' and s.channel_id=channel and msgr_delivery_allowed(b.crew_id,s.id)) then raise exception 'msgr_bot_not_member'; end if;
 perform realtime.send(jsonb_build_object('channel_id',channel,'crew_id',b.crew_id),'typing','org:'||b.org_id,true);
end $$;

-- Editing body remains supported; routing identity cannot be moved after capabilities were issued.
create function public.msgr_dm_routing_immutable() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from msgr_channels where id=old.channel_id and kind='dm')
 and (new.mentions is distinct from old.mentions or (new.thread_root is distinct from old.thread_root and not (pg_trigger_depth()>1 and new.thread_root is null)) or (new.reply_to is distinct from old.reply_to and not (pg_trigger_depth()>1 and new.reply_to is null)) or new.meta is distinct from old.meta)
 then raise exception 'msgr_dm_routing_immutable' using errcode='42501'; end if;
 return new;
end $$;
create trigger msgr_dm_routing_immutable before update on public.msgr_messages for each row execute function public.msgr_dm_routing_immutable();

revoke all on function public.msgr_cc_delivery_allowed(uuid,bigint),public.msgr_dm_grant_chain(uuid,bigint,boolean,uuid[]),public.msgr_to_mentioned(jsonb,uuid),public.msgr_has_to(jsonb),public.msgr_dm_actor(uuid,bigint),public.msgr_dm_access(uuid,bigint,boolean),public.msgr_delivery_target(uuid,bigint),public.msgr_delivery_allowed(uuid,bigint),public.msgr_dm_message_guard(),public.msgr_dm_message_grant(),public.msgr_dm_routing_immutable(),public.msgr_crew_inbox(text,uuid,bigint,int),public.msgr_crew_context(text,uuid,bigint,uuid),public.msgr_crew_thread(text,uuid,bigint),public.msgr_dm_candidates(uuid),public.msgr_bot_typing(text,uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.msgr_crew_inbox(text,uuid,bigint,int),public.msgr_crew_context(text,uuid,bigint,uuid),public.msgr_crew_thread(text,uuid,bigint),public.msgr_dm_candidates(uuid) to authenticated;
grant execute on function public.msgr_bot_typing(text,uuid,bigint,uuid) to anon,authenticated;
notify pgrst,'reload schema';

-- A delegated owner may download exactly the attachment path in its granted request, not a DM directory.
create function public.msgr_can_read_dm_attachment(p_path text) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select auth.uid() is not null and exists(
 select 1 from msgr_attachments a join msgr_messages m on m.id=a.message_id and m.deleted_at is null
 join msgr_channels ch on ch.id=m.channel_id and ch.kind='dm'
 join msgr_crews c on c.org_id=ch.org_id and c.owner_user_id=auth.uid() and c.status='active'
 where a.storage_path=p_path and split_part(p_path,'/',1)=m.org_id::text and split_part(p_path,'/',2)=m.channel_id::text and split_part(p_path,'/',3)=m.id::text and msgr_dm_access(c.id,coalesce(m.thread_root,m.id),false))
$$;
revoke all on function public.msgr_can_read_dm_attachment(text) from public,anon;
grant execute on function public.msgr_can_read_dm_attachment(text) to authenticated;
create policy msgr_dm_attachment_read on storage.objects for select to authenticated
 using(bucket_id='msgr' and public.msgr_can_read_dm_attachment(name));
notify pgrst,'reload schema';

-- Output writes are tied to a persisted execution reply, never an arbitrary channel path.
create function public.msgr_can_write_dm_output(p_path text,p_message bigint default null) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare parts text[]; mid bigint;
begin
 parts:=string_to_array(p_path,'/');
 if auth.uid() is null or cardinality(parts)<>4 or parts[4] in ('','.','..') or parts[3]!~'^[0-9]+$' then return false; end if;
 begin mid:=parts[3]::bigint; exception when numeric_value_out_of_range then return false; end;
 if p_message is not null and p_message<>mid then return false; end if;
 return exists(select 1 from msgr_messages m join msgr_crews c on c.id=m.crew_id and c.owner_user_id=auth.uid()
 join msgr_executions e on e.crew_id=c.id and e.source_msg_id=m.reply_to and e.state='completed'
 and (e.reply_id=m.id or m.client_msg_id like 'followup:'||c.id||':%')
 join msgr_channels ch on ch.id=m.channel_id and ch.kind='dm'
 where m.id=mid and m.author_kind='crew' and m.deleted_at is null and ch.id::text=parts[2] and ch.org_id::text=parts[1]
 and msgr_dm_access(c.id,m.thread_root,true));
end $$;
revoke all on function public.msgr_can_write_dm_output(text,bigint) from public,anon;
grant execute on function public.msgr_can_write_dm_output(text,bigint) to authenticated;
create policy msgr_dm_output_insert on storage.objects for insert to authenticated
 with check(bucket_id='msgr' and public.msgr_can_write_dm_output(name));
create policy msgr_dm_output_attachment on public.msgr_attachments for insert to authenticated
 with check(org_id::text=split_part(storage_path,'/',1) and public.msgr_can_write_dm_output(storage_path,message_id));

alter table public.msgr_crew_approvals add column dm_source_msg_id bigint references public.msgr_messages(id) on delete set null;
create function public.msgr_can_read_dm_approval(p_approval uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from msgr_crew_approvals a join msgr_crews c on c.id=a.crew_id and c.owner_user_id=auth.uid()
 join msgr_messages s on s.id=a.dm_source_msg_id and s.channel_id=a.channel_id and s.deleted_at is null
 where a.id=p_approval and msgr_dm_access(c.id,coalesce(s.thread_root,s.id),true))
$$;
revoke all on function public.msgr_can_read_dm_approval(uuid) from public,anon;
grant execute on function public.msgr_can_read_dm_approval(uuid) to authenticated;
create policy msgr_dm_approval_owner_read on public.msgr_crew_approvals for select to authenticated
 using(public.msgr_can_read_dm_approval(id));
create function public.msgr_create_thread_approval(p_ws text,p_crew uuid,p_source bigint,p_channel uuid,p_approval jsonb,p_body text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s msgr_messages; c msgr_crews; a msgr_crew_approvals; mid bigint; root_id bigint;
begin
 s:=msgr_execution_source(p_ws,p_crew,p_source,p_channel);
 select * into c from msgr_crews where id=p_crew;
 root_id:=coalesce(s.thread_root,s.id);
 if not exists(select 1 from msgr_channels where id=p_channel and kind='dm') or not exists(select 1 from msgr_executions where crew_id=p_crew and source_msg_id=p_source)
 or coalesce(p_approval->>'approval_id','')='' or coalesce(p_approval->>'action','')='' or p_body is null or length(trim(p_body))=0 then raise exception 'msgr_not_allowed'; end if;
 perform pg_advisory_xact_lock(hashtext('msgr-dm-approval:'||p_crew||':'||(p_approval->>'approval_id')));
 select * into a from msgr_crew_approvals where crew_id=p_crew and approval_id=p_approval->>'approval_id';
 if a.id is not null then
   if a.channel_id is distinct from p_channel or a.dm_source_msg_id is distinct from p_source or a.action is distinct from p_approval->>'action' then raise exception 'msgr_approval_conflict'; end if;
   return jsonb_build_object('approval',jsonb_build_object('id',a.id),'message',jsonb_build_object('id',a.message_id));
 end if;
 insert into msgr_crew_approvals(org_id,channel_id,crew_id,approval_id,action,reason,risk,kind,payload,dm_source_msg_id)
 values(c.org_id,p_channel,p_crew,p_approval->>'approval_id',p_approval->>'action',p_approval->>'reason',coalesce(p_approval->>'risk','low'),coalesce(p_approval->>'kind','action'),p_approval->'payload',p_source) returning * into a;
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,mentions)
 values(p_channel,'crew',p_crew,'approval_card',p_source,root_id,'ap:'||p_crew||':'||a.approval_id,p_body,jsonb_build_array(jsonb_build_object('kind','approval','id',a.id))) returning id into mid;
 update msgr_crew_approvals set message_id=mid where id=a.id;
 return jsonb_build_object('approval',jsonb_build_object('id',a.id),'message',jsonb_build_object('id',mid));
end $$;
revoke all on function public.msgr_create_thread_approval(text,uuid,bigint,uuid,jsonb,text) from public,anon;
grant execute on function public.msgr_create_thread_approval(text,uuid,bigint,uuid,jsonb,text) to authenticated;
notify pgrst,'reload schema';

create function public.msgr_dm_approval_source_immutable() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.dm_source_msg_id is not null and new.dm_source_msg_id is distinct from old.dm_source_msg_id then raise exception 'msgr_dm_routing_immutable' using errcode='42501'; end if; return new;
end $$;
revoke all on function public.msgr_dm_approval_source_immutable() from public,anon,authenticated;
create trigger msgr_dm_approval_source_immutable before update on public.msgr_crew_approvals for each row execute function public.msgr_dm_approval_source_immutable();

-- Compatibility handshake: old adapters never receive a passive copy they could mistake for work.
create function public.msgr_bot_updates_with_delivery(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare old_protocol text;
begin
 if (msgr_bot_auth(token)).id is null then raise exception 'msgr_bot_unauthorized'; end if;
 update msgr_crews set dm_delivery_protocol=1 where id=(msgr_bot_auth(token)).crew_id;
 old_protocol:=current_setting('argo.msgr_delivery_protocol',true);
 perform set_config('argo.msgr_delivery_protocol','1',true);
 return query select * from msgr_bot_updates(token,after_id,lim);
 perform set_config('argo.msgr_delivery_protocol',coalesce(old_protocol,''),true);
end $$;
revoke all on function public.msgr_bot_updates_with_delivery(text,bigint,int) from public;
grant execute on function public.msgr_bot_updates_with_delivery(text,bigint,int) to anon,authenticated;
create index if not exists msgr_attachments_storage_path_idx on public.msgr_attachments(storage_path);
notify pgrst,'reload schema';

-- Delayed delegated results keep the same request capability and cannot choose another DM.
create function public.msgr_post_thread_followup(p_ws text,p_crew uuid,p_source bigint,p_channel uuid,p_body text,p_client_msg_id text,p_mentions jsonb default '[]',p_meta jsonb default '{}',p_approval uuid default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s msgr_messages; prior msgr_messages; mid bigint; client_id text;
begin
 s:=msgr_execution_source(p_ws,p_crew,p_source,p_channel);
 if not exists(select 1 from msgr_channels where id=p_channel and kind='dm')
 or not exists(select 1 from msgr_executions where crew_id=p_crew and source_msg_id=p_source and state='completed')
 or p_body is null or length(trim(p_body))=0 or length(p_body)>20000 or coalesce(p_client_msg_id,'')='' or length(p_client_msg_id)>200
 or jsonb_typeof(p_mentions) is distinct from 'array' or jsonb_typeof(p_meta) is distinct from 'object'
 or coalesce(p_meta->>'disposition','') not in ('done','handoff') then raise exception 'msgr_not_allowed'; end if;
 if p_approval is not null and not exists(select 1 from msgr_crew_approvals where id=p_approval and crew_id=p_crew and channel_id=p_channel and dm_source_msg_id=p_source and status in ('approved','rejected')) then raise exception 'msgr_not_allowed'; end if;
 client_id:='followup:'||p_crew||':'||p_client_msg_id;
 perform pg_advisory_xact_lock(hashtext(client_id));
 select * into prior from msgr_messages where crew_id=p_crew and client_msg_id=client_id;
 if prior.id is not null then
   if prior.channel_id is distinct from p_channel or prior.reply_to is distinct from p_source then raise exception 'msgr_followup_conflict'; end if;
   return jsonb_build_object('id',prior.id);
 end if;
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,mentions,meta)
 values(p_channel,'crew',p_crew,'text',p_source,coalesce(s.thread_root,s.id),client_id,p_body,p_mentions,p_meta) returning id into mid;
 return jsonb_build_object('id',mid);
end $$;
revoke all on function public.msgr_post_thread_followup(text,uuid,bigint,uuid,text,text,jsonb,jsonb,uuid) from public,anon;
grant execute on function public.msgr_post_thread_followup(text,uuid,bigint,uuid,text,text,jsonb,jsonb,uuid) to authenticated;
notify pgrst,'reload schema';
