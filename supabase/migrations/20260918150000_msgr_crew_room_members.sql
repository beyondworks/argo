-- 에이전트는 주인이 데려온다. 방장이 문을 연다. 방에 들어온 에이전트는 방 전원이 부린다(유건 2026-09-18).
-- 종전에는 방에 있어도 크루의 허용 범위(allow='owner')가 이겨, 같은 방 멤버의 멘션이 조용히 거절됐다(라이브 msg 829, Lean Crew).
-- "방에 있다 = 주인이 데려왔다"가 서버에서 성립해야 새 규칙이 안전하다. 그래서 주인 요청 없이 크루가 방에 들어가던 경로 셋을 같이 막는다:
--   ① msgr_crew_join 방장 경로(소유자를 안 봤다) ② RLS 직접 삽입(msgr_channel_member_ok가 소유자를 안 봤다 — 조직 DM은 멤버 누구나)
--   ③ msgr_create_channel의 others(같은 함수만 봤다). 앱은 이미 자기·회사 에이전트만 넣었으므로(App.jsx 후보 필터) 앱 흐름은 그대로다.
-- 회사 에이전트 = 조직 서비스 계정 소유의 상주 크루(판정은 msgr_crew_is_company 하나 — 20260918130000에서 정의, 그래서 이 파일은 그 뒤 버전). msgr_crew_tier는 봇도 'company'로 보지만 봇의 주인은 연결한 멤버라 예외가 아니다.
-- 이미 방에 들어가 있는 크루에도 즉시 적용된다 — 라이브 실측(2026-09-18): 새로 열리는 것은 Lean Crew 한 방의 8개뿐.

-- ── 1. 에이전트는 주인이 넣는다(회사 에이전트는 방장이, DM은 예외 없음) ─────────────────────
create or replace function public.msgr_channel_member_ok(ch uuid, kind text, mid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case kind
      when 'user' then exists (select 1 from public.msgr_org_members m join public.msgr_channels c on c.id = ch
                                where m.org_id = c.org_id and m.user_id = mid and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))
      when 'crew' then exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch
                                where cr.id = mid and cr.org_id = c.org_id and cr.status = 'active'
                                  and (cr.owner_user_id = auth.uid() or (c.kind <> 'dm' and public.msgr_crew_is_company(cr.id))))
      else false end
$$;

-- 누가 넣었는지는 넣은 사람 자신만 적을 수 있다 — 영향 반경·감사가 added_by에 기댄다. 앱의 사람 추가는 이미 added_by = 나로 보낸다.
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (public.msgr_can_manage_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id)
              and added_by = (select auth.uid())
              and (member_kind = 'crew' or not exists (select 1 from public.msgr_channels c where c.id = msgr_channel_members.channel_id and c.kind = 'dm')));
drop policy if exists msgr_channel_members_update on public.msgr_channel_members;
create policy msgr_channel_members_update on public.msgr_channel_members for update to authenticated
  using (public.msgr_can_manage_channel(channel_id))
  with check (public.msgr_can_manage_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id) and added_by = (select auth.uid()));

-- ── 2. 에이전트 데려오기: 방장도 자기·회사 에이전트만 바로, 남의 것은 그 주인이 요청한다. DM은 자기 에이전트만 ──
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

  if c.kind = 'dm' then -- 채팅: 참여자가 자기 에이전트만 바로 넣는다(방장이 없다). 종전에는 주인이 같은 방에 있으면 남도 넣었다.
    if not in_room or cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, me);
    return 'joined';
  end if;

  if not company and cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 남의 에이전트는 방장이어도 못 데려온다 — 그 주인이 요청한다
  if host then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
  if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 채널에 참여한 사람만 데려온다
  if tier is distinct from 'company' and c.personal_crews = 'allowed' then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if; -- '누구나 데려옴' = 방장의 사전 승인
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

-- ── 3. 지시 판정: 방에 들어온 에이전트는 그 방을 읽는 사람 누구나 부린다 ──────────────────────
-- 보기만(read_only)이 먼저 이긴다. "그 방을 읽는가"는 msgr_can_read_channel과 같은 뿌리로, 단 auth.uid()가 아니라 author로 판정한다
-- (이 함수는 드레인·답글 재판정 등에서 호출자와 다른 작성자를 판정한다 — 브리지는 크루 주인 세션으로 돈다).
-- allow는 이제 방 밖(방에 들어오지 않은 에이전트를 부를 때)에서만 의미가 남는다.
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
