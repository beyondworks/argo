-- 파견 기록 + 채널 관리자 내보내기(0.1.108 U2 — 기억·공간 3단계 설계 G3·G4·E3·E4, 유건 결정 2026-10-14 "권장안대로").
-- 설계: _worktrees/argo-rc/artifacts/space-stage3/design.md
--
-- G3 — 지금 빈틈: 개인 에이전트는 주인만 채널에서 뺄 수 있어(20261002120000), 이미 들어온 남의 개인 에이전트를 채널 관리자가 내보낼 길이 없었다.
--   여는 범위: **조직의 공개·비공개 채널**의 방장(msgr_is_channel_host — 지금 그 채널 참여자인 만든 사람·채널 관리자, 또는 조직 관리자.
--   현재 조직 멤버여야 하고 DM은 아니다). 파견 요청을 승인·거절하는 사람과 같은 판정이다.
--   그대로 두는 범위: DM·개인 공간 방(친구 방·그룹)은 주인만 뺀다(유건 결정 2026-10-02 D8 "친구가 방 설정에서 에이전트를 내보내면 안 된다").
--   회사 에이전트(조직 서비스 계정 소유)는 종전대로 채널 관리자가 뺀다.
--   길: msgr_crew_leave_channel RPC **하나로만** 연다. 참여 행 직접 삭제(RLS msgr_channel_members_delete)와 공개 채널 제외 목록(excluded_crew_ids 가드)은
--   msgr_crew_removable 그대로(주인·회사 에이전트) — 기록과 1시간 막기를 건너뛰는 길을 만들지 않으려고 판정 함수를 따로 둔다(msgr_crew_admin_removable).
--   내보낸 뒤 1시간은 방장이 아닌 사람이 같은 채널에 그 에이전트를 다시 넣지 못한다(요청·'누구나 데려옴' 바로 넣기 모두 — 요청 거절과 같은 규칙·같은 오류).
-- G4 — 파견 기록 msgr_crew_dispatch_log: 사람이 누르는 함수 안에서만 1행(파견·거절·관리자 내보냄·주인 해제). 트리거로 모든 삽입을 기록하지 않는다
--   (사람이 누르지 않은 경로까지 쌓이지 않게). 주기 쓰기 0. 보존 1년(아래 정리 함수 + pg_cron 하루 1회 — 지울 행이 없으면 쓰기 0).
--   agent_id는 U1(msgr_agents, 20261014100000)의 msgr_crews.agent_id가 있으면 채우고 없으면 null — U1에 기대지 않는다(to_jsonb로 읽음).
-- 부하: 사람 행동 1회당 1행. 재가입 판정은 (channel_id, crew_id, at) 색인 1회.
-- 되돌리기: 아래 함수 다섯을 이전 정의(20261002120000·20260930210000·20260917090000·20260918170000)로, 표·정리 잡은 drop. 내보낸 에이전트는 주인이 다시 넣을 수 있다.

-- ── 1. 표 ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.msgr_crew_dispatch_log (
  id bigint generated always as identity primary key,
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  crew_id uuid not null references public.msgr_crews (id) on delete cascade,
  agent_id uuid, -- msgr_agents.id(U1). FK 없음 — U1 전·되돌림에서도 이 표가 선다
  event text not null check (event in ('dispatched', 'declined', 'removed_by_admin', 'released_by_owner')),
  actor uuid references auth.users (id) on delete set null,
  at timestamptz not null default now()
);
create index if not exists msgr_crew_dispatch_log_channel_crew on public.msgr_crew_dispatch_log (channel_id, crew_id, at desc);
create index if not exists msgr_crew_dispatch_log_crew on public.msgr_crew_dispatch_log (crew_id, at desc);
create index if not exists msgr_crew_dispatch_log_at on public.msgr_crew_dispatch_log (at); -- 보존 정리
alter table public.msgr_crew_dispatch_log enable row level security;
revoke all on public.msgr_crew_dispatch_log from public, anon, authenticated;
grant select on public.msgr_crew_dispatch_log to authenticated; -- 쓰기는 아래 정의자 함수로만
-- 읽기: 그 에이전트의 주인(내 에이전트가 어디서 내보내졌나 — 메신저 안내) 또는 그 채널 관리자
drop policy if exists msgr_crew_dispatch_log_select on public.msgr_crew_dispatch_log;
create policy msgr_crew_dispatch_log_select on public.msgr_crew_dispatch_log for select to authenticated
  using (exists (select 1 from public.msgr_crews cr where cr.id = crew_id and cr.owner_user_id = (select auth.uid()))
         or coalesce(public.msgr_can_manage_channel(channel_id), false));

-- ── 2. 내부 도우미 ─────────────────────────────────────────────────────────────────────
create or replace function public._msgr_dispatch_log(ch uuid, crew uuid, ev text, who uuid) returns void
  language sql security definer set search_path = public, pg_temp as $$
    insert into public.msgr_crew_dispatch_log (channel_id, crew_id, agent_id, event, actor)
    select ch, crew, nullif(to_jsonb(cr) ->> 'agent_id', '')::uuid, ev, who from public.msgr_crews cr where cr.id = crew
$$;
revoke all on function public._msgr_dispatch_log(uuid, uuid, text, uuid) from public, anon, authenticated;

-- 관리자가 1시간 안에 내보냈나 — 재가입 막기(요청 거절 msgr_request_recently_rejected와 같은 시간)
create or replace function public._msgr_crew_recently_removed(ch uuid, crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_crew_dispatch_log l
                    where l.channel_id = ch and l.crew_id = crew and l.event = 'removed_by_admin' and l.at > now() - interval '1 hour')
$$;
revoke all on function public._msgr_crew_recently_removed(uuid, uuid) from public, anon, authenticated;

-- ── 3. 관리자 내보내기 판정(G3) — 조직 공개·비공개 채널의 방장이 그 채널 조직의 에이전트를 뺄 수 있나. 앱이 버튼을 그릴 때도 부른다 ──
create or replace function public.msgr_crew_admin_removable(ch uuid, crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(public.msgr_is_channel_host(ch), false)
       and exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch
                    where cr.id = crew and c.org_id is not null and cr.org_id = c.org_id and c.kind in ('public', 'private'))
$$;
revoke all on function public.msgr_crew_admin_removable(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_admin_removable(uuid, uuid) to authenticated;

-- ── 4. 파견 적용 — 20260917090000 정의 + 실제로 들어갔을 때 기록 1행 ─────────────────────────────
create or replace function public.msgr_crew_join_apply(ch uuid, crew uuid, actor uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare k text; owner_id uuid;
begin
  select c.kind into k from public.msgr_channels c where c.id = ch;
  select cr.owner_user_id into owner_id from public.msgr_crews cr where cr.id = crew;
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, actor) on conflict do nothing;
  if found then perform public._msgr_dispatch_log(ch, crew, 'dispatched', actor); end if; -- 이미 있으면 기록하지 않는다(같은 파견을 두 번 적지 않게)
  if k = 'private' and owner_id is not null
     and not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = owner_id) then
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'user', owner_id, actor);
  end if;
end $$;
revoke all on function public.msgr_crew_join_apply(uuid, uuid, uuid) from public, anon, authenticated;

-- ── 5. 데려오기 — 20260930210000 정의 + ① DM 결재자 바로 넣기도 기록 ② 관리자가 1시간 안에 내보낸 에이전트는 방장이 아니면 다시 못 넣음 ──
create or replace function public.msgr_crew_join(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; tier text; in_room boolean; host boolean; company boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch and archived_at is null;
  if c.id is null then raise exception 'msgr_no_channel' using errcode = '22023'; end if;
  select * into cr from public.msgr_crews where id = crew;
  if cr.id is null or cr.org_id is distinct from c.org_id or cr.status <> 'active' then raise exception 'msgr_bad_member' using errcode = '22023'; end if; -- 개인 방은 개인 크루만(둘 다 NULL)
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
      perform public._msgr_dispatch_log(ch, crew, 'dispatched', me);
      return 'joined';
    end if;
  else
    if not company and cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 남의 에이전트는 방장이어도 못 데려온다 — 그 주인이 요청한다
    if host then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
    if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 채널에 참여한 사람만 데려온다
    -- 관리자가 1시간 안에 내보낸 에이전트 — 요청 거절과 같은 오류(옛 앱도 같은 안내). '누구나 데려옴' 바로 넣기도 막는다(내보낸 것이 곧 되돌아오지 않게)
    if public._msgr_crew_recently_removed(ch, crew) then raise exception 'msgr_request_recently_rejected' using errcode = '22023'; end if;
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

-- ── 6. 결정 — 20260918170000 정의 + 거절 기록(승인 기록은 msgr_crew_join_apply가 남긴다) ─────────────────
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
  else
    perform public._msgr_dispatch_log(r.channel_id, r.crew_id, 'declined', me);
  end if;
  update public.msgr_channel_crew_requests set status = case when approve then 'approved' else 'rejected' end, decided_by = me, decided_at = now() where id = req;
  return case when approve then 'approved' else 'rejected' end;
end $$;
revoke all on function public.msgr_crew_join_decide(uuid, boolean) from public, anon;
grant execute on function public.msgr_crew_join_decide(uuid, boolean) to authenticated;

-- ── 7. 빼기 RPC — 20261002120000 정의 + 관리자 갈래(G3)와 기록 ─────────────────────────────────────
-- 반환: 'removed' | 'absent' | 'owner_only'(방 관리자지만 이 에이전트를 뺄 권한 없음 — DM·친구 방의 남의 에이전트. 옛 앱의 사람 내보내기 순서가 멈추지 않게 예외 대신)
create or replace function public.msgr_crew_leave_channel(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; by_owner boolean; by_admin boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch;
  select * into cr from public.msgr_crews where id = crew;
  if c.id is null or cr.id is null then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
  by_owner := cr.owner_user_id = me;
  -- 주인·회사 에이전트(종전 판정)가 아니면 관리자 갈래 — 조직 공개·비공개 채널의 방장만(msgr_crew_admin_removable)
  by_admin := not public.msgr_crew_removable(ch, crew) and public.msgr_crew_admin_removable(ch, crew);
  if not public.msgr_crew_removable(ch, crew) and not by_admin then
    -- 방 관리자가 남의 에이전트를 빼려 하면 아무것도 하지 않고 'owner_only'를 돌려준다(예외 아님, 분리 검수 HIGH 2026-10-02).
    -- 이미 나간 옛 앱은 사람을 내보낼 때 그 사람의 에이전트부터 이 함수로 빼고, 오류가 나면 사람 행 삭제까지 가지 못했다.
    if coalesce(public.msgr_can_manage_channel(ch), false) then return 'owner_only'; end if;
    raise exception 'msgr_crew_remove_owner_only' using errcode = '42501';
  end if;

  delete from public.msgr_channel_members where channel_id = ch and member_kind = 'crew' and member_id = crew;
  if not found then return 'absent'; end if;
  delete from public.msgr_channel_crew_requests where channel_id = ch and crew_id = crew and status = 'pending';
  if c.org_id is not null then
    insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
    values (c.org_id, me, 'crew_removed_from_channel', 'crew', crew::text,
            jsonb_build_object('channel_id', ch, 'by', case when by_owner then 'owner' else 'host' end));
  end if;
  -- 주인이 뺐으면 해제, 그 밖(회사 에이전트를 방 관리자가·남의 개인 에이전트를 방장이)은 관리자 내보냄 — 내보냄은 1시간 재가입 막기의 근거다
  perform public._msgr_dispatch_log(ch, crew, case when by_owner then 'released_by_owner' else 'removed_by_admin' end, me);
  return 'removed';
end $$;
revoke all on function public.msgr_crew_leave_channel(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_leave_channel(uuid, uuid) to authenticated;

-- ── 8. 보존 정리(DB 위생 4) — 1년 지난 기록만. 지울 행이 없으면 쓰기 0 ───────────────────────────────
create or replace function public.msgr_crew_dispatch_log_prune() returns integer
  language sql security definer set search_path = public, pg_temp as $$
    with d as (delete from public.msgr_crew_dispatch_log where at < now() - interval '1 year' returning 1) select count(*)::int from d
$$;
revoke all on function public.msgr_crew_dispatch_log_prune() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr-crew-dispatch-log-prune', '41 3 * * *', $c$select public.msgr_crew_dispatch_log_prune()$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
