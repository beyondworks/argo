-- 2026-09-23 사고 복구: msgr-live-apply.sh가 옛 마이그레이션 7개를 재적용해 덮은 정의를 저장소 최신으로 되돌린다.
-- 생성: scratchpad/incident/build_restore.py (최신 마이그레이션 파일의 문장을 그대로 옮김). 데이터 문장 없음.
begin;
-- 9/17(20260917120000·20260917190000)에 지운 인자 없는 옛 정의가 재적용으로 되살아났다 — 인자 있는 정의와 겹친다
drop function if exists public.msgr_dm_personal_list();
-- msgr_can_manage_channel ← 20260917190000_msgr_personal_group_fixes.sql
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids)
                          or (c.kind <> 'dm' and c.org_id is not null and coalesce(public.msgr_is_admin(c.org_id), false))
                          or (c.kind = 'dm' and not (c.org_id is null and c.personal_pair is null)
                              and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())))
                     and (c.org_id is null or coalesce(public.msgr_is_member(c.org_id), false)))
$$;
-- msgr_can_write_channel ← 20260917190000_msgr_personal_group_fixes.sql
create or replace function public.msgr_can_write_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_can_read_channel(ch)
       and exists (select 1 from public.msgr_channels c
                    where c.id = ch and c.archived_at is null
                      and (c.org_id is null or not public.msgr_org_locked(c.org_id)))
       -- 차단하면 개인 1:1에 더 쓰지 못한다(지난 대화는 읽기로 남는다). 그룹은 차단 관계가 끼어도 각자 계속 쓴다(그룹 전체가 잠기지 않게).
       and not exists (
         select 1 from public.msgr_channels c
           join public.msgr_channel_members m on m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid()
           join public.msgr_friends f on f.a = least(auth.uid(), m.member_id) and f.b = greatest(auth.uid(), m.member_id)
          where c.id = ch and c.org_id is null and c.personal_pair is not null and f.status = 'blocked')
$$;
-- msgr_crew_join ← 20260918170000_msgr_dm_crew_approval.sql
create or replace function public.msgr_crew_join(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; tier text; in_room boolean; host boolean; company boolean;
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
  -- 조직 서비스 계정 소유의 상주 크루만 "회사 에이전트"다(msgr_crew_is_company — 20260918130000 정본). tier는 봇도 company로 보지만 봇의 주인은 연결한 멤버다.
  company := public.msgr_crew_is_company(crew); -- 크루 조직 = 채널 조직은 위에서 이미 확인(msgr_bad_member)

  if c.kind = 'dm' then -- 채팅: 참여자가 자기 에이전트만. 결재자(방을 연 사람)는 바로, 다른 참여자는 결재자에게 요청한다.
    if not in_room or cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
    if public.msgr_dm_approver(ch) = me then
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, me);
      return 'joined';
    end if;
  else
    if not company and cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 남의 에이전트는 방장이어도 못 데려온다 — 그 주인이 요청한다
    if host then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
    if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 채널에 참여한 사람만 데려온다
    if tier is distinct from 'company' and c.personal_crews = 'allowed' then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if; -- '누구나 데려옴' = 방장의 사전 승인
  end if;
  -- 결재 요청(채널 = 방장, 채팅 = 결재자). 방금 거절된 요청은 한 시간 동안 다시 보내지 않는다(결재자 알림함이 같은 요청으로 차지 않게 — 검수 M-4)
  if exists (select 1 from public.msgr_channel_crew_requests q where q.channel_id = ch and q.crew_id = crew and q.status = 'rejected' and q.decided_at > now() - interval '1 hour') then
    raise exception 'msgr_request_recently_rejected' using errcode = '22023';
  end if;
  insert into public.msgr_channel_crew_requests (channel_id, crew_id, requested_by) values (ch, crew, me)
    on conflict (channel_id, crew_id) where status = 'pending' do nothing;
  return 'requested';
end $$;
revoke all on function public.msgr_crew_join(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_join(uuid, uuid) to authenticated;
-- msgr_crew_join_decide ← 20260918170000_msgr_dm_crew_approval.sql
create or replace function public.msgr_crew_join_decide(req uuid, approve boolean) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); r public.msgr_channel_crew_requests; c public.msgr_channels; cr public.msgr_crews;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into r from public.msgr_channel_crew_requests where id = req for update;
  if r.id is null or r.status <> 'pending' then raise exception 'msgr_request_closed' using errcode = '22023'; end if;
  if not public.msgr_can_decide_crew_join(r.channel_id) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if approve then
    select * into c from public.msgr_channels where id = r.channel_id;
    select * into cr from public.msgr_crews where id = r.crew_id;
    if c.archived_at is not null or cr.id is null or cr.status <> 'active' then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
    if c.personal_crews = 'blocked' and public.msgr_crew_tier(r.crew_id) is distinct from 'company' then raise exception 'msgr_channel_personal_blocked' using errcode = '42501'; end if;
    if c.kind = 'dm' and not exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = cr.owner_user_id) then
      raise exception 'msgr_bad_member' using errcode = '22023'; -- 주인이 이미 나간 채팅에 그 에이전트만 들이지 않는다
    end if;
    perform public.msgr_crew_join_apply(r.channel_id, r.crew_id, me);
  end if;
  update public.msgr_channel_crew_requests set status = case when approve then 'approved' else 'rejected' end, decided_by = me, decided_at = now() where id = req;
  return case when approve then 'approved' else 'rejected' end;
end $$;
revoke all on function public.msgr_crew_join_decide(uuid, boolean) from public, anon;
grant execute on function public.msgr_crew_join_decide(uuid, boolean) to authenticated;
-- msgr_instruct_check ← 20260918150000_msgr_crew_room_members.sql
create or replace function public.msgr_instruct_check(crew uuid, author uuid, channel uuid default null) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      when channel is not null and ch.personal_crews = 'read_only'
           and not (c.hosting = 'bot' or public.msgr_crew_is_company(c.id)) then 'channel_policy'
      when channel is not null and public.msgr_crew_in_channel(channel, c.id)
           and m.user_id is not null and (m.expires_at is null or m.expires_at > now())
           and ((ch.kind = 'public' and m.role in ('owner', 'admin', 'member') and not (author = any (ch.excluded_user_ids)))
                or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'user' and cm.member_id = author)) then 'ok'
      when c.owner_user_id = author then 'ok'
      when c.allow = 'owner' then 'crew_allow'
      when c.allow = 'list' then case when author = any (c.allow_users) and m.user_id is not null then 'ok' else 'crew_allow' end
      else case when m.user_id is not null then 'ok' else 'crew_allow' end
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_channels ch on ch.id = channel
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$$;
-- msgr_is_channel_host ← 20260918170000_msgr_dm_crew_approval.sql
create or replace function public.msgr_is_channel_host(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch and c.kind <> 'dm'
                     and coalesce(public.msgr_is_member(c.org_id), false)
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids) or coalesce(public.msgr_is_admin(c.org_id), false)))
$$;
revoke all on function public.msgr_is_channel_host(uuid) from public, anon;
grant execute on function public.msgr_is_channel_host(uuid) to authenticated;
-- msgr_leave_dm ← 20260917200000_msgr_personal_group_leave.sql
create or replace function public.msgr_leave_dm(ch uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $fn$
declare me uuid := auth.uid(); channel public.msgr_channels; removed integer; heir uuid;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || ch::text));
  select * into channel from public.msgr_channels where id = ch for update;
  if channel.id is null then return false; end if;
  if channel.kind <> 'dm' then raise exception 'msgr_dm_required' using errcode = '22023'; end if;
  if channel.org_id is not null and not coalesce(public.msgr_is_member(channel.org_id), false) then
    raise exception 'msgr_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.msgr_channel_members
      where channel_id = ch and member_kind = 'user' and member_id = me) then return false; end if; -- 방에 있는 사람만 자기 자신을 뺀다(definer여도 남을 빼지 않는다)
  delete from public.msgr_channel_members m using public.msgr_crews c
    where m.channel_id = ch and m.member_kind = 'crew' and m.member_id = c.id
      and c.org_id = channel.org_id and c.owner_user_id = me;
  delete from public.msgr_channel_members where channel_id = ch and member_kind = 'user' and member_id = me;
  get diagnostics removed = row_count;
  if removed <> 1 then raise exception 'msgr_leave_failed' using errcode = '42501'; end if;
  -- 개인 그룹을 만든 사람이 나가면 관리(보관·삭제)를 남은 사람에게 넘긴다. created_by 잠금은 계정 삭제와 같은 이관 스위치로만 푼다(트랜잭션 한정)
  if channel.org_id is null and channel.personal_pair is null and channel.created_by = me then
    select m.member_id into heir from public.msgr_channel_members m
     where m.channel_id = ch and m.member_kind = 'user' order by m.added_at, m.member_id limit 1;
    if heir is not null then
      perform set_config('argo.msgr_account_delete', '1', true);
      update public.msgr_channels set created_by = heir where id = ch;
      perform set_config('argo.msgr_account_delete', '', true);
    end if;
  end if;
  return true;
end $fn$;
revoke all on function public.msgr_leave_dm(uuid) from public, anon;
grant execute on function public.msgr_leave_dm(uuid) to authenticated;
-- msgr_message_broadcast ← 20260918184500_msgr_private_room_broadcast.sql
create or replace function public.msgr_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb := jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id, 'crew_id', new.crew_id,
                                      'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to); -- 본문은 싣지 않는다(수신자는 RLS를 지난 조회로 읽는다)
begin
  if new.org_id is null then perform realtime.send(p, 'message', 'dm:' || new.channel_id::text, true); end if; -- 옛 앱(열린 개인 방) 호환
  perform public.msgr_room_send(p, 'message', new.org_id, new.channel_id);
  return new;
end $$;
-- msgr_message_fill ← 20260919090000_msgr_reply_thread_root.sql
create or replace function public.msgr_message_fill() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare found boolean; parent_root bigint;
begin
  select true, c.org_id into found, new.org_id from public.msgr_channels c where c.id = new.channel_id;
  if not coalesce(found, false) then raise exception 'msgr_channel_missing'; end if;
  if new.reply_to is not null then
    select coalesce(p.thread_root, p.id) into parent_root from public.msgr_messages p where p.id = new.reply_to and p.channel_id = new.channel_id;
    if parent_root is null then raise exception 'msgr_reply_cross_channel'; end if;
  end if;
  if new.thread_root is null then new.thread_root := parent_root; end if;
  return new;
end $$;
-- msgr_push_recipients ← 20260921150000_msgr_block_push.sql
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    -- 공개 채널도 채널 멤버 기준(종전에는 조직원 전원이었다 — 안 들어간 채널의 알림까지 갔다)
    select cm.member_id as u from public.msgr_channel_members cm
      where cm.channel_id = m.channel_id and cm.member_kind = 'user'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = m.channel_id and p.user_id = s.u and p.muted)
    and not public.msgr_on_desktop(s.u) -- PC 앞이면 그 화면의 배너로 이미 안다
    and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = s.u and b.blocked = m.author_user_id))
$$;
-- msgr_unread ← 20260921170000_msgr_block_unread.sql
create or replace function public.msgr_unread(org uuid)
returns table (channel_id uuid, n int, mention int)
language sql stable security invoker set search_path = public as $fn$
  select c.id,
         least(99, count(m.id))::int,
         least(99, count(m.id) filter (where m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', (select auth.uid())::text))))::int
  from public.msgr_channels c
  left join public.msgr_reads r on r.channel_id = c.id and r.user_id = (select auth.uid())
  join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
       and (m.author_user_id is null or m.author_user_id <> (select auth.uid()))
       and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = (select auth.uid()) and b.blocked = m.author_user_id))
  where (c.org_id = org or (org is null and c.org_id is null)) and c.archived_at is null and public.msgr_can_read_channel(c.id)
  group by c.id
$fn$;
grant execute on function public.msgr_unread(uuid) to authenticated;
-- 정책 msgr_realtime_recv ← 20260918184500_msgr_private_room_broadcast.sql
drop policy if exists msgr_realtime_recv on realtime.messages;
create policy msgr_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))
    or ((select realtime.topic()) = 'u:' || (select auth.uid())::text)));
-- 정책 msgr_channel_members_insert ← 20260918150000_msgr_crew_room_members.sql
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (public.msgr_can_manage_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id)
              and added_by = (select auth.uid())
              and (member_kind = 'crew' or not exists (select 1 from public.msgr_channels c where c.id = msgr_channel_members.channel_id and c.kind = 'dm')));
-- 정책 msgr_channel_crew_requests_select ← 20260918170000_msgr_dm_crew_approval.sql
drop policy if exists msgr_channel_crew_requests_select on public.msgr_channel_crew_requests;
create policy msgr_channel_crew_requests_select on public.msgr_channel_crew_requests for select to authenticated
  using (requested_by = (select auth.uid()) or public.msgr_can_decide_crew_join(channel_id));
commit;
