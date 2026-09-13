-- Messenger-owned schedules. Commands enter the existing channel/execution pipeline.
-- No service key or client-supplied identity is accepted by the scheduling RPCs.
create table public.msgr_automations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  channel_id uuid not null references public.msgr_channels(id) on delete cascade,
  crew_id uuid not null references public.msgr_crews(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete cascade,
  create_request_id uuid,
  title text not null check (length(title) between 1 and 120),
  prompt text not null check (length(prompt) between 1 and 18000),
  schedule jsonb not null,
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_message_id bigint references public.msgr_messages(id) on delete set null,
  last_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index msgr_automation_create_request on public.msgr_automations(created_by,create_request_id) where create_request_id is not null;
create index msgr_automations_due on public.msgr_automations(next_run_at) where enabled and deleted_at is null;
create table public.msgr_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.msgr_automations(id) on delete cascade,
  request_id uuid,
  scheduled_for timestamptz not null,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'blocked')),
  message_id bigint references public.msgr_messages(id) on delete set null,
  reply_id bigint references public.msgr_messages(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index msgr_automation_pending on public.msgr_automation_runs(automation_id,created_at) where status = 'queued';
create unique index msgr_automation_request on public.msgr_automation_runs(automation_id,request_id) where request_id is not null;
create unique index msgr_automation_slot on public.msgr_automation_runs(automation_id,scheduled_for) where trigger = 'schedule';
alter table public.msgr_automations enable row level security;
alter table public.msgr_automation_runs enable row level security;
revoke all on public.msgr_automations, public.msgr_automation_runs from anon, authenticated;
grant select on public.msgr_automations, public.msgr_automation_runs to authenticated;
create policy msgr_automations_read on public.msgr_automations for select to authenticated
  using (public.msgr_can_read_channel(channel_id));
create policy msgr_automation_runs_read on public.msgr_automation_runs for select to authenticated
  using (exists(select 1 from public.msgr_automations a where a.id = automation_id and public.msgr_can_read_channel(a.channel_id)));

-- Strict next occurrence, evaluated against server time. Missed intervals coalesce to one run;
-- daily/weekly DST gaps are skipped, and a repeated clock time runs only once on that date.
create function public.msgr_automation_next(s jsonb, after_at timestamptz) returns timestamptz
language plpgsql stable set search_path = public, pg_temp as $$
declare zone text := s->>'timezone'; k text := s->>'kind'; n int; d date; wall timestamp; candidate timestamptz; days jsonb;
begin
  if s is null or jsonb_typeof(s) <> 'object' or after_at is null or zone is null
     or not exists(select 1 from pg_timezone_names where name = zone) then raise exception 'msgr_automation_invalid_schedule'; end if;
  if k = 'interval' then
    if coalesce(s->>'minutes','') !~ '^[0-9]{1,5}$' then raise exception 'msgr_automation_invalid_schedule'; end if;
    n := (s->>'minutes')::int;
    if n < 5 or n > 10080 then raise exception 'msgr_automation_invalid_schedule'; end if;
    return after_at + make_interval(mins => n);
  end if;
  if k is null or k not in ('daily','weekly') or coalesce(s->>'time','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'msgr_automation_invalid_schedule'; end if;
  days := s->'weekdays';
  if k = 'weekly' then
    if days is null or jsonb_typeof(days) <> 'array' then raise exception 'msgr_automation_invalid_schedule'; end if;
    if jsonb_array_length(days) not between 1 and 7 or exists(select 1 from jsonb_array_elements(days) v where v::text !~ '^[1-7]$') then raise exception 'msgr_automation_invalid_schedule'; end if;
  end if;
  for n in 0..14 loop
    d := (after_at at time zone zone)::date + n;
    if k = 'weekly' and not days @> to_jsonb(array[extract(isodow from d)::int]) then continue; end if;
    wall := d + (s->>'time')::time;
    candidate := wall at time zone zone;
    if candidate > after_at and candidate at time zone zone = wall then return candidate; end if;
  end loop;
  raise exception 'msgr_automation_invalid_schedule';
end $$;

-- Explicit-user mirror of channel write policy: never changes auth.uid()/JWT claims.
create function public.msgr_automation_authorized(actor uuid, ch uuid, target uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.msgr_channels c
    join public.msgr_orgs o on o.id = c.org_id and o.deleted_at is null
    join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = actor
    join public.msgr_crews cr on cr.id = target and cr.org_id = c.org_id and cr.status = 'active'
    where c.id = ch and c.archived_at is null and not public.msgr_org_locked(c.org_id)
      and m.removed_at is null and (m.expires_at is null or m.expires_at > now())
      and ((c.kind = 'public' and m.role in ('owner','admin','member')) or exists (
        select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = actor))
      and public.msgr_can_instruct(target, actor, ch) and public.msgr_crew_in_channel(ch, target)
  )
$$;

create function public.msgr_automation_save(automation uuid, channel uuid, crew uuid, title text, prompt text, schedule jsonb, request_id uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_automations; due timestamptz;
begin
  if auth.uid() is null or not public.msgr_automation_authorized(auth.uid(), channel, crew) then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  due := public.msgr_automation_next(schedule, now());
  if automation is null then
    insert into public.msgr_automations(org_id,channel_id,crew_id,created_by,create_request_id,title,prompt,schedule,next_run_at)
      select c.org_id,channel,crew,auth.uid(),request_id,btrim(title),btrim(prompt),schedule,due from public.msgr_channels c where c.id = channel
      on conflict(created_by,create_request_id) where create_request_id is not null
      do update set updated_at = msgr_automations.updated_at returning * into a;
  else
    select * into a from public.msgr_automations where id = automation for update;
    if a.created_by is distinct from auth.uid() or a.deleted_at is not null then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
    -- Keep history attached to its original channel/organization.
    if a.channel_id is distinct from channel then raise exception 'msgr_automation_channel_immutable'; end if;
    update public.msgr_automations set crew_id = crew,title = btrim(msgr_automation_save.title),prompt = btrim(msgr_automation_save.prompt),
      schedule = msgr_automation_save.schedule,next_run_at = due,updated_at = now() where id = automation returning * into a;
  end if;
  return to_jsonb(a);
end $$;

create function public.msgr_automation_set_enabled(automation uuid, enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_automations;
begin
  select * into a from public.msgr_automations where id = automation for update;
  if auth.uid() is null or a.created_by is distinct from auth.uid() or a.deleted_at is not null then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  if enabled is null then raise exception 'msgr_automation_invalid_schedule'; end if;
  -- Revoked creators can still stop future work; resume requires current permission.
  if enabled and not public.msgr_automation_authorized(auth.uid(),a.channel_id,a.crew_id) then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  update public.msgr_automations set enabled = msgr_automation_set_enabled.enabled,
    next_run_at = case when msgr_automation_set_enabled.enabled then public.msgr_automation_next(a.schedule,now()) else a.next_run_at end,
    updated_at = now() where id = automation returning * into a;
  return to_jsonb(a);
end $$;
create function public.msgr_automation_delete(automation uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.msgr_automations set deleted_at = now(),enabled = false,updated_at = now()
    where id = automation and created_by = auth.uid() and deleted_at is null;
  if not found then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  return true;
end $$;

-- Private transaction helper. Only the two public, authenticated entry points may call it.
create function public.msgr_automation_enqueue(a public.msgr_automations, mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_automation_runs; msg bigint;
begin
  insert into public.msgr_automation_runs(automation_id,scheduled_for,trigger,status)
    values(a.id,case when mode = 'schedule' then a.next_run_at else clock_timestamp() end,mode,'queued') returning * into r;
  if not public.msgr_automation_authorized(a.created_by,a.channel_id,a.crew_id) then
    update public.msgr_automation_runs set status = 'blocked',error = 'permission_revoked',finished_at = now() where id = r.id returning * into r;
    update public.msgr_automations set enabled = false,last_run_at = now(),last_status = 'blocked',updated_at = now() where id = a.id;
    return to_jsonb(r);
  end if;
  insert into public.msgr_messages(org_id,channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
    values(a.org_id,a.channel_id,'user',a.created_by,'text',a.prompt,
      jsonb_build_array(jsonb_build_object('kind','crew','id',a.crew_id)), 'automation:' || r.id,
      jsonb_build_object('automation_id',a.id,'automation_run_id',r.id,'automation_title',a.title,'scheduled_for',r.scheduled_for)) returning id into msg;
  update public.msgr_automation_runs set message_id = msg where id = r.id returning * into r;
  update public.msgr_automations set last_run_at = now(),last_message_id = msg,last_status = 'queued',updated_at = now(),
    next_run_at = case when mode = 'schedule' then public.msgr_automation_next(a.schedule,now()) else next_run_at end where id = a.id;
  return to_jsonb(r);
end $$;
create function public.msgr_automation_run_now(automation uuid, request_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_automations; previous jsonb; result jsonb;
begin
  select * into a from public.msgr_automations where id = automation for update;
  if auth.uid() is null or a.created_by is distinct from auth.uid() or a.deleted_at is not null
    or not public.msgr_automation_authorized(auth.uid(),a.channel_id,a.crew_id) then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  if request_id is not null then
    select to_jsonb(r) into previous from public.msgr_automation_runs r where r.automation_id = automation and r.request_id = msgr_automation_run_now.request_id;
    if previous is not null then return previous; end if;
  end if;
  result := public.msgr_automation_enqueue(a,'manual');
  update public.msgr_automation_runs r set request_id = msgr_automation_run_now.request_id where r.id = (result->>'id')::uuid returning to_jsonb(r) into result;
  return result;
end $$;

create function public.msgr_automation_dispatch_internal(p_ws text, cloud boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_automations; rejected record; results jsonb := '[]';
begin
  if not cloud and auth.uid() is null then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  -- Reconcile only not-yet-started commands, independent of the next schedule time.
  -- Lock automation then run, the same order as the claim guard and enqueue path.
  for rejected in select r.id as run_id,au.id as automation_id,r.message_id
    from public.msgr_automations au join public.msgr_automation_runs r on r.automation_id = au.id
    join public.msgr_messages source on source.id = r.message_id
    where r.status = 'queued'
      and not exists(select 1 from public.msgr_executions e where e.source_msg_id = r.message_id)
      and not public.msgr_automation_authorized(source.author_user_id,source.channel_id,
        public.msgr_uuid_or_null(source.mentions->0->>'id'))
      and (cloud or (public.msgr_can_write_channel(au.channel_id)
        and exists(select 1 from public.msgr_crews c where c.org_id = au.org_id and c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.status = 'active')))
    order by r.created_at limit 20 for update of au,r skip locked
  loop
    update public.msgr_automation_runs set status = 'blocked',error = 'permission_revoked',finished_at = now() where id = rejected.run_id;
    update public.msgr_automations set enabled = false,updated_at = now(),
      last_status = case when last_message_id = rejected.message_id then 'blocked' else last_status end where id = rejected.automation_id;
  end loop;
  for a in select au.* from public.msgr_automations au
    where au.enabled and au.deleted_at is null and au.next_run_at <= now()
      -- Never pile up unattended commands or restart an uncertain in-flight execution.
      and not exists(select 1 from public.msgr_automation_runs pending
        join public.msgr_messages source on source.id = pending.message_id and source.deleted_at is null
        where pending.automation_id = au.id and pending.status in ('queued','running'))
      and (cloud or (public.msgr_can_write_channel(au.channel_id)
      and exists(select 1 from public.msgr_crews c where c.org_id = au.org_id and c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.status = 'active')))
    order by au.next_run_at limit 20 for update of au skip locked
  loop
    begin
      results := results || jsonb_build_array(public.msgr_automation_enqueue(a,'schedule'));
    exception when others then
      -- One broken row must not starve every other organization. No exception text
      -- is stored or logged: database errors may contain message/prompt values.
      update public.msgr_automations set enabled = false,last_status = 'blocked',updated_at = now() where id = a.id;
      insert into public.msgr_automation_runs(automation_id,scheduled_for,trigger,status,error,finished_at)
        values(a.id,a.next_run_at,'schedule','blocked','dispatch_failed',now()) on conflict do nothing;
    end;
  end loop;
  return results;
end $$;

-- Cloud scheduling is optional and shares the exact same atomic transaction path.
create table public.msgr_automation_scheduler (id boolean primary key default true check (id), last_tick_at timestamptz);
alter table public.msgr_automation_scheduler enable row level security;
revoke all on public.msgr_automation_scheduler from public,anon,authenticated;
create function public.msgr_automation_dispatch_due(p_ws text) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select public.msgr_automation_dispatch_internal(p_ws,false)
$$;
create function public.msgr_automation_dispatch_cloud() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  result := public.msgr_automation_dispatch_internal(null,true);
  insert into public.msgr_automation_scheduler(id,last_tick_at) values(true,now()) on conflict(id) do update set last_tick_at = excluded.last_tick_at;
  return result;
end $$;
create function public.msgr_automation_scheduler_status() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('server_active',coalesce(max(last_tick_at) > now() - interval '3 minutes',false),'last_tick_at',max(last_tick_at))
    from public.msgr_automation_scheduler where auth.uid() is not null
$$;
revoke all on function public.msgr_automation_dispatch_internal(text,boolean), public.msgr_automation_dispatch_cloud() from public,anon,authenticated;
grant execute on function public.msgr_automation_dispatch_cloud() to service_role;
revoke all on function public.msgr_automation_scheduler_status() from public,anon;
grant execute on function public.msgr_automation_scheduler_status() to authenticated;

-- Recheck the original human authorization when a queued command actually starts,
-- including after a node reconnects days later. An already-running result may finish.
create function public.msgr_automation_execution_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare creator uuid; channel uuid; automation uuid; run_state text;
begin
  select automation_id into automation from public.msgr_automation_runs where message_id = new.source_msg_id limit 1;
  if automation is null then return new; end if;
  perform 1 from public.msgr_automations where id = automation for update;
  select m.author_user_id,m.channel_id,r.status into creator,channel,run_state
    from public.msgr_automation_runs r join public.msgr_messages m on m.id = r.message_id
    where r.message_id = new.source_msg_id limit 1 for update of r;
  if run_state = 'blocked' or not public.msgr_automation_authorized(creator,channel,new.crew_id) then
    raise exception 'msgr_automation_forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.msgr_automation_execution_guard() from public,anon,authenticated;
create trigger msgr_automation_execution_guard before insert on public.msgr_executions
  for each row execute function public.msgr_automation_execution_guard();

-- Completion is driven by the real execution record, never by scheduler enqueue success.
create function public.msgr_automation_execution_status() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a_id uuid; s text;
begin
  s := case when new.state <> 'completed' then 'running'
    when exists(select 1 from public.msgr_messages where id = new.reply_id and meta->>'failed' = 'true') then 'failed'
    else 'completed' end;
  for a_id in update public.msgr_automation_runs r set status = s,reply_id = new.reply_id,
    finished_at = case when s in ('completed','failed') then now() else null end
    from public.msgr_messages m where r.message_id = new.source_msg_id and m.id = r.message_id
      and m.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',new.crew_id))
    returning r.automation_id
  loop
    update public.msgr_automations set last_status = s where id = a_id and last_message_id = new.source_msg_id;
  end loop;
  return new;
end $$;
create trigger msgr_automation_execution after insert or update of state on public.msgr_executions
  for each row execute function public.msgr_automation_execution_status();

-- Some existing drain outcomes settle without claiming an execution (permission,
-- stale-message and safety caps). Match the real target plus deterministic reply key.
create function public.msgr_automation_terminal_message() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a_id uuid; reason text := split_part(new.client_msg_id,':',1);
begin
  if new.author_kind <> 'crew' or new.kind <> 'system' or new.reply_to is null
    or reason not in ('deny','stale','hopcap','ratecap')
    or new.client_msg_id is distinct from reason || ':' || new.crew_id::text || ':' || new.reply_to::text then return new; end if;
  for a_id in update public.msgr_automation_runs r set status = 'blocked',reply_id = new.id,error = reason,finished_at = now()
    from public.msgr_messages source where r.message_id = new.reply_to and source.id = r.message_id
      and source.channel_id = new.channel_id and r.status in ('queued','running')
      and source.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',new.crew_id)) returning r.automation_id
  loop
    update public.msgr_automations set last_status = 'blocked' where id = a_id and last_message_id = new.reply_to;
  end loop;
  return new;
end $$;
revoke all on function public.msgr_automation_terminal_message() from public,anon,authenticated;
create trigger msgr_automation_terminal_message after insert on public.msgr_messages
  for each row execute function public.msgr_automation_terminal_message();

revoke all on function public.msgr_automation_next(jsonb,timestamptz), public.msgr_automation_authorized(uuid,uuid,uuid),
  public.msgr_automation_enqueue(public.msgr_automations,text), public.msgr_automation_execution_status() from public,anon,authenticated;
revoke all on function public.msgr_automation_save(uuid,uuid,uuid,text,text,jsonb,uuid), public.msgr_automation_set_enabled(uuid,boolean),
  public.msgr_automation_delete(uuid), public.msgr_automation_run_now(uuid,uuid), public.msgr_automation_dispatch_due(text) from public,anon,authenticated;
grant execute on function public.msgr_automation_save(uuid,uuid,uuid,text,text,jsonb,uuid), public.msgr_automation_set_enabled(uuid,boolean),
  public.msgr_automation_delete(uuid), public.msgr_automation_run_now(uuid,uuid), public.msgr_automation_dispatch_due(text) to authenticated;
