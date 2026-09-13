-- Connections stay on their owner's Argo node. This directory contains no credentials.
create table public.msgr_notification_routes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  ws_id text not null check (length(ws_id) between 1 and 200),
  kind text not null check (kind in ('telegram','slack')),
  label text not null check (length(label) between 1 and 120),
  ready boolean not null default false,
  last_seen_at timestamptz not null default now(),
  unique(owner_user_id,ws_id,kind)
);
alter table public.msgr_notification_routes enable row level security;
revoke all on public.msgr_notification_routes from public,anon,authenticated;
grant select on public.msgr_notification_routes to authenticated;
create policy msgr_notification_routes_read on public.msgr_notification_routes for select to authenticated using(owner_user_id=auth.uid());
create table public.msgr_notification_route_nodes (
  route_id uuid not null references public.msgr_notification_routes(id) on delete cascade,
  device_id text not null check(length(device_id) between 1 and 200),
  ready boolean not null,
  last_seen_at timestamptz not null default now(),
  primary key(route_id,device_id)
);
alter table public.msgr_notification_route_nodes enable row level security;
revoke all on public.msgr_notification_route_nodes from public,anon,authenticated;
grant select on public.msgr_notification_route_nodes to authenticated;
create policy msgr_notification_route_nodes_read on public.msgr_notification_route_nodes for select to authenticated
  using(exists(select 1 from public.msgr_notification_routes r where r.id=route_id and r.owner_user_id=auth.uid()));
alter table public.msgr_automations add column notification_route_ids uuid[] not null default '{}';
alter table public.msgr_automation_runs add column notification_route_ids uuid[] not null default '{}';
alter table public.msgr_automation_runs add column notification_owner_id uuid references auth.users(id) on delete cascade;
alter table public.msgr_automation_runs add column notification_title text;
create table public.msgr_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.msgr_automation_runs(id) on delete cascade,
  route_id uuid not null references public.msgr_notification_routes(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','claimed','sent','failed','uncertain','skipped')),
  attempt uuid,
  device_id text,
  claimed_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique(run_id,route_id)
);
create index msgr_notification_pending on public.msgr_notification_deliveries(owner_user_id,created_at) where status='pending';
create index msgr_notification_claimed on public.msgr_notification_deliveries(owner_user_id,claimed_at) where status='claimed';
alter table public.msgr_notification_deliveries enable row level security;
revoke all on public.msgr_notification_deliveries from public,anon,authenticated;
grant select on public.msgr_notification_deliveries to authenticated;
create policy msgr_notification_deliveries_read on public.msgr_notification_deliveries for select to authenticated using(owner_user_id=auth.uid());

create function public.msgr_notification_routes_sync(p_ws text,p_routes jsonb,p_device text default 'legacy') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; rid uuid;
begin
  if auth.uid() is null then raise exception 'msgr_notification_forbidden' using errcode='42501'; end if;
  if p_device is null or length(p_device) not between 1 and 200 or p_ws is null or length(btrim(p_ws)) not between 1 and 200 or jsonb_typeof(p_routes) is distinct from 'array'
    or jsonb_array_length(p_routes)>2 then raise exception 'msgr_notification_invalid_routes'; end if;
  if exists(select 1 from jsonb_array_elements(p_routes) x where jsonb_typeof(x) <> 'object'
    or coalesce(x->>'kind','') not in ('telegram','slack') or jsonb_typeof(x->'ready') is distinct from 'boolean'
    or length(coalesce(btrim(x->>'label'),'')) not between 1 and 120)
    or (select count(*)<>count(distinct x->>'kind') from jsonb_array_elements(p_routes) x) then raise exception 'msgr_notification_invalid_routes'; end if;
  update public.msgr_notification_route_nodes n set ready=false,last_seen_at=now()
    from public.msgr_notification_routes r where n.route_id=r.id and r.owner_user_id=auth.uid() and r.ws_id=p_ws and n.device_id=p_device;
  for r in select value from jsonb_array_elements(p_routes) loop
    insert into public.msgr_notification_routes(owner_user_id,ws_id,kind,label,ready,last_seen_at)
      values(auth.uid(),p_ws,r->>'kind',btrim(r->>'label'),(r->>'ready')::boolean,now())
      on conflict(owner_user_id,ws_id,kind) do update set label=excluded.label,last_seen_at=now() returning id into rid;
    insert into public.msgr_notification_route_nodes(route_id,device_id,ready,last_seen_at) values(rid,p_device,(r->>'ready')::boolean,now())
      on conflict(route_id,device_id) do update set ready=excluded.ready,last_seen_at=now();
  end loop;
  update public.msgr_notification_routes r set ready=exists(select 1 from public.msgr_notification_route_nodes n where n.route_id=r.id and n.ready and n.last_seen_at>=now()-interval '3 minutes')
    where r.owner_user_id=auth.uid() and r.ws_id=p_ws;
  return coalesce((select jsonb_agg(to_jsonb(x)-'owner_user_id' order by x.kind) from public.msgr_notification_routes x where owner_user_id=auth.uid() and ws_id=p_ws),'[]');
end $$;
create function public.msgr_notification_routes_list() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg((to_jsonb(x)-'owner_user_id')||jsonb_build_object('ready',exists(select 1 from public.msgr_notification_route_nodes n where n.route_id=x.id and n.ready and n.last_seen_at>=now()-interval '3 minutes')) order by x.ws_id,x.kind),'[]') from public.msgr_notification_routes x where owner_user_id=auth.uid()
$$;

create function public.msgr_automation_save_with_notifications(automation uuid,channel uuid,crew uuid,title text,prompt text,schedule jsonb,request_id uuid default null,notification_route_ids uuid[] default '{}') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a jsonb; ids uuid[]; existing public.msgr_automations;
begin
  if auth.uid() is null then raise exception 'msgr_notification_forbidden' using errcode='42501'; end if;
  if notification_route_ids is null or cardinality(notification_route_ids)>20 or array_position(notification_route_ids,null) is not null then raise exception 'msgr_notification_invalid_routes'; end if;
  select coalesce(array_agg(distinct id order by id),'{}') into ids from unnest(notification_route_ids) id;
  if exists(select 1 from unnest(ids) wanted where not exists(select 1 from public.msgr_notification_routes r where r.id=wanted and r.owner_user_id=auth.uid())) then
    raise exception 'msgr_notification_route_forbidden' using errcode='42501'; end if;
  if automation is null and request_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text||request_id::text,0));
    select * into existing from public.msgr_automations where created_by=auth.uid() and create_request_id=request_id;
    if found then
      if existing.deleted_at is not null or not public.msgr_automation_authorized(auth.uid(),existing.channel_id,existing.crew_id) then
        raise exception 'msgr_automation_forbidden' using errcode='42501'; end if;
      return to_jsonb(existing);
    end if;
  end if;
  a:=public.msgr_automation_save(automation,channel,crew,title,prompt,schedule,request_id);
  -- Preserve creation idempotency, including its first selected destinations.
  select * into existing from public.msgr_automations where id=(a->>'id')::uuid for update;
  update public.msgr_automations set notification_route_ids=ids where id=existing.id returning to_jsonb(msgr_automations.*) into a;
  return a;
end $$;

create function public.msgr_notification_run_snapshot() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  select a.notification_route_ids,a.created_by,a.title into new.notification_route_ids,new.notification_owner_id,new.notification_title
    from public.msgr_automations a where a.id=new.automation_id;
  return new;
end $$;
create trigger msgr_notification_run_snapshot before insert on public.msgr_automation_runs for each row execute function public.msgr_notification_run_snapshot();

create function public.msgr_notification_run_terminal() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.status not in ('completed','failed','blocked') then return new; end if;
  -- Only actual execution results qualify. Client-writable message meta is never an authority.
  if new.status in ('completed','failed') and not exists(select 1 from public.msgr_executions e
    join public.msgr_messages source on source.id=e.source_msg_id
    join public.msgr_messages reply on reply.id=e.reply_id and reply.reply_to=source.id and reply.channel_id=source.channel_id and reply.crew_id=e.crew_id
    where e.source_msg_id=new.message_id and e.state='completed' and e.reply_id=new.reply_id
      and source.author_kind='user' and source.author_user_id=new.notification_owner_id
      and source.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',e.crew_id))) then return new; end if;
  insert into public.msgr_notification_deliveries(run_id,route_id,owner_user_id)
    select new.id,r.id,new.notification_owner_id from public.msgr_notification_routes r
    where r.id=any(new.notification_route_ids) and r.owner_user_id=new.notification_owner_id
    on conflict(run_id,route_id) do nothing;
  return new;
end $$;
create trigger msgr_notification_run_terminal after insert or update of status on public.msgr_automation_runs for each row execute function public.msgr_notification_run_terminal();

create function public.msgr_notification_claim(p_ws text,p_attempt uuid,p_device text default 'legacy') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare d record; result jsonb:='[]';
begin
  if auth.uid() is null or p_attempt is null or p_device is null or length(p_device) not between 1 and 200 then raise exception 'msgr_notification_forbidden' using errcode='42501'; end if;
  -- A vanished sender may have delivered before crashing. Never automatically resend an uncertain attempt.
  update public.msgr_notification_deliveries x set status='uncertain',error='delivery_unconfirmed',finished_at=now()
    from public.msgr_notification_routes r where x.route_id=r.id and x.owner_user_id=auth.uid() and r.ws_id=p_ws and x.status='claimed' and x.claimed_at<now()-interval '5 minutes';
  update public.msgr_notification_deliveries x set status='skipped',error='delivery_expired',finished_at=now()
    from public.msgr_notification_routes r where x.route_id=r.id and x.owner_user_id=auth.uid() and r.ws_id=p_ws and x.status='pending' and x.created_at<now()-interval '24 hours';
  update public.msgr_notification_deliveries x set status='skipped',error='permission_revoked',finished_at=now()
    from public.msgr_notification_routes r,public.msgr_automation_runs run,public.msgr_automations a
    where x.route_id=r.id and x.run_id=run.id and run.automation_id=a.id and x.owner_user_id=auth.uid() and r.ws_id=p_ws
      and x.status='pending' and (a.created_by is distinct from auth.uid() or not public.msgr_can_read_channel(a.channel_id));
  for d in select x.id,r.id as route_id,r.kind,r.ws_id,n.ready,n.last_seen_at,run.id as run_id,run.status as run_status,run.notification_title,
      run.message_id,run.reply_id,a.channel_id,a.created_by,reply.body,reply.deleted_at
    from public.msgr_notification_deliveries x join public.msgr_notification_routes r on r.id=x.route_id
    join public.msgr_notification_route_nodes n on n.route_id=r.id and n.device_id=p_device
    join public.msgr_automation_runs run on run.id=x.run_id join public.msgr_automations a on a.id=run.automation_id
    left join public.msgr_messages reply on reply.id=run.reply_id
    where x.owner_user_id=auth.uid() and r.owner_user_id=auth.uid() and r.ws_id=p_ws and x.status='pending' and n.ready and n.last_seen_at>=now()-interval '3 minutes'
    order by x.created_at limit 5 for update of x skip locked
  loop
    if d.created_by is distinct from auth.uid() or not public.msgr_can_read_channel(d.channel_id)
      or (d.reply_id is not null and (d.body is null or d.deleted_at is not null)) then
      update public.msgr_notification_deliveries set status='skipped',error='destination_unavailable',finished_at=now() where id=d.id;
      continue;
    end if;
    if not d.ready or d.last_seen_at<now()-interval '3 minutes' then continue; end if;
    if d.run_status not in ('completed','failed','blocked') then continue; end if;
    update public.msgr_notification_deliveries set status='claimed',attempt=p_attempt,device_id=p_device,claimed_at=now() where id=d.id;
    result:=result||jsonb_build_array(jsonb_build_object('delivery_id',d.id,'run_id',d.run_id,'route_id',d.route_id,'kind',d.kind,'ws_id',d.ws_id,
      'title',d.notification_title,'body',case when d.run_status='blocked' then '' else coalesce(d.body,'') end,'status',d.run_status));
  end loop;
  return result;
end $$;
-- Recheck immediately before the network send, including waits behind other destinations.
create function public.msgr_notification_authorize(p_delivery uuid,p_attempt uuid) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare d record; why text;
begin
  select x.id,n.ready,n.last_seen_at,a.channel_id,a.created_by,run.notification_owner_id,run.status as run_status,run.message_id,run.reply_id,
    reply.body,reply.deleted_at into d
    from public.msgr_notification_deliveries x join public.msgr_notification_routes r on r.id=x.route_id
    left join public.msgr_notification_route_nodes n on n.route_id=r.id and n.device_id=x.device_id
    join public.msgr_automation_runs run on run.id=x.run_id join public.msgr_automations a on a.id=run.automation_id
    left join public.msgr_messages reply on reply.id=run.reply_id
    where x.id=p_delivery and x.owner_user_id=auth.uid() and r.owner_user_id=auth.uid() and x.status='claimed' and x.attempt=p_attempt
    for update of x;
  if not found then return false; end if;
  if d.created_by is distinct from auth.uid() or d.notification_owner_id is distinct from auth.uid() or not public.msgr_can_read_channel(d.channel_id) then
    why:='permission_revoked';
  elsif d.ready is distinct from true or d.last_seen_at is null or d.last_seen_at<now()-interval '3 minutes' or d.run_status not in ('completed','failed','blocked')
    or (d.reply_id is not null and (d.body is null or d.deleted_at is not null)) then why:='destination_unavailable';
  elsif d.run_status in ('completed','failed') and not exists(select 1 from public.msgr_executions e
    join public.msgr_messages source on source.id=e.source_msg_id and source.deleted_at is null
    join public.msgr_messages reply on reply.id=e.reply_id and reply.reply_to=source.id and reply.channel_id=source.channel_id and reply.crew_id=e.crew_id
    where e.source_msg_id=d.message_id and e.state='completed' and e.reply_id=d.reply_id
      and source.author_kind='user' and source.author_user_id=d.notification_owner_id
      and source.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',e.crew_id))) then why:='destination_unavailable';
  end if;
  if why is not null then
    update public.msgr_notification_deliveries set status='skipped',error=why,finished_at=now() where id=d.id;
    return false;
  end if;
  return true;
end $$;
create function public.msgr_notification_finish(p_delivery uuid,p_attempt uuid,p_status text,p_error text default null) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null or p_status is null or p_status not in ('sent','failed','uncertain','skipped') then raise exception 'msgr_notification_invalid_status'; end if;
  update public.msgr_notification_deliveries set status=p_status,finished_at=now(),
    error=case when p_status='sent' then null else case when p_error in ('destination_unavailable','delivery_failed','delivery_unconfirmed','permission_revoked') then p_error else 'delivery_failed' end end
    where id=p_delivery and owner_user_id=auth.uid() and status='claimed' and attempt=p_attempt;
  return found;
end $$;
revoke all on function public.msgr_notification_run_snapshot(),public.msgr_notification_run_terminal() from public,anon,authenticated;
revoke all on function public.msgr_notification_routes_sync(text,jsonb,text),public.msgr_notification_routes_list(),public.msgr_automation_save_with_notifications(uuid,uuid,uuid,text,text,jsonb,uuid,uuid[]),public.msgr_notification_claim(text,uuid,text),public.msgr_notification_authorize(uuid,uuid),public.msgr_notification_finish(uuid,uuid,text,text) from public,anon;
grant execute on function public.msgr_notification_routes_sync(text,jsonb,text),public.msgr_notification_routes_list(),public.msgr_automation_save_with_notifications(uuid,uuid,uuid,text,text,jsonb,uuid,uuid[]),public.msgr_notification_claim(text,uuid,text),public.msgr_notification_authorize(uuid,uuid),public.msgr_notification_finish(uuid,uuid,text,text) to authenticated;
notify pgrst,'reload schema';
