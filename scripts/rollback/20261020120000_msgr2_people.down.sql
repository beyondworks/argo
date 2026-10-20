-- 되돌림: 20261020120000_msgr2_people.sql — 사람 채팅 스위치·상한·퍼짐·알림 묶음·첫 글 첨부 기다림을 걷어내고 이전 정의로 돌린다
-- (lite·관문·사람 글 → 일 = 20261019160000, 글 방송·정리 = 20261018010000, 퍼짐 = 20261018020000, 알림 = 20261018061100).
-- 멈춤: 첨부를 기다리는 글(msgr2_msg_waits)이 남아 있으면 멈춘다 — select public._msgr2_flush_waits(null, null)(기한이 지난 것만)로 비우거나 기다린다.
-- 이미 만든 팀 공간·방·사람 글은 지우지 않는다(기억 데이터). files_expected 열은 지운다(첨부 수 표시만).
do $$ begin
  if to_regclass('public.msgr2_msg_waits') is not null and exists (select 1 from public.msgr2_msg_waits) then
    raise exception '첨부를 기다리는 글이 남아 있다 — 비운 뒤 다시';
  end if;
end $$;
delete from public.msgr_settings where key = 'msgr2_people';
drop trigger if exists msgr2_lite_guard on public.msgr2_space_members;
create or replace function public._msgr2_lite() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public._msgr2_setting('msgr2_lite'), 'on') <> 'off' $$;
create or replace function public.msgr2_lite_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.msgr2_spaces; r public.msgr2_rooms; n int;
begin
  if auth.uid() is null or not public._msgr2_lite() then return new; end if;
  if tg_table_name = 'msgr2_spaces' then
    if new.kind <> 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    return new;
  end if;
  if tg_table_name = 'msgr2_space_invites' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
  -- 사람 글쓰기: 허용 방(_msgr2_lite_room_ok)에서만(#1117 검수 H1 — 이미 있는 팀·사람·여럿 방 막기)
  if tg_table_name = 'msgr2_messages' then
    if new.author_kind = 'user' and not public._msgr2_lite_room_ok(new.room_id) then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    return new;
  end if;
  -- msgr2_room_members: 새로 넣거나 빠졌던 멤버를 되살릴 때
  if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  if s.kind is distinct from 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
  if new.member_kind = 'user' then
    if new.member_id <> s.owner_user_id then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    return new;
  end if;
  if not exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.owner_user_id = s.owner_user_id) then
    raise exception 'msgr2_lite_only' using errcode = '42501';
  end if;
  select count(*) into n from public.msgr2_room_members m
   where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id <> new.member_id;
  if r.meeting then
    if exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.hosting = 'bot') then
      raise exception 'msgr2_meeting_no_bot' using errcode = '22023';
    end if;
    if n >= public._msgr2_clamp('msgr2_meeting_agents', 5, 5) then raise exception 'msgr2_meeting_full' using errcode = '22023'; end if;
  elsif n >= 1 then
    raise exception 'msgr2_lite_only' using errcode = '42501'; -- 회의방이 아닌 방은 에이전트 1명(1:1)
  end if;
  return new;
end $$;
create or replace function public.msgr2_on_user_message() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[]; v_meeting boolean; parts uuid[];
begin
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if; -- 이전(U8) 백필: offer·카운터 쓰기 없음
  if new.author_kind <> 'user' then return null; end if;
  update public.msgr2_room_counters set agent_streak = 0, streak_noted = false where room_id = new.room_id and (agent_streak <> 0 or streak_noted);
  -- A+ 회의방: 사람 글 1개 = offer 1개(대표 = 참가자 첫째). 참가자 = 멘션한 방 에이전트(없으면 방의 모든 에이전트), 봇 제외, 최대 5
  select r.meeting into v_meeting from public.msgr2_rooms r where r.id = new.room_id;
  if coalesce(v_meeting, false) then
    select array_agg(q.member_id order by q.added_at, q.member_id) into parts from (
      select m.member_id, m.added_at from public.msgr2_room_members m join public.msgr2_agents g on g.id = m.member_id and g.status = 'active' and g.hosting = 'local'
       where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null
         and (cardinality(new.mentions) = 0 or m.member_id = any (new.mentions))
       order by m.added_at, m.member_id limit public._msgr2_clamp('msgr2_meeting_agents', 5, 5)) q;
    if cardinality(parts) > 0 then
      perform public._msgr2_make_offer_x(new.room_id, new.topic_id, parts[1], 'user', new.author_user_id, new.author_user_id, new.body, new.id, null, 0, parts);
    end if;
    return null;
  end if;
  if cardinality(new.mentions) > 0 then
    select array_agg(distinct m.member_id) into targets from public.msgr2_room_members m
      where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id = any (new.mentions);
  elsif (select count(*) from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'user' and m.removed_at is null and m.member_id <> new.author_user_id) = 0
        and (select count(*) from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null) = 1 then
    select array_agg(m.member_id) into targets from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null;
  end if;
  foreach ag in array coalesce(targets, '{}') loop
    perform public._msgr2_make_offer(new.room_id, new.topic_id, ag, 'user', new.author_user_id, new.author_user_id, new.body, new.id, null, 0);
  end loop;
  return null;
end $$;
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
create or replace function public._msgr2_fanout(p_room uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select count(*) into n from public._msgr2_room_humans(p_room);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_setting_int('msgr2_fanout_max', 50) then
    perform public._msgr2_send_s(s.id, p_event, p_payload);
    for u in select h from public._msgr2_room_humans(p_room) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, p_event, p_payload);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(p_room) loop perform public._msgr2_send_u(u, p_event, p_payload); end loop;
  end if;
end $$;
create or replace function public.msgr2_push_enqueue() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if new.deleted_at is not null or not public._msgr2_push_target(new.kind, new.meta) then return new; end if;
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return new; end if; -- 이전(U8) 백필: 옛 글 수백만 건에 알림을 보내지 않는다
  if public._msgr2_paused() then return new; end if;
  select value into url from public.msgr_settings where key = 'msgr2_push_url';
  if url is null or url = '' then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(), body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 20000);
  return new;
exception when others then return new;
end $$;
create or replace function public._msgr2_bf_spaces(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_spaces as t (id, kind, name, slug, owner_user_id, created_at, deleted_at)
  select o.id, 'team', o.name, o.slug, o.owner_user_id, o.created_at, o.deleted_at from public.msgr_orgs o
  on conflict (id) do update set name = excluded.name, slug = excluded.slug, owner_user_id = excluded.owner_user_id, deleted_at = excluded.deleted_at
  where (t.name, t.slug, t.owner_user_id, t.deleted_at) is distinct from (excluded.name, excluded.slug, excluded.owner_user_id, excluded.deleted_at);
  get diagnostics written = row_count;
  insert into public.msgr2_spaces (kind, owner_user_id)
  select 'personal', u from (
    select user_id as u from public.msgr_org_members
    union select member_id from public.msgr_channel_members where member_kind = 'user'
    union select created_by from public.msgr_channels
    union select owner_user_id from public.msgr_crews
    union select user_id from public.msgr_profiles) x
   where u is not null and not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')
  on conflict (owner_user_id) where kind = 'personal' do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;
create or replace function public._msgr2_bf_space_members(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_space_members as t (space_id, user_id, role, display_name, joined_at, removed_at, expires_at)
  select m.org_id, m.user_id, m.role, m.display_name, m.joined_at, m.removed_at, m.expires_at from public.msgr_org_members m
  on conflict (space_id, user_id) do update set role = excluded.role, display_name = excluded.display_name, removed_at = excluded.removed_at, expires_at = excluded.expires_at
  where (t.role, t.display_name, t.removed_at, t.expires_at) is distinct from (excluded.role, excluded.display_name, excluded.removed_at, excluded.expires_at);
  get diagnostics written = row_count;
  update public.msgr2_space_members t set removed_at = now()
   where t.removed_at is null and exists (select 1 from public.msgr_orgs o where o.id = t.space_id)
     and not exists (select 1 from public.msgr_org_members m where m.org_id = t.space_id and m.user_id = t.user_id);
  get diagnostics k = row_count; written := written + k;
  insert into public.msgr2_space_members (space_id, user_id, role, joined_at)
  select s.id, s.owner_user_id, 'owner', s.created_at from public.msgr2_spaces s
   where s.kind = 'personal' and not exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id = s.owner_user_id)
  on conflict do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;
create or replace function public.msgr2_backfill_verify(p_sample int default 200) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare miss jsonb; rooms_bad bigint; sample_bad bigint; ok boolean; oc jsonb;
begin
  if auth.uid() is not null then raise exception 'msgr2_backfill_service_only' using errcode = '42501'; end if;
  miss := jsonb_build_object(
    'agents', (select count(*) from public.msgr_agents a where not exists (select 1 from public.msgr2_agents v where v.id = a.id)),
    'spaces_team', (select count(*) from public.msgr_orgs o where not exists (select 1 from public.msgr2_spaces s where s.id = o.id and s.kind = 'team')),
    'spaces_personal', (select count(*) from (select created_by u from public.msgr_channels where org_id is null union select user_id from public.msgr_org_members) x
                          where not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')),
    'space_members', (select count(*) from public.msgr_org_members m where not exists (select 1 from public.msgr2_space_members v
                        where v.space_id = m.org_id and v.user_id = m.user_id and v.role = m.role and v.removed_at is not distinct from m.removed_at and v.expires_at is not distinct from m.expires_at)),
    'seats', (select count(*) from public.msgr_crews c where c.org_id is not null and not exists (select 1 from public.msgr2_agent_seats s where s.agent_id = c.agent_id and s.space_id = c.org_id and s.removed_at is null)),
    'rooms', (select count(*) from public.msgr_channels c where not exists (select 1 from public.msgr2_rooms r where r.id = c.id)),
    'room_members', (select count(*) from public._msgr2_bf_room_members_src() s where not exists (select 1 from public.msgr2_room_members v
                       where (v.room_id, v.member_kind, v.member_id) = (s.room_id, s.member_kind, s.member_id) and v.removed_at is null)),
    'messages', (select count(*) from public.msgr_messages m where not exists (select 1 from public.msgr2_messages v where v.id = m.id)),
    'attachments', (select count(*) from public.msgr_attachments a where not exists (select 1 from public.msgr2_attachments v where v.message_id = a.message_id and v.storage_path = 'msgr/' || a.storage_path)),
    'reads', (select count(*) from public.msgr_reads x where not exists (select 1 from public.msgr2_reads v where v.room_id = x.channel_id and v.user_id = x.user_id and v.last_read_id >= x.last_read_id)),
    'reactions', (select count(*) from public.msgr_reactions x where not exists (select 1 from public.msgr2_reactions v where (v.message_id, v.user_id, v.emoji) = (x.message_id, x.user_id, x.emoji))),
    'prefs', (select count(*) from public.msgr_channel_prefs x where not exists (select 1 from public.msgr2_prefs v where v.room_id = x.channel_id and v.user_id = x.user_id and v.muted = x.muted and (v.pinned or not x.pinned))),
    'approvals', (select count(*) from public.msgr_crew_approvals a where a.status = 'pending' and not exists (select 1 from public.msgr2_approvals v where v.id = a.id and v.state = 'expired')),
    'identity', (select case when coalesce((select max(id) from public.msgr_messages), 0) = 0 then 0
                     when (select last_value from pg_sequences where schemaname = 'public' and sequencename = split_part(pg_get_serial_sequence('public.msgr2_messages', 'id'), '.', 2))
                          >= greatest(coalesce((select max(id) from public.msgr2_messages), 0), (select max(id) from public.msgr_messages)) then 0 else 1 end));
  -- 방별 (id, md5(body)) — 옛 채널 글과 같은 방의 v2 글 중 옛 id인 것
  select count(*) into rooms_bad from (
    select o.channel_id, md5(string_agg(o.id::text || ':' || md5(o.body), ',' order by o.id)) h from public.msgr_messages o group by o.channel_id) old
    full join (
    select v.room_id, md5(string_agg(v.id::text || ':' || md5(v.body), ',' order by v.id)) h from public.msgr2_messages v
     where exists (select 1 from public.msgr_messages o where o.id = v.id) group by v.room_id) nw on nw.room_id = old.channel_id
   where old.h is distinct from nw.h;
  select count(*) into sample_bad from (select * from public.msgr_messages order by random() limit greatest(1, least(coalesce(p_sample, 200), 10000))) o
    left join public.msgr2_messages v on v.id = o.id
   where v.id is null or (v.room_id, v.body, v.created_at, v.edited_at, v.deleted_at, coalesce(v.author_user_id, '00000000-0000-0000-0000-000000000000'))
         is distinct from (o.channel_id, o.body, o.created_at, o.edited_at, o.deleted_at,
                           coalesce(case when o.author_kind = 'user' then o.author_user_id end, '00000000-0000-0000-0000-000000000000'))
      or v.reply_to is distinct from coalesce(o.reply_to, o.thread_root);
  oc := jsonb_build_object('msgr_orgs', (select count(*) from public.msgr_orgs), 'msgr_org_members', (select count(*) from public.msgr_org_members),
    'msgr_channels', (select count(*) from public.msgr_channels), 'msgr_channel_members', (select count(*) from public.msgr_channel_members),
    'msgr_crews', (select count(*) from public.msgr_crews), 'msgr_agents', (select count(*) from public.msgr_agents),
    'msgr_messages', (select count(*) from public.msgr_messages), 'msgr_attachments', (select count(*) from public.msgr_attachments),
    'msgr_reads', (select count(*) from public.msgr_reads), 'msgr_reactions', (select count(*) from public.msgr_reactions),
    'msgr_channel_prefs', (select count(*) from public.msgr_channel_prefs), 'msgr_target_prefs', (select count(*) from public.msgr_target_prefs),
    'msgr_crew_approvals', (select count(*) from public.msgr_crew_approvals));
  ok := rooms_bad = 0 and sample_bad = 0 and not exists (select 1 from jsonb_each_text(miss) e where e.value <> '0');
  if ok then update public.msgr2_backfill_jobs set verified_at = now(), updated_at = now(); end if;
  return jsonb_build_object('ok', ok, 'missing', miss, 'rooms_mismatch', rooms_bad, 'sample_mismatch', sample_bad, 'sample', p_sample, 'old_counts', oc);
end $$;
drop function if exists public._msgr2_org_in_msgr(uuid);
drop function if exists public._msgr2_fanout_max();
drop table if exists public.msgr2_push_gate;
drop function if exists public.msgr2_message_ready(bigint);
drop function if exists public._msgr2_flush_waits(uuid, uuid);
drop function if exists public._msgr2_user_offers(public.msgr2_messages);
drop function if exists public._msgr2_people();
drop table if exists public.msgr2_msg_waits;
drop index if exists public.msgr2_messages_author_recent;
drop index if exists public.msgr2_messages_room_recent;
drop index if exists public.msgr2_space_invites_creator;
alter table public.msgr2_messages drop constraint if exists msgr2_messages_files_expected_check;
alter table public.msgr2_messages drop column if exists files_expected;
revoke execute on function public.msgr2_lite_guard() from public, anon, authenticated;
revoke all on function public._msgr2_lite(), public.msgr2_retention_prune(), public.msgr2_on_message_broadcast(), public._msgr2_fanout(uuid, text, jsonb), public.msgr2_push_enqueue() from public, anon, authenticated;
notify pgrst, 'reload schema';
