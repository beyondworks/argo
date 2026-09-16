-- 에이전트도 초대된 것만 채널에 있다. 멤버가 자기 에이전트를 넣을 때는 방장이 허락한다(유건 2026-09-16).
--   "에이전트 데려오기 설정을 해 놓으면 전체 에이전트가 다 들어오는 구조니? … 방장한테 '어떤 에이전트 추가를 허용하겠냐'는 구조가 나을 것 같은데."
--
-- 종전: 공개 채널은 조직에 파견된 에이전트가 제외 목록에 없으면 **자동으로 전원** 구성원이었다(msgr_crew_in_channel).
--       라이브(2026-09-16 읽기): 파견 에이전트 153개가 공개 채널 5개에 자동으로 들어가 있었고(765쌍), 실제로 말한 조합은 49쌍이었다.
-- 채널 정책(personal_crews)은 '들어오는가'가 아니라 '지시해도 되는가'를 정하는 스위치였다. 라이브 값은 전부 allowed.
--
-- 지금부터: 사람과 같은 규칙 — 채널에 있는 에이전트 = 참여 행이 있는 에이전트(공개·비공개·채팅 모두).
--   · 방장(채널 관리자)은 바로 넣는다.
--   · 참여자는 자기 에이전트를 정책대로: 바로 추가(allowed) / 방장 승인(approval, 기본) / 못 데려옴(blocked).
--   · 회사 에이전트는 참여자가 넣을 수 없고 방장에게 요청한다(최종 추가는 방장).
--   · 채팅(DM)은 참여자면 바로 넣는다(동등한 관계, #557 규칙 그대로).
-- 데스크톱 앱은 2026-09-13 이후 서버 배달 봉투(msgr_delivery_allowed → msgr_crew_in_channel)를 따르므로 이 판정만 바꾸면 바로 적용된다.

-- ── 1. 기존 공개 채널 이관 — 말하던 에이전트는 남긴다 ─────────────────────────
-- 그 채널에 글을 쓴 적 있는 활성 에이전트와, 그 채널에 자동화가 걸린 에이전트(아직 한 번도 안 돌았어도 — 검수 M-1).
-- 같은 조직, 내보낸 목록 밖. 파견만 되고 말한 적도 맡은 일도 없는 에이전트는 빠진다.
insert into public.msgr_channel_members (channel_id, member_kind, member_id)
select distinct x.channel_id, 'crew', x.crew_id
  from (select m.channel_id, m.crew_id from public.msgr_messages m where m.crew_id is not null
        union select a.channel_id, a.crew_id from public.msgr_automations a where a.deleted_at is null) x
  join public.msgr_channels c on c.id = x.channel_id
  join public.msgr_crews cr on cr.id = x.crew_id
 where c.kind = 'public' and c.archived_at is null
   and cr.status = 'active' and cr.org_id = c.org_id and not (x.crew_id = any (c.excluded_crew_ids))
   -- '못 데려옴' 채널의 개인 에이전트는 옮기지 않는다: 종전에도 지시를 못 받았고(instruct_check), 옮기면 게이트 트리거가 막아 이 파일 전체가 롤백된다
   -- (라이브 적용 실패 2026-09-17 — 막힌 공개 채널 1개에서 말한 개인 에이전트 30개). 회사 에이전트는 그대로 옮긴다.
   and (c.personal_crews is distinct from 'blocked' or public.msgr_crew_tier(x.crew_id) = 'company')
on conflict do nothing;

-- ── 2. 채널에 있는가 — 공개 채널도 참여 행 ───────────────────────────────────
-- 채널 정책은 구성원 여부를 바꾸지 않는다 — 못 데려옴은 '지금부터 새로 못 들어온다'이다(유건 2026-09-16). 아래 3 참고.
create or replace function public.msgr_crew_in_channel(ch uuid, crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels c join public.msgr_crews cr on cr.id = crew and cr.org_id = c.org_id
       where c.id = ch and not (crew = any (c.excluded_crew_ids))
         and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'crew' and m.member_id = crew)
    )
$$;

-- 봇 보내기·마무리도 같은 판정으로(종전에는 공개 채널을 따로 통과시켰다 — 최종 차단은 글 트리거가 하지만 오류 코드가 갈렸다)
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
  if not exists (select 1 from public.msgr_channels ch where ch.id = channel and public.msgr_crew_in_channel(channel, b.crew_id)) then raise exception 'msgr_bot_not_member'; end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', body, '[]', '{"disposition":"done"}') returning id into mid;
  return mid;
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
      and (ch.kind = 'dm' or public.msgr_crew_in_channel(channel, c.id))) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', src_id, root_id, 'reply:' || b.crew_id::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;

-- ── 3. 채널 정책 값 — 바로 추가 / 방장 승인 / 못 데려옴 (+ 종전의 보기만) ────
-- 화면에서 고르는 것은 셋이다. read_only(보기만 — 멤버는 두고 지시만 막음)는 의미 있는 상태라 서버에서는 그대로 둔다(라이브 사용 0).
-- 기존 allowed 채널은 방장 승인으로 옮긴다(유건 제안). 채팅은 참여자면 바로 넣으므로 allowed로 둔다.
alter table public.msgr_channels drop constraint if exists msgr_channels_personal_crews_check;
update public.msgr_channels set personal_crews = 'approval' where personal_crews = 'allowed' and kind <> 'dm';
alter table public.msgr_channels add constraint msgr_channels_personal_crews_check check (personal_crews in ('allowed', 'approval', 'read_only', 'blocked'));
alter table public.msgr_channels alter column personal_crews set default 'approval';

-- 못 데려옴 = 설정한 때부터 **새로** 못 들어온다. 이미 방에 있는 에이전트는 퇴장시키지 않고 그대로 일한다(유건 2026-09-16).
-- 종전에는 전환하는 순간 개인 에이전트 행을 지웠다 — 칸을 한 번 눌렀다 되돌리는 것만으로 초대한 에이전트가 영구히 빠졌다(실측: 검수 중 서윤이 사라짐).
-- 새로 못 들어오게 하는 일은 게이트 트리거(msgr_channel_personal_gate)와 msgr_crew_join이 한다. 이 트리거는 감사만 남긴다.
create or replace function public.msgr_channel_policy_sweep() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.personal_crews is distinct from old.personal_crews then
    perform public.msgr_audit(new.org_id, 'channel.personal_crews', 'channel', new.id::text, jsonb_build_object('from', old.personal_crews, 'to', new.personal_crews));
  end if;
  return new;
end $$;

-- 지시 판정: 들어온 에이전트는 일한다. 개인 에이전트 지시를 막는 것은 보기만(read_only)뿐이다 — 방장 승인은 들어오는 방식이고,
-- 못 데려옴은 새로 들어오는 것만 막는다(이미 있는 에이전트는 그대로 일한다, 유건 2026-09-16). 종전에는 allowed가 아니면 막았다.
create or replace function public.msgr_instruct_check(crew uuid, author uuid, channel uuid default null) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      when channel is not null and ch.personal_crews = 'read_only'
           and not (c.hosting = 'bot' or (o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident')) then 'channel_policy'
      when c.owner_user_id = author then 'ok'
      when c.allow = 'owner' then 'crew_allow'
      when c.allow = 'list' then case when author = any (c.allow_users) and m.user_id is not null then 'ok' else 'crew_allow' end
      else case when m.user_id is not null then 'ok' else 'crew_allow' end
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_orgs o on o.id = c.org_id
      left join public.msgr_channels ch on ch.id = channel
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$$;

-- ── 4. 에이전트 참여 요청 ─────────────────────────────────────────────────────
create table if not exists public.msgr_channel_crew_requests (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  crew_id uuid not null references public.msgr_crews (id) on delete cascade,
  requested_by uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz
);
create unique index if not exists msgr_channel_crew_requests_open on public.msgr_channel_crew_requests (channel_id, crew_id) where status = 'pending';
create index if not exists msgr_channel_crew_requests_channel on public.msgr_channel_crew_requests (channel_id) where status = 'pending';
alter table public.msgr_channel_crew_requests enable row level security;
-- 읽기: 요청한 사람과 그 채널의 방장. 쓰기는 아래 RPC(definer)로만.
drop policy if exists msgr_channel_crew_requests_select on public.msgr_channel_crew_requests;
create policy msgr_channel_crew_requests_select on public.msgr_channel_crew_requests for select to authenticated
  using (requested_by = (select auth.uid()) or public.msgr_can_manage_channel(channel_id));
grant select on public.msgr_channel_crew_requests to authenticated;

-- 방장인가 — 채팅이 아닌 채널의 관리자(생성자·채널 관리자·조직 관리자). 채팅은 참여자가 동등하므로 따로 다룬다.
create or replace function public.msgr_is_channel_host(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch and c.kind <> 'dm'
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids) or coalesce(public.msgr_is_admin(c.org_id), false)))
$$;
revoke all on function public.msgr_is_channel_host(uuid) from public, anon;
grant execute on function public.msgr_is_channel_host(uuid) to authenticated;

-- 실제로 넣는다(권한 판정은 호출한 쪽이 끝냈다). 비공개 채널에 남의 에이전트를 넣으면 주인도 함께 넣는다(주인이 빠지면 에이전트가 조용히 죽는다).
create or replace function public.msgr_crew_join_apply(ch uuid, crew uuid, actor uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; owner_id uuid;
begin
  select c.kind into k from public.msgr_channels c where c.id = ch;
  select cr.owner_user_id into owner_id from public.msgr_crews cr where cr.id = crew;
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, actor) on conflict do nothing;
  if k = 'private' and owner_id is not null
     and not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = owner_id) then
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'user', owner_id, actor);
  end if;
end $$;
revoke all on function public.msgr_crew_join_apply(uuid, uuid, uuid) from public, anon, authenticated;

-- 에이전트 데려오기 — 반환: 'joined'(바로 들어감) | 'requested'(방장 승인 대기) | 'already'
create or replace function public.msgr_crew_join(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; tier text; in_room boolean; host boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch and archived_at is null;
  if c.id is null or c.org_id is null then raise exception 'msgr_no_channel' using errcode = '22023'; end if;
  select * into cr from public.msgr_crews where id = crew;
  if cr.id is null or cr.org_id is distinct from c.org_id or cr.status <> 'active' then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
  if exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'crew' and m.member_id = crew) then return 'already'; end if;
  tier := public.msgr_crew_tier(crew);
  if c.personal_crews = 'blocked' and tier is distinct from 'company' then raise exception 'msgr_channel_personal_blocked' using errcode = '42501'; end if;
  in_room := exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = me);
  host := public.msgr_is_channel_host(ch);

  if c.kind = 'dm' then -- 채팅: 참여자면 바로(자기 에이전트 또는 주인이 방에 있는 에이전트 — 사람을 끼워 넣지 않는다)
    if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
    if cr.owner_user_id <> me and not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = cr.owner_user_id) then
      raise exception 'msgr_forbidden' using errcode = '42501';
    end if;
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, me);
    return 'joined';
  end if;

  if host then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
  if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 채널에 참여한 사람만 데려온다
  if tier is distinct from 'company' and cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 남의 개인 에이전트는 못 데려온다
  if tier is distinct from 'company' and c.personal_crews = 'allowed' then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
  -- 방장 승인(개인 에이전트의 기본, 회사 에이전트는 항상). 방금 거절된 요청은 한 시간 동안 다시 보내지 않는다(방장 알림함이 같은 요청으로 차지 않게 — 검수 M-4)
  if exists (select 1 from public.msgr_channel_crew_requests q where q.channel_id = ch and q.crew_id = crew and q.status = 'rejected' and q.decided_at > now() - interval '1 hour') then
    raise exception 'msgr_request_recently_rejected' using errcode = '22023';
  end if;
  insert into public.msgr_channel_crew_requests (channel_id, crew_id, requested_by) values (ch, crew, me)
    on conflict (channel_id, crew_id) where status = 'pending' do nothing;
  return 'requested';
end $$;
revoke all on function public.msgr_crew_join(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_join(uuid, uuid) to authenticated;

-- 방장의 결정 — 반환: 'approved' | 'rejected'
create or replace function public.msgr_crew_join_decide(req uuid, approve boolean) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); r public.msgr_channel_crew_requests; c public.msgr_channels; cr public.msgr_crews;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into r from public.msgr_channel_crew_requests where id = req for update;
  if r.id is null or r.status <> 'pending' then raise exception 'msgr_request_closed' using errcode = '22023'; end if;
  if not public.msgr_is_channel_host(r.channel_id) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if approve then
    select * into c from public.msgr_channels where id = r.channel_id;
    select * into cr from public.msgr_crews where id = r.crew_id;
    if c.archived_at is not null or cr.id is null or cr.status <> 'active' then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
    if c.personal_crews = 'blocked' and public.msgr_crew_tier(r.crew_id) is distinct from 'company' then raise exception 'msgr_channel_personal_blocked' using errcode = '42501'; end if;
    perform public.msgr_crew_join_apply(r.channel_id, r.crew_id, me);
  end if;
  update public.msgr_channel_crew_requests set status = case when approve then 'approved' else 'rejected' end, decided_by = me, decided_at = now() where id = req;
  return case when approve then 'approved' else 'rejected' end;
end $$;
revoke all on function public.msgr_crew_join_decide(uuid, boolean) from public, anon;
grant execute on function public.msgr_crew_join_decide(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
