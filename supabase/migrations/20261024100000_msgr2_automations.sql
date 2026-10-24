-- 메신저 v2 자동화 일정(재공개 판 — 총괄 결정 2026-10-24 (A)). 옛 자동화(20260913110000 msgr_automations)를 v2 방·에이전트 위로 옮긴다.
-- 정해 둔 시각마다 "만든 사람의 이름으로 그 방에 지시 글 1개(에이전트 멘션)"를 넣고, 일 만들기는 사람 글과 같은 길(msgr2_on_user_message → _msgr2_make_offer)을 탄다.
-- 루틴 미러(옛 msgr_crew_routines)·알림 대상(옛 20260913110500)은 이 판 범위 밖이다(v2 업무 창은 "곧 지원" 안내).
--
-- 실행 문맥(S5 — 20261023180000):
--   사람 글 넣기 정책(msgr2_messages_insert)은 앱 기기 세션만 통과시킨다. 크론 실행은 기기 세션이 아니므로(auth.uid() 없음) 정책·msgr2_lite_guard·msgr2_pause_guard가
--   모두 건너뛴다 — 그대로 두면 "본체 세션 대신 크론으로 사람 글을 넣는" 우회 경로가 된다. 그래서
--   (1) 자동화를 만들고·켜고·지금 실행하는 RPC는 앱 기기 세션만(_msgr2_need_app) — 본체(runner)·폐기 기기 세션은 일정을 만들 수 없다.
--   (2) 크론 실행(msgr2_automation_dispatch)은 security definer 안에서, 글을 넣기 직전에 원래 사람의 권한을 다시 본다(_msgr2_automation_why):
--       방 쓰기(_msgr2_access_for — 팀은 활동 공간 멤버·1:1 차단 포함), 팀 공간 활동 멤버(_msgr2_owner_active, S2와 같은 판정), 에이전트가 방에 있고 활성,
--       개인 공간은 내 에이전트만·팀은 자리 규칙(allow), Pro(_msgr2_pro_ok), 사람 채팅 꺼짐(lite)이면 허용 방만(_msgr2_lite_room_ok), 중단 스위치(_msgr2_paused).
--       만든 뒤 "모든 기기 로그아웃"·기기 폐기로 로그인 세대(msgr2_user_gen)가 올랐으면 그 일정도 막는다(owner_gen — 탈취한 세션이 건 일정이 남지 않게, S4와 같은 원칙).
--       하나라도 어긋나면 글을 넣지 않고 실행 기록에 'blocked'와 이유를 남기고 자동화를 끈다(조용히 재시도하지 않는다).
--   (3) 크론 문맥은 사람 글 속도 상한(msgr2_lite_guard)을 지나지 않는다 — 일정 간격이 5분 이상이고, 한 사람의 자동화는 50개까지(msgr2_limit_automations),
--       자동화마다 진행 중인 일이 있으면 그 회차를 건너뛴다. 일 만들기 상한(분당 에이전트·방, 주인 하루 — _msgr2_make_offer_x)은 크론 글에도 그대로 걸린다.
--   앱 기기 판정(_msgr2_device_app)은 사람이 직접 부른 RPC 안에서만 보고, 크론 실행에서는 보지 않는다(기기 세션이 없다). 지금 실행(run_now)은 사람 문맥이라
--   글이 사람 글 정책·lite_guard·pause_guard를 그대로 지난다.
--
-- 부하: 크론 1개가 매분 1회 = 기기 수와 무관하게 분당 1회(하루 1,440회). 할 일이 없으면 쓰기 0(시험 xmin 불변으로 잠금 — test/msgr2-automations-pg.test.mjs).
--   할 일이 있을 때만 자동화 1개당 실행 기록 1행 + 사람 글 1행 + 자동화 행 갱신 1회. 실행 기록(cron.job_run_details)은 purge-cron-run-details(7일, 20260923220000)가 지운다.
-- 보존: 실행 기록(msgr2_automation_runs)은 30일 — purge-msgr2-automation-runs(매일 03:53). 기억 데이터가 아니다(지시 글·답은 msgr2_messages에 남는다).
-- pg_cron이 없는 환경(로컬 PG 시험)에서는 크론을 걸지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
-- 되돌림: scripts/rollback/20261024100000_msgr2_automations.down.sql

create table if not exists public.msgr2_automations (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.msgr2_spaces (id) on delete cascade,
  room_id uuid not null references public.msgr2_rooms (id) on delete cascade,
  agent_id uuid not null references public.msgr2_agents (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  create_request_id uuid,
  title text not null check (length(title) between 1 and 120),
  prompt text not null check (length(prompt) between 1 and 18000),
  schedule jsonb not null,
  enabled boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  last_message_id bigint,
  last_status text,
  last_error text,
  owner_gen int not null default 0, -- 만들기·고치기·다시 켜기 때 만든 사람의 로그인 세대(msgr2_user_gen). "모든 기기 로그아웃"으로 세대가 오르면 실행을 막는다(검수 지적 1)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists msgr2_automations_request on public.msgr2_automations (created_by, create_request_id) where create_request_id is not null;
create index if not exists msgr2_automations_due on public.msgr2_automations (next_run_at) where enabled and deleted_at is null;
create index if not exists msgr2_automations_room on public.msgr2_automations (room_id, created_at) where deleted_at is null;

create table if not exists public.msgr2_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.msgr2_automations (id) on delete cascade,
  request_id uuid,
  scheduled_for timestamptz not null,
  trigger text not null check (trigger in ('schedule', 'manual')),
  status text not null check (status in ('queued', 'running', 'completed', 'failed', 'blocked')),
  message_id bigint,
  work_id uuid,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists msgr2_automation_runs_request on public.msgr2_automation_runs (automation_id, request_id) where request_id is not null;
create unique index if not exists msgr2_automation_runs_slot on public.msgr2_automation_runs (automation_id, scheduled_for) where trigger = 'schedule';
create index if not exists msgr2_automation_runs_list on public.msgr2_automation_runs (automation_id, created_at);
create index if not exists msgr2_automation_runs_work on public.msgr2_automation_runs (work_id) where work_id is not null;
create index if not exists msgr2_automation_runs_age on public.msgr2_automation_runs (created_at);

-- 읽기: 그 방을 읽을 수 있는 사람(앱 기기 세션 — msgr2_access). 쓰기는 아래 RPC만.
alter table public.msgr2_automations enable row level security;
alter table public.msgr2_automation_runs enable row level security;
revoke all on public.msgr2_automations, public.msgr2_automation_runs from anon, authenticated;
grant select on public.msgr2_automations, public.msgr2_automation_runs to authenticated;
drop policy if exists msgr2_automations_read on public.msgr2_automations;
create policy msgr2_automations_read on public.msgr2_automations for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_automation_runs_read on public.msgr2_automation_runs;
create policy msgr2_automation_runs_read on public.msgr2_automation_runs for select to authenticated
  using (exists (select 1 from public.msgr2_automations a where a.id = automation_id and (public.msgr2_access(a.room_id)).read));

-- 다음 실행 시각(옛 msgr_automation_next와 같은 규칙 — 오류 이름도 같게 해 화면 문구를 그대로 쓴다). 놓친 간격은 한 번으로 합치고,
-- 하루·주 일정은 서머타임으로 없는 시각은 건너뛰고 겹치는 시각은 그날 한 번만.
create or replace function public._msgr2_automation_next(s jsonb, after_at timestamptz) returns timestamptz
  language plpgsql stable set search_path = public, pg_temp as $$
declare zone text := s->>'timezone'; k text := s->>'kind'; n int; d date; wall timestamp; candidate timestamptz; days jsonb;
begin
  if s is null or jsonb_typeof(s) <> 'object' or after_at is null or zone is null
     or not exists (select 1 from pg_timezone_names where name = zone) then raise exception 'msgr_automation_invalid_schedule'; end if;
  if k = 'interval' then
    if coalesce(s->>'minutes', '') !~ '^[0-9]{1,5}$' then raise exception 'msgr_automation_invalid_schedule'; end if;
    n := (s->>'minutes')::int;
    if n < 5 or n > 10080 then raise exception 'msgr_automation_invalid_schedule'; end if;
    return after_at + make_interval(mins => n);
  end if;
  if k is null or k not in ('daily', 'weekly') or coalesce(s->>'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'msgr_automation_invalid_schedule'; end if;
  days := s->'weekdays';
  if k = 'weekly' then
    if days is null or jsonb_typeof(days) <> 'array' then raise exception 'msgr_automation_invalid_schedule'; end if;
    if jsonb_array_length(days) not between 1 and 7 or exists (select 1 from jsonb_array_elements(days) v where v::text !~ '^[1-7]$') then raise exception 'msgr_automation_invalid_schedule'; end if;
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

-- 이 사람(p_actor)이 지금 이 방에서 이 에이전트에게 자동 지시를 보낼 수 있나. null = 됨, 아니면 막힌 이유.
-- auth.uid()를 보지 않는다 — 크론(사람 문맥 없음)과 사람 RPC가 같은 판정을 쓴다. 판정은 사람 글 정책 + 일 만들기(_msgr2_make_offer_x)의 거울이다.
create or replace function public._msgr2_automation_why(p_actor uuid, p_room uuid, p_agent uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; a public.msgr2_agents; seat public.msgr2_agent_seats; acc public.msgr2_access_t;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select * into a from public.msgr2_agents where id = p_agent;
  if p_actor is null or r.id is null or s.id is null or s.deleted_at is not null or r.archived_at is not null then return 'permission_revoked'; end if;
  acc := public._msgr2_access_for(p_room, p_actor);
  if not coalesce(acc.write, false) or not public._msgr2_owner_active(p_room, p_actor) then return 'permission_revoked'; end if;
  if a.id is null or a.status <> 'active' or r.agent_policy = 'blocked'
     or not exists (select 1 from public.msgr2_room_members m where m.room_id = p_room and m.member_kind = 'agent' and m.member_id = p_agent and m.removed_at is null) then
    return 'agent_unavailable'; end if;
  if s.kind = 'personal' then
    if a.owner_user_id <> p_actor then return 'permission_revoked'; end if; -- 개인 공간: 내 에이전트만(_msgr2_make_offer_x와 같다)
  else
    select * into seat from public.msgr2_agent_seats where agent_id = p_agent and space_id = s.id and removed_at is null;
    if seat.agent_id is null
       or (seat.allow = 'owner' and p_actor <> a.owner_user_id)
       or (seat.allow = 'list' and p_actor <> a.owner_user_id and not (p_actor = any (seat.allow_users))) then return 'permission_revoked'; end if;
  end if;
  if not public._msgr2_pro_ok(p_actor) then return 'pro_required'; end if;
  if public._msgr2_lite() and not public._msgr2_lite_room_ok(p_room) then return 'lite_only'; end if;
  return null;
end $$;

-- 그 사람의 지금 로그인 세대(기기 폐기·모든 기기 로그아웃 때 오른다 — 20261020200100)
create or replace function public._msgr2_automation_gen(p_uid uuid) returns int
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = p_uid), 0) $$;

-- 사람 RPC의 거부(오류 이름은 화면 문구 — work-panel.jsx errorText)
create or replace function public._msgr2_automation_deny(p_why text) returns void
  language plpgsql volatile set search_path = public, pg_temp as $$
begin
  if p_why = 'pro_required' then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
  if p_why = 'lite_only' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
  raise exception 'msgr_automation_forbidden' using errcode = '42501', detail = coalesce(p_why, 'forbidden');
end $$;

create or replace function public.msgr2_automation_save(p_automation uuid, p_room uuid, p_agent uuid, p_title text, p_prompt text, p_schedule jsonb, p_request_id uuid default null)
  returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); a public.msgr2_automations; due timestamptz; why text; n int;
begin
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  why := public._msgr2_automation_why(uid, p_room, p_agent);
  if why is not null then perform public._msgr2_automation_deny(why); end if;
  due := public._msgr2_automation_next(p_schedule, now());
  if p_automation is null then
    if p_request_id is not null then -- 같은 요청 다시 보내기(멱등)
      select * into a from public.msgr2_automations where created_by = uid and create_request_id = p_request_id;
      if a.id is not null then return to_jsonb(a); end if;
    end if;
    select count(*) into n from public.msgr2_automations where created_by = uid and deleted_at is null;
    if n >= public._msgr2_clamp('msgr2_limit_automations', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'automations'; end if;
    insert into public.msgr2_automations (space_id, room_id, agent_id, created_by, create_request_id, title, prompt, schedule, next_run_at, owner_gen)
      select r.space_id, p_room, p_agent, uid, p_request_id, btrim(p_title), btrim(p_prompt), p_schedule, due, public._msgr2_automation_gen(uid) from public.msgr2_rooms r where r.id = p_room
      on conflict (created_by, create_request_id) where create_request_id is not null do update set updated_at = msgr2_automations.updated_at
      returning * into a;
  else
    select * into a from public.msgr2_automations where id = p_automation for update;
    if a.id is null or a.created_by is distinct from uid or a.deleted_at is not null then perform public._msgr2_automation_deny('forbidden'); end if;
    if a.room_id is distinct from p_room then raise exception 'msgr_automation_channel_immutable' using errcode = '22023'; end if; -- 기록은 처음 방에 붙어 있다
    update public.msgr2_automations set agent_id = p_agent, title = btrim(p_title), prompt = btrim(p_prompt), schedule = p_schedule, next_run_at = due,
      owner_gen = public._msgr2_automation_gen(uid), last_error = null, updated_at = now() where id = p_automation returning * into a;
  end if;
  return to_jsonb(a);
end $$;

create or replace function public.msgr2_automation_set_enabled(p_automation uuid, p_enabled boolean) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); a public.msgr2_automations; why text;
begin
  select * into a from public.msgr2_automations where id = p_automation for update;
  if a.id is null or a.created_by is distinct from uid or a.deleted_at is not null then perform public._msgr2_automation_deny('forbidden'); end if;
  if p_enabled is null then raise exception 'msgr_automation_invalid_schedule' using errcode = '22023'; end if;
  if p_enabled then -- 끄기는 권한을 잃은 뒤에도 된다. 다시 켜기는 지금 권한이 있어야 한다
    why := public._msgr2_automation_why(uid, a.room_id, a.agent_id);
    if why is not null then perform public._msgr2_automation_deny(why); end if;
  end if;
  update public.msgr2_automations set enabled = p_enabled,
    next_run_at = case when p_enabled then public._msgr2_automation_next(a.schedule, now()) else a.next_run_at end,
    owner_gen = case when p_enabled then public._msgr2_automation_gen(uid) else owner_gen end,
    last_error = case when p_enabled then null else last_error end, updated_at = now()
   where id = p_automation returning * into a;
  return to_jsonb(a);
end $$;

create or replace function public.msgr2_automation_delete(p_automation uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app();
begin
  update public.msgr2_automations set deleted_at = now(), enabled = false, updated_at = now()
   where id = p_automation and created_by = uid and deleted_at is null;
  if not found then perform public._msgr2_automation_deny('forbidden'); end if;
  return true;
end $$;

-- 내부: 실행 1회. 실행 기록 → (권한 다시 보기) → 지시 글(만든 사람 이름, 에이전트 멘션) → 그 글로 생긴 일을 기록에 잇는다.
-- 사람 RPC(run_now)와 크론(dispatch)이 같은 길을 쓴다. 권한이 없으면 글을 넣지 않고 'blocked' + 자동화를 끈다.
create or replace function public._msgr2_automation_enqueue(a public.msgr2_automations, p_mode text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.msgr2_automation_runs; msg bigint; wid uuid; why text; nxt timestamptz;
begin
  nxt := case when p_mode = 'schedule' then public._msgr2_automation_next(a.schedule, now()) else a.next_run_at end;
  -- 앞 회차의 일이 끝나지 않은 채 멈췄으면 그 기록을 닫는다 — 할 일이 있을 때만 쓴다(유휴 쓰기 0).
  -- 받지 않고 만료(offered 기한 지남) = expired, 받은 뒤 리스가 끝나도 결과가 없음(결과 모름 — 본체가 잠듦·꺼짐) = stalled(검수 지적 2)
  update public.msgr2_automation_runs x set status = 'failed', error = case when w.state = 'offered' then 'expired' else 'stalled' end, finished_at = now()
    from public.msgr2_works w
   where x.automation_id = a.id and x.status in ('queued', 'running') and w.id = x.work_id
     and ((w.state = 'offered' and w.expires_at <= now()) or (w.state in ('accepted', 'running') and coalesce(w.lease_until, '-infinity') <= now()));
  insert into public.msgr2_automation_runs (automation_id, scheduled_for, trigger, status)
    values (a.id, case when p_mode = 'schedule' then a.next_run_at else clock_timestamp() end, p_mode, 'queued') returning * into r;
  why := case when public._msgr2_paused() then 'service_paused'
              when a.owner_gen is distinct from public._msgr2_automation_gen(a.created_by) then 'session_revoked' -- 만든 뒤 모든 기기 로그아웃·기기 폐기: 그 세션이 건 일정은 다시 켜야 돈다
              else public._msgr2_automation_why(a.created_by, a.room_id, a.agent_id) end;
  if why is not null then
    update public.msgr2_automation_runs set status = 'blocked', error = why, finished_at = now() where id = r.id returning * into r;
    update public.msgr2_automations set enabled = case when why = 'service_paused' then enabled else false end,
      last_run_at = now(), last_status = 'blocked', last_error = why, next_run_at = nxt, updated_at = now() where id = a.id;
    return to_jsonb(r);
  end if;
  insert into public.msgr2_messages (room_id, author_kind, author_user_id, kind, body, mentions, client_msg_id, meta)
    values (a.room_id, 'user', a.created_by, 'text', a.prompt, array[a.agent_id], 'automation:' || r.id,
            jsonb_build_object('automation_id', a.id, 'automation_run_id', r.id, 'automation_title', a.title, 'scheduled_for', r.scheduled_for))
    returning id into msg;
  select w.id into wid from public.msgr2_works w where w.source_message_id = msg and w.agent_id = a.agent_id order by w.created_at limit 1;
  if wid is null then -- 글은 남았지만 일이 생기지 않았다(일 상한·본체 기능·에이전트 주인 Pro — 방에 안내 1줄이 이미 있다)
    update public.msgr2_automation_runs set message_id = msg, status = 'blocked', error = 'no_work', finished_at = now() where id = r.id returning * into r;
  else
    update public.msgr2_automation_runs set message_id = msg, work_id = wid where id = r.id returning * into r;
  end if;
  update public.msgr2_automations set last_run_at = now(), last_message_id = msg, last_status = r.status, last_error = r.error, next_run_at = nxt, updated_at = now()
   where id = a.id;
  return to_jsonb(r);
end $$;

create or replace function public.msgr2_automation_run_now(p_automation uuid, p_request_id uuid default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); a public.msgr2_automations; prev jsonb; res jsonb; why text;
begin
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into a from public.msgr2_automations where id = p_automation for update;
  if a.id is null or a.created_by is distinct from uid or a.deleted_at is not null then perform public._msgr2_automation_deny('forbidden'); end if;
  if p_request_id is not null then
    select to_jsonb(x) into prev from public.msgr2_automation_runs x where x.automation_id = p_automation and x.request_id = p_request_id;
    if prev is not null then return prev; end if;
  end if;
  why := public._msgr2_automation_why(uid, a.room_id, a.agent_id);
  if why is not null then perform public._msgr2_automation_deny(why); end if;
  res := public._msgr2_automation_enqueue(a, 'manual');
  update public.msgr2_automation_runs x set request_id = p_request_id where x.id = (res->>'id')::uuid returning to_jsonb(x) into res;
  return res;
end $$;

-- 크론 전용(매분 1회). 사람 세션(auth.uid() 있음)이 부르면 거부한다 — 일정 실행은 언제나 원래 사람의 권한을 _msgr2_automation_why로 다시 본 뒤에만 글을 넣는다.
-- 할 일이 없으면 쓰기 0. 한 번에 50개까지, 다른 실행과 겹치면 건너뛴다(skip locked). 자동화마다 진행 중인 일이 있으면 그 회차는 기다린다(쌓지 않는다).
-- 진행 중 = 결재 대기, 받기 전(기한 안), 받은 뒤 리스 안. 리스가 끝난 결과 모름(stalled) 일은 기다리지 않는다 — 하나가 일정을 영구히 멈추지 않게(검수 지적 2).
-- 한 행이 실패해도 다른 행은 돈다. 실패한 행은 'failed'를 남기고 다음 회차로 넘긴다(매분 재시도 폭주 없음). 오류 원문은 남기지 않는다(지시 내용이 들어 있을 수 있다).
create or replace function public.msgr2_automation_dispatch() returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a public.msgr2_automations; n int := 0; nxt timestamptz;
begin
  if auth.uid() is not null then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  if public._msgr2_paused() then return 0; end if; -- 중단 중에는 쓰지 않는다(재개 뒤 놓친 회차는 한 번으로 합쳐 돈다)
  for a in select au.* from public.msgr2_automations au
            where au.enabled and au.deleted_at is null and au.next_run_at <= now()
              and not exists (select 1 from public.msgr2_automation_runs p join public.msgr2_works w on w.id = p.work_id
                               where p.automation_id = au.id and p.status in ('queued', 'running')
                                 and (w.state = 'awaiting_approval' or (w.state = 'offered' and w.expires_at > now())
                                      or (w.state in ('accepted', 'running') and w.lease_until > now())))
            order by au.next_run_at limit 50 for update of au skip locked
  loop
    begin
      perform public._msgr2_automation_enqueue(a, 'schedule');
      n := n + 1;
    exception when others then
      begin nxt := public._msgr2_automation_next(a.schedule, now()); exception when others then nxt := null; end;
      update public.msgr2_automations set enabled = nxt is not null, next_run_at = coalesce(nxt, next_run_at), last_run_at = now(),
        last_status = 'failed', last_error = 'dispatch_failed', updated_at = now() where id = a.id;
      insert into public.msgr2_automation_runs (automation_id, scheduled_for, trigger, status, error, finished_at)
        values (a.id, a.next_run_at, 'schedule', 'failed', 'dispatch_failed', now()) on conflict do nothing;
    end;
  end loop;
  return n;
end $$;

-- 일정이 서버에서 도는가(화면 안내). 크론 작업이 걸려 있고 켜져 있으면 참 — 매분 표시를 쓰지 않는다(유휴 쓰기 0).
create or replace function public.msgr2_automation_scheduler_status() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare on_ boolean := false;
begin
  if auth.uid() is null then return jsonb_build_object('server_active', false); end if;
  if to_regclass('cron.job') is not null then
    execute 'select exists (select 1 from cron.job where jobname = $1 and active)' into on_ using 'msgr2-automation-dispatch';
  end if;
  return jsonb_build_object('server_active', coalesce(on_, false));
end $$;

-- 일 상태 → 실행 기록 상태. 자동화 글로 생긴 일만(실행 기록 work_id 색인). 일이 끝나면 completed/failed, 받은 뒤는 running.
create or replace function public._msgr2_automation_work_state() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare s text; a_id uuid;
begin
  s := case new.state when 'done' then 'completed' when 'failed' then 'failed' when 'cancelled' then 'failed' when 'offered' then null else 'running' end;
  if s is null then return null; end if;
  for a_id in update public.msgr2_automation_runs x set status = s, error = case when s = 'failed' then coalesce(new.error_code, new.state) else null end,
                finished_at = case when s in ('completed', 'failed') then now() else null end
              where x.work_id = new.id and x.status in ('queued', 'running') and x.status is distinct from s
              returning x.automation_id
  loop
    update public.msgr2_automations set last_status = s, last_error = case when s = 'failed' then coalesce(new.error_code, new.state) else null end
     where id = a_id and last_message_id = new.source_message_id;
  end loop;
  return null;
end $$;
drop trigger if exists msgr2_automation_work_state on public.msgr2_works;
create trigger msgr2_automation_work_state after update of state on public.msgr2_works
  for each row when (old.state is distinct from new.state and new.source_message_id is not null) execute function public._msgr2_automation_work_state();

revoke all on function public._msgr2_automation_next(jsonb, timestamptz), public._msgr2_automation_why(uuid, uuid, uuid), public._msgr2_automation_deny(text), public._msgr2_automation_gen(uuid),
  public._msgr2_automation_enqueue(public.msgr2_automations, text), public._msgr2_automation_work_state(), public.msgr2_automation_dispatch() from public, anon, authenticated;
grant execute on function public.msgr2_automation_dispatch() to service_role;
revoke all on function public.msgr2_automation_save(uuid, uuid, uuid, text, text, jsonb, uuid), public.msgr2_automation_set_enabled(uuid, boolean),
  public.msgr2_automation_delete(uuid), public.msgr2_automation_run_now(uuid, uuid), public.msgr2_automation_scheduler_status() from public, anon;
grant execute on function public.msgr2_automation_save(uuid, uuid, uuid, text, text, jsonb, uuid), public.msgr2_automation_set_enabled(uuid, boolean),
  public.msgr2_automation_delete(uuid), public.msgr2_automation_run_now(uuid, uuid), public.msgr2_automation_scheduler_status() to authenticated;

do $do$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr2-automation-dispatch', '* * * * *', $c$select public.msgr2_automation_dispatch()$c$);
    perform cron.schedule('purge-msgr2-automation-runs', '53 3 * * *', $c$delete from public.msgr2_automation_runs where created_at < now() - interval '30 days'$c$);
  end if;
end $do$;
