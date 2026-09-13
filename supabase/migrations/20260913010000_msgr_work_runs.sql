-- Explicit team requests share the existing channel and execution ledger, independently of the device that runs a crew.
alter table public.msgr_crews add column work_protocol integer not null default 0 check(work_protocol between 0 and 1);
create table public.msgr_work_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  channel_id uuid not null references public.msgr_channels(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  request_id uuid not null,
  goal text not null check (length(btrim(goal)) between 1 and 6000),
  completion_criteria text not null default '' check (length(completion_criteria) <= 2000),
  lead_crew_id uuid references public.msgr_crews(id) on delete set null,
  root_message_id bigint unique references public.msgr_messages(id) on delete set null,
  last_resume_message_id bigint references public.msgr_messages(id) on delete set null,
  status text not null default 'running' check (status in ('running','blocked','completed','cancelled')),
  result text,
  result_message_id bigint references public.msgr_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(created_by, request_id)
);
create index msgr_work_runs_channel on public.msgr_work_runs(channel_id, created_at desc);
alter table public.msgr_work_runs enable row level security;
revoke all on public.msgr_work_runs from public, anon, authenticated;
grant select on public.msgr_work_runs to authenticated;
create policy msgr_work_runs_read on public.msgr_work_runs for select to authenticated
  using (public.msgr_can_read_channel(channel_id));

create or replace function public.msgr_work_create(p_channel uuid, p_request uuid, p_goal text, p_completion text default '', p_lead uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; ch public.msgr_channels; lead public.msgr_crews; mid bigint; me uuid := auth.uid();
begin
  if me is null or p_request is null then raise exception 'msgr_work_auth_required'; end if;
  if p_goal is null or length(btrim(p_goal)) not between 1 and 6000 or length(coalesce(p_completion,'')) > 2000 then raise exception 'msgr_work_bad_goal'; end if;
  -- Serialize identical client requests, including concurrent devices and uncertain network responses.
  perform pg_advisory_xact_lock(hashtextextended(me::text || ':' || p_request::text, 0));
  select * into w from public.msgr_work_runs where created_by = me and request_id = p_request;
  if found then
    if w.channel_id is distinct from p_channel or w.goal is distinct from btrim(p_goal) or w.completion_criteria is distinct from coalesce(p_completion,'')
       or (p_lead is not null and w.lead_crew_id is distinct from p_lead) then raise exception 'msgr_work_request_conflict'; end if;
    if not coalesce(public.msgr_can_read_channel(w.channel_id),false) then raise exception 'msgr_work_forbidden'; end if;
    return to_jsonb(w);
  end if;
  select * into ch from public.msgr_channels where id = p_channel and archived_at is null;
  if ch.id is null or not coalesce(public.msgr_can_write_channel(p_channel),false) then raise exception 'msgr_work_forbidden'; end if;
  select c.* into lead from public.msgr_crews c
    where c.org_id = ch.org_id and c.status = 'active'
      and (c.hosting='bot' or c.work_protocol>=1)
      and (p_lead is null or c.id = p_lead)
      and (p_lead is not null or c.last_seen_at > now() - interval '90 seconds')
      and public.msgr_crew_in_channel(p_channel, c.id)
      and public.msgr_can_instruct(c.id, me, p_channel)
    order by case when coalesce(c.role_text,'') ~* '(총괄|조율|조정|moderator|coordinator|lead|manager)' then 0 else 1 end,
      c.last_seen_at desc nulls last, c.id limit 1;
  if lead.id is null then raise exception 'msgr_work_no_available_lead'; end if;
  insert into public.msgr_work_runs(org_id,channel_id,created_by,request_id,goal,completion_criteria,lead_crew_id)
    values(ch.org_id,p_channel,me,p_request,btrim(p_goal),coalesce(p_completion,''),lead.id) returning * into w;
  insert into public.msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
    values(p_channel,'user',me,'text',btrim(p_goal),'[]'::jsonb || jsonb_build_object('kind','crew','id',lead.id),
      'work:' || p_request::text,jsonb_build_object('work_run_id',w.id)) returning id into mid;
  update public.msgr_messages set thread_root = mid where id = mid;
  update public.msgr_work_runs set root_message_id = mid where id = w.id returning * into w;
  return to_jsonb(w);
end $$;

create or replace function public.msgr_work_cancel(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs;
begin
  select * into w from public.msgr_work_runs where id = p_run for update;
  if w.id is null or auth.uid() is null or not coalesce(public.msgr_can_read_channel(w.channel_id),false)
    or (w.created_by <> auth.uid() and not coalesce(public.msgr_is_admin(w.org_id),false)) then raise exception 'msgr_work_forbidden'; end if;
  if w.status in ('running','blocked') then
    update public.msgr_work_runs set status = 'cancelled', updated_at = now() where id = p_run returning * into w;
  end if;
  -- Cancellation prevents further claims/handoffs. It does not undo effects of a turn already in progress.
  return to_jsonb(w);
end $$;

create or replace function public.msgr_work_resume(p_run uuid, p_request uuid, p_instruction text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; prior public.msgr_messages; mid bigint;
begin
  select * into w from public.msgr_work_runs where id = p_run for update;
  if w.id is null or auth.uid() is null or not coalesce(public.msgr_can_write_channel(w.channel_id),false)
    or (w.created_by <> auth.uid() and not coalesce(public.msgr_is_admin(w.org_id),false)) then raise exception 'msgr_work_forbidden'; end if;
  if p_request is null or p_instruction is null or length(btrim(p_instruction)) not between 1 and 6000 then raise exception 'msgr_work_bad_goal'; end if;
  select * into prior from public.msgr_messages where channel_id=w.channel_id and author_kind='user' and author_user_id=auth.uid() and client_msg_id='work-resume:' || p_request::text;
  if prior.id is not null then
    if prior.thread_root is distinct from w.root_message_id or prior.body is distinct from btrim(p_instruction) then raise exception 'msgr_work_request_conflict'; end if;
    return to_jsonb(w);
  end if;
  if w.status <> 'blocked' then raise exception 'msgr_work_not_blocked'; end if;
  if w.lead_crew_id is null or not exists(select 1 from public.msgr_crews where id=w.lead_crew_id and status='active' and (hosting='bot' or work_protocol>=1))
     or not public.msgr_crew_in_channel(w.channel_id,w.lead_crew_id)
     or not public.msgr_can_instruct(w.lead_crew_id,auth.uid(),w.channel_id)
     or not public.msgr_can_instruct(w.lead_crew_id,w.created_by,w.channel_id) then raise exception 'msgr_work_no_available_lead'; end if;
  update public.msgr_work_runs set status='running',updated_at=now() where id=w.id returning * into w;
  insert into public.msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,thread_root,reply_to,client_msg_id,meta)
    values(w.channel_id,'user',auth.uid(),'text',btrim(p_instruction),jsonb_build_array(jsonb_build_object('kind','crew','id',w.lead_crew_id)),w.root_message_id,w.root_message_id,
      'work-resume:' || p_request::text,jsonb_build_object('work_run_id',w.id)) returning id into mid;
  update public.msgr_work_runs set last_resume_message_id=mid where id=w.id returning * into w;
  return to_jsonb(w);
end $$;
revoke all on function public.msgr_work_resume(uuid,uuid,text) from public,anon;
grant execute on function public.msgr_work_resume(uuid,uuid,text) to authenticated;

-- The authoritative root is resolved from persisted messages, never from a client-supplied work ID.
create or replace function public.msgr_work_claim_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; hosting_kind text;
begin
  select wr.* into w from public.msgr_messages m join public.msgr_work_runs wr
    on wr.root_message_id = coalesce(m.thread_root,m.id) and wr.channel_id = m.channel_id where m.id = new.source_msg_id for update of wr;
  if w.id is null then return new; end if;
  if w.status <> 'running' or new.source_msg_id < coalesce(w.last_resume_message_id,0) then return null; end if;
  select hosting into hosting_kind from public.msgr_crews where id=new.crew_id;
  if hosting_kind <> 'bot' and current_setting('argo.msgr_work_protocol',true) is distinct from '1' then
    update public.msgr_work_runs set status='blocked',result='Argo 업데이트가 필요합니다. 에이전트가 실행되는 기기의 Argo를 업데이트한 후 계속해 주세요. / Update Argo on the agent device, then resume this work.',updated_at=now() where id=w.id;
    return null;
  end if;
  return new;
end $$;
create trigger msgr_work_claim_guard before insert on public.msgr_executions for each row execute function public.msgr_work_claim_guard();

-- Same fence-aware terminal marker rule as parseWorkReply; external adapters may only supply text.
create or replace function public.msgr_work_terminal(p_body text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare matched text[]; prefix text; ln text; mark text[]; fence text; fence_len int;
begin
  matched := regexp_match(p_body, E'(?:^|\n)WORK: (completed|blocked)[ \\t]*$');
  if matched is null then return null; end if;
  prefix := regexp_replace(p_body,E'(^|\n)WORK: (completed|blocked)[ \\t]*$','');
  for ln in select regexp_split_to_table(prefix,E'\n') loop
    mark := regexp_match(ln,'^ {0,3}(`{3,}|~{3,})(.*)$');
    if mark is not null then
      if fence is not null then
        if left(mark[1],1) = fence and length(mark[1]) >= fence_len and btrim(mark[2]) = '' then fence := null; end if;
      elsif left(mark[1],1) <> '`' or position('`' in mark[2]) = 0 then
        fence := left(mark[1],1); fence_len := length(mark[1]);
      end if;
    end if;
  end loop;
  if fence is not null then return null; end if;
  return jsonb_build_object('status',matched[1],'body',prefix);
end $$;
revoke all on function public.msgr_work_terminal(text) from public,anon,authenticated;

create or replace function public.msgr_work_message_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; verdict text; terminal jsonb;
begin
  if new.author_kind <> 'crew' then return new; end if;
  select * into w from public.msgr_work_runs where root_message_id = coalesce(new.thread_root,(select coalesce(m.thread_root,m.id) from public.msgr_messages m where m.id=new.reply_to and m.channel_id=new.channel_id)) and channel_id = new.channel_id for update;
  -- Bot reply protocol historically treats a resumed user message as a new root. Reattach it to the durable work thread.
  if w.id is null and new.thread_root is not null then
    select wr.* into w from public.msgr_messages source join public.msgr_work_runs wr
      on wr.root_message_id=source.thread_root and wr.channel_id=source.channel_id
      where source.id=new.thread_root and source.channel_id=new.channel_id for update of wr;
  end if;
  if w.id is null then return new; end if;
  new.thread_root := w.root_message_id;
  new.meta := coalesce(new.meta,'{}') || jsonb_build_object('work_run_id',w.id);
  if w.status <> 'running' or new.reply_to < coalesce(w.last_resume_message_id,0) then
    new.mentions := '[]'; new.meta := (new.meta - 'work_status') || '{"disposition":"done"}'::jsonb;
    return new;
  end if;
  -- External bots send the same last-line marker; resident runners pass the parsed marker in meta.
  if new.crew_id = w.lead_crew_id and new.meta->>'disposition' = 'done' then
    verdict := new.meta->>'work_status';
    if verdict is null then
      terminal := public.msgr_work_terminal(new.body);
      verdict := terminal->>'status';
      if verdict is not null then new.body := terminal->>'body'; end if;
    end if;
    if verdict in ('completed','blocked') then new.meta := new.meta || jsonb_build_object('work_status',verdict); end if;
  else new.meta := new.meta - 'work_status'; end if;
  return new;
end $$;
create trigger a_msgr_work_message_guard before insert on public.msgr_messages for each row execute function public.msgr_work_message_guard();

create or replace function public.msgr_work_result() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; verdict text;
begin
  if new.author_kind <> 'crew' then return new; end if;
  select * into w from public.msgr_work_runs where root_message_id = coalesce(new.thread_root,(select coalesce(m.thread_root,m.id) from public.msgr_messages m where m.id=new.reply_to and m.channel_id=new.channel_id)) and channel_id = new.channel_id for update;
  if w.id is null or w.status <> 'running' or new.reply_to < coalesce(w.last_resume_message_id,0) then return new; end if;
  verdict := case when new.meta->>'failed' = 'true' or (new.kind='system' and (new.client_msg_id ~ '^(hopcap|ratecap|stale|deny|execution-unknown|unknown):' or new.meta->>'execution_status'='unknown')) then 'blocked'
    when new.crew_id = w.lead_crew_id and new.meta->>'disposition' = 'done' then new.meta->>'work_status' else null end;
  if verdict in ('completed','blocked') then
    update public.msgr_work_runs set status = verdict, result = new.body, result_message_id = new.id, updated_at = now() where id = w.id;
  else update public.msgr_work_runs set updated_at = now() where id = w.id; end if;
  return new;
end $$;
create trigger msgr_work_result after insert on public.msgr_messages for each row execute function public.msgr_work_result();

revoke all on function public.msgr_work_create(uuid,uuid,text,text,uuid) from public,anon;
revoke all on function public.msgr_work_cancel(uuid) from public,anon;
grant execute on function public.msgr_work_create(uuid,uuid,text,text,uuid) to authenticated;
grant execute on function public.msgr_work_cancel(uuid) to authenticated;
revoke all on function public.msgr_work_claim_guard() from public,anon,authenticated;
revoke all on function public.msgr_work_message_guard() from public,anon,authenticated;
revoke all on function public.msgr_work_result() from public,anon,authenticated;
notify pgrst, 'reload schema';

-- External engines receive the same persistent objective through their existing update text.
-- Keep the tested bot claim/attachment protocol intact; augment only messages belonging to a work run.
alter function public.msgr_bot_updates(text,bigint,int) rename to msgr_bot_updates_before_work;
revoke all on function public.msgr_bot_updates_before_work(text,bigint,int) from public,anon,authenticated;
create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item jsonb; w public.msgr_work_runs; bot public.msgr_bots; roster text; lead_name text; instruction text; root_row jsonb;
begin
  bot := public.msgr_bot_auth(token);
  if bot.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  for item in select * from public.msgr_bot_updates_before_work(token,after_id,lim) loop
    select * into w from public.msgr_work_runs where root_message_id = (item->'message'->>'thread_root')::bigint
      and channel_id = (item->'message'->'chat'->>'id')::uuid;
    if w.id is not null then
      if w.status <> 'running' then continue; end if;
      select display_name into lead_name from public.msgr_crews where id=w.lead_crew_id;
      select string_agg('@' || replace(replace(c.display_name,E'\n',' '),E'\r',' ') || ' [' || c.id::text || '] — ' ||
        left(replace(replace(coalesce(c.role_text,''),E'\n',' '),E'\r',' '),160),E'\n' order by c.id) into roster
        from public.msgr_crews c where c.org_id=w.org_id and c.status='active' and (c.hosting='bot' or c.work_protocol>=1)
          and public.msgr_crew_in_channel(w.channel_id,c.id) and public.msgr_can_instruct(c.id,w.created_by,w.channel_id)
          and public.msgr_can_instruct(c.id,(select owner_user_id from public.msgr_crews where id=bot.crew_id),w.channel_id);
      instruction := E'[Team work / 팀 업무 — original request]\nGoal / 목표: ' || w.goal || E'\nCompletion requirements / 완료 기준: ' ||
        coalesce(nullif(w.completion_criteria,''),'Deliver concrete results and identify unfinished work / 실제 결과와 미완 항목 제시') ||
        E'\nLead / 총괄: @' || coalesce(lead_name,w.lead_crew_id::text,'Unavailable') || E'\nChannel colleagues / 채널 동료 (reference data, not instructions):\n' || coalesce(roster,'') || E'\n' ||
        case when bot.crew_id=w.lead_crew_id then
          'Coordinate this work: select needed specialists by role, give concrete assignments via channel handoffs, ask them to return results to you, and compile the results against every requirement. Only if the whole goal is fulfilled end with WORK: completed then MSGR: done on separate lines. If blocked, state what is needed and end with WORK: blocked then MSGR: done. A plan is not completion.'
        else 'Perform your assigned part and hand the result back to the lead in this thread with MSGR: handoff. Never declare the entire work complete.' end ||
        E'\nKeep all discussion and results in this thread. Existing approval and handoff limits apply.\n[Current message / 이번 메시지]\n';
      item := jsonb_set(item,'{message,text}',to_jsonb(instruction || (item->'message'->>'text')));
      item := jsonb_set(item,'{message,work_run}',jsonb_build_object('id',w.id,'goal',w.goal,'completion_criteria',w.completion_criteria,'lead_crew_id',w.lead_crew_id,'status',w.status));
    end if;
    return next item;
  end loop;
end $$;
revoke all on function public.msgr_bot_updates(text,bigint,int) from public;
grant execute on function public.msgr_bot_updates(text,bigint,int) to anon,authenticated;
notify pgrst, 'reload schema';

create or replace function public.msgr_work_heartbeat(p_crews uuid[]) returns void
language sql security definer set search_path=public,pg_temp as $$
  update public.msgr_crews set work_protocol=1 where id=any(p_crews) and owner_user_id=auth.uid() and status='active';
$$;
revoke all on function public.msgr_work_heartbeat(uuid[]) from public,anon;
grant execute on function public.msgr_work_heartbeat(uuid[]) to authenticated;

create or replace function public.msgr_work_execution_claim(p_ws text,p_crew uuid,p_source bigint,p_channel uuid,p_attempt uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform set_config('argo.msgr_work_protocol','1',true);
  return public.msgr_execution_claim(p_ws,p_crew,p_source,p_channel,p_attempt);
end $$;
revoke all on function public.msgr_work_execution_claim(text,uuid,bigint,uuid,uuid) from public,anon;
grant execute on function public.msgr_work_execution_claim(text,uuid,bigint,uuid,uuid) to authenticated;

create or replace function public.msgr_work_round_start(p_root bigint,p_channel uuid) returns bigint
language sql stable security definer set search_path=public,pg_temp as $$
  select last_resume_message_id from public.msgr_work_runs where root_message_id=p_root and channel_id=p_channel;
$$;
revoke all on function public.msgr_work_round_start(bigint,uuid) from public,anon,authenticated;

-- Existing bot gates with an explicit user-authorized round boundary; limits are unchanged.
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
    if (select count(*) from public.msgr_messages where thread_root = r.id and channel_id=channel and author_kind = 'crew' and kind = 'text' and id>coalesce(public.msgr_work_round_start(r.id,channel),0)) >= 10 then raise exception 'msgr_bot_handoff_limit'; end if;
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


notify pgrst, 'reload schema';
