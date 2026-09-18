-- 채팅(DM — 1:1과 여러 명 모두)에서 참여자가 자기 에이전트를 넣을 때는 방을 연 사람이 결재한다(유건 2026-09-18).
-- 종전(20260918150000)에는 채팅 참여자 누구나 자기 에이전트를 바로 넣었다 — 채널의 방장 결재와 달리 채팅에는 결재자가 없었다.
-- 채널의 장치를 그대로 쓴다: 요청은 msgr_channel_crew_requests, 결정은 msgr_crew_join_decide, 화면은 방 패널 요청 목록·알림함.
--   ① 결재자 본인의 에이전트는 바로 들어간다
--   ② 다른 참여자의 에이전트는 요청이 되고, 결재자가 허락해야 들어간다
--   ③ 결재자 = 방을 연 사람(created_by)이 아직 방에 있으면 그 사람, 나갔으면 남은 사람 중 가장 먼저 들어온 사람.
--      저장하지 않고 매번 계산한다 — 나가는 경로(스스로 나감·계정 삭제·조직 탈퇴 정리)를 가리지 않고 따라가고, 대기 요청은 새 결재자에게 저절로 넘어간다.
--   ④ 서버가 강제한다: RPC(msgr_crew_join·decide)와 RLS 직접 삽입(msgr_channel_member_ok) 둘 다.
-- 이미 채팅에 들어가 있는 에이전트는 소급해서 빼지 않는다(라이브 2건, 모두 1:1 — 유건 결정 대기).

-- ── ③ 결재자 ────────────────────────────────────────────────────────────────
create or replace function public.msgr_dm_approver(ch uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(
      (select c.created_by from public.msgr_channels c
         join public.msgr_channel_members m on m.channel_id = c.id and m.member_kind = 'user' and m.member_id = c.created_by
        where c.id = ch and c.kind = 'dm'),
      (select m.member_id from public.msgr_channel_members m join public.msgr_channels c on c.id = m.channel_id
        where m.channel_id = ch and c.kind = 'dm' and m.member_kind = 'user'
        order by m.added_at, m.member_id limit 1))
$$;
revoke all on function public.msgr_dm_approver(uuid) from public, anon;
grant execute on function public.msgr_dm_approver(uuid) to authenticated;

-- 에이전트 참여 요청을 결정할 수 있는가 — 채널은 방장(msgr_is_channel_host, 그대로), 채팅은 결재자.
-- msgr_is_channel_host는 넓히지 않는다: crew_join 채널 분기의 '방장이면 바로'와 앱의 방장 판정이 그것을 본다.
create or replace function public.msgr_can_decide_crew_join(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    -- coalesce 필수: 채팅이 아니면 결재자가 NULL이고, NULL = uid는 NULL → plpgsql `if not NULL`은 예외를 던지지 않아 요청자가 스스로 허락했다(드릴 실측)
    select coalesce(public.msgr_is_channel_host(ch), false) or coalesce(public.msgr_dm_approver(ch) = auth.uid(), false)
$$;
revoke all on function public.msgr_can_decide_crew_join(uuid) from public, anon;
grant execute on function public.msgr_can_decide_crew_join(uuid) to authenticated;

-- ── ④ RLS 직접 삽입 — 채팅에서는 결재자만 자기 에이전트를 바로 넣는다(나머지는 msgr_crew_join 요청으로) ──
-- 20260918150000 정의에 채팅 조건 한 줄만 더한다. msgr_create_channel은 만든 사람을 먼저 넣은 뒤 others를 판정하므로 만든 사람이 곧 결재자다.
create or replace function public.msgr_channel_member_ok(ch uuid, kind text, mid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case kind
      when 'user' then exists (select 1 from public.msgr_org_members m join public.msgr_channels c on c.id = ch
                                where m.org_id = c.org_id and m.user_id = mid and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))
      when 'crew' then exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch
                                where cr.id = mid and cr.org_id = c.org_id and cr.status = 'active'
                                  and ((cr.owner_user_id = auth.uid() and (c.kind <> 'dm' or public.msgr_dm_approver(ch) = auth.uid()))
                                       or (c.kind <> 'dm' and public.msgr_crew_is_company(cr.id))))
      else false end
$$;

-- ── ①② 데려오기 — 채팅 분기만 바뀐다(채널 분기는 20260918150000 그대로) ─────────────────
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

-- ── 결정 — 채널 방장 또는 채팅 결재자. 채팅은 허락 시점에 요청자(주인)가 아직 방에 있어야 한다 ─────────
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

-- ── 요청 읽기 — 요청한 사람과 결정할 수 있는 사람만. **볼 수 있는 사람(요청자 제외) = 결정할 수 있는 사람**이 전제다(검수 LOW-2):
-- 알림함이 대기 참여 요청을 읽음과 무관하게 남기므로(App.jsx Inbox pendingMine), 보이는데 결정 못 하는 사람이 생기면 지울 수 없는 항목이 남는다.
-- 판정은 definer 함수 하나(msgr_can_decide_crew_join)로 — 정책 안에서 msgr_channels를 직접 읽으면 호출자의 RLS를 타서, 채팅을 나간
-- 조직 관리자에게는 그 방이 "채팅이 아닌 것"으로 보여 채널 조건(msgr_can_manage_channel)으로 새었다(드릴 실측). 채널은 종전 msgr_can_manage_channel과
-- 같은 사람들이다(차이는 조직을 떠난 채널 생성자 — 결정은 원래 할 수 있었다).
drop policy if exists msgr_channel_crew_requests_select on public.msgr_channel_crew_requests;
create policy msgr_channel_crew_requests_select on public.msgr_channel_crew_requests for select to authenticated
  using (requested_by = (select auth.uid()) or public.msgr_can_decide_crew_join(channel_id));

notify pgrst, 'reload schema';
