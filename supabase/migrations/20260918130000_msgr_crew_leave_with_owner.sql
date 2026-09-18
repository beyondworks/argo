-- 규칙 14 — 에이전트는 주인이 데려오고, 주인이 나가면 같이 나가며, 주인은 언제든 데려갈 수 있다.
--
-- 전에는 서버가 이 규칙을 지키지 않았다.
--   1. "내 에이전트가 있으면 채널을 못 나간다"는 차단이 앱(클라이언트)에만 있었다. API로 자기 행을
--      지우면 통과했고, 비공개 채널이면 에이전트는 주인 없이 남아 받지도 쓰지도 못한 채 죽어 있었다
--      (수신이 주인의 열람권을 요구하기 때문).
--   2. 주인이 자기 에이전트를 **한 채널에서만** 빼는 경로가 없었다. 참여 행 삭제 정책은 "자기 사람 행
--      또는 방장"만 허용해, 주인은 전체 회수(파견 해제·삭제)만 할 수 있었다. 데려오는 것이 동의라면
--      빼는 것은 동의 철회인데, 철회할 방법이 없었다.
--   3. 주인이 에이전트 추가를 요청해 둔 채 비공개 채널을 나가면, 방장이 나중에 그 요청을 승인할 때
--      msgr_crew_join_apply가 나간 주인을 그 채널에 다시 넣었다(본인 뜻과 무관한 재입장).
--
-- 라이브 확인(2026-09-18, 읽기 전용): 크루 참여 행 65개 중 주인이 그 채널에 없는 행 0개, 조직 없는
-- 채널의 크루 행 0개. 되살릴 기존 행이 없으므로 이 파일은 앞으로의 나가기만 다룬다(백필 없음).

-- 회사 에이전트 = 조직 서비스 계정이 소유한 상주 에이전트. 사람이 주인이 아니므로 규칙 14 밖이다.
-- msgr_crew_tier는 봇(hosting='bot')도 'company'로 보지만 봇의 주인은 연결한 멤버라 여기에 쓰면 안 된다.
-- ponytail: 같은 정의가 PR #581의 msgr_channel_member_ok·msgr_crew_join에 인라인으로 있다 — #581 병합 뒤
-- 두 곳을 이 함수로 합칠 자리(판정이 두 벌이 되지 않게).
create or replace function public.msgr_crew_is_company(crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(bool_or(cr.hosting = 'resident' and cr.owner_user_id = o.service_user_id), false)
      from public.msgr_crews cr join public.msgr_orgs o on o.id = cr.org_id
     where cr.id = crew
$$;
revoke all on function public.msgr_crew_is_company(uuid) from public, anon;
grant execute on function public.msgr_crew_is_company(uuid) to authenticated;

-- 사람이 채널에서 빠지면(스스로 나감·방장이 뺌·조직 탈퇴 정리·채널 삭제 연쇄 — 경로를 가리지 않는다)
-- 그 사람이 주인인 에이전트도 그 채널에서 빠지고, 그 사람의 에이전트 추가 대기 요청도 닫힌다.
create or replace function public.msgr_crews_follow_owner_out() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare org uuid;
begin
  select c.org_id into org from public.msgr_channels c where c.id = old.channel_id; -- 채널 삭제 연쇄면 없다(감사 생략)

  with gone as (
    delete from public.msgr_channel_members m using public.msgr_crews cr
     where m.channel_id = old.channel_id and m.member_kind = 'crew' and m.member_id = cr.id
       and cr.owner_user_id = old.member_id and not public.msgr_crew_is_company(cr.id)
    returning m.member_id)
  insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
  select org, auth.uid(), 'crew_left_with_owner', 'crew', g.member_id::text,
         jsonb_build_object('channel_id', old.channel_id, 'owner_user_id', old.member_id)
    from gone g where org is not null;

  -- 승인되지 않은 요청은 결정된 적이 없으므로 지운다. 거절로 남기면 "방금 거절된 요청은 한 시간 동안
  -- 다시 못 보낸다" 규칙이 엉뚱하게 걸린다.
  delete from public.msgr_channel_crew_requests q using public.msgr_crews cr
   where q.channel_id = old.channel_id and q.status = 'pending' and q.crew_id = cr.id
     and cr.owner_user_id = old.member_id and not public.msgr_crew_is_company(cr.id);
  return null;
end $$;
revoke all on function public.msgr_crews_follow_owner_out() from public, anon, authenticated;

drop trigger if exists msgr_crews_follow_owner_out on public.msgr_channel_members;
create trigger msgr_crews_follow_owner_out after delete on public.msgr_channel_members
  for each row when (old.member_kind = 'user') execute function public.msgr_crews_follow_owner_out();

-- 공개 채널에서 사람을 제외 목록(excluded_user_ids)에 넣으면 그 사람은 채널을 못 읽는다. 참여 행 삭제가 아니라
-- 위 트리거가 걸리지 않으므로, 목록에 새로 들어온 사람의 에이전트도 여기서 같이 뺀다(주인 없이 죽은 채 남지 않게).
create or replace function public.msgr_crews_follow_owner_excluded() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  with gone as (
    delete from public.msgr_channel_members m using public.msgr_crews cr
     where m.channel_id = new.id and m.member_kind = 'crew' and m.member_id = cr.id
       and cr.owner_user_id = any (new.excluded_user_ids)
       and not (cr.owner_user_id = any (coalesce(old.excluded_user_ids, '{}'::uuid[])))
       and not public.msgr_crew_is_company(cr.id)
    returning m.member_id, cr.owner_user_id)
  insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
  select new.org_id, auth.uid(), 'crew_left_with_owner', 'crew', g.member_id::text,
         jsonb_build_object('channel_id', new.id, 'owner_user_id', g.owner_user_id, 'via', 'excluded')
    from gone g where new.org_id is not null;

  delete from public.msgr_channel_crew_requests q using public.msgr_crews cr
   where q.channel_id = new.id and q.status = 'pending' and q.crew_id = cr.id
     and cr.owner_user_id = any (new.excluded_user_ids)
     and not (cr.owner_user_id = any (coalesce(old.excluded_user_ids, '{}'::uuid[])))
     and not public.msgr_crew_is_company(cr.id);
  return null;
end $$;
revoke all on function public.msgr_crews_follow_owner_excluded() from public, anon, authenticated;

drop trigger if exists msgr_crews_follow_owner_excluded on public.msgr_channels;
create trigger msgr_crews_follow_owner_excluded after update of excluded_user_ids on public.msgr_channels
  for each row when (new.excluded_user_ids is distinct from old.excluded_user_ids)
  execute function public.msgr_crews_follow_owner_excluded();

-- 한 채널에서 에이전트 빼기 — 주인 본인 또는 그 채널의 방장. 반환: 'removed' | 'absent'
create or replace function public.msgr_crew_leave_channel(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; by_owner boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch;
  select * into cr from public.msgr_crews where id = crew;
  if c.id is null or cr.id is null then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
  by_owner := cr.owner_user_id = me;
  if not by_owner and not coalesce(public.msgr_can_manage_channel(ch), false) then
    raise exception 'msgr_forbidden' using errcode = '42501';
  end if;

  delete from public.msgr_channel_members where channel_id = ch and member_kind = 'crew' and member_id = crew;
  if not found then return 'absent'; end if;
  delete from public.msgr_channel_crew_requests where channel_id = ch and crew_id = crew and status = 'pending';
  if c.org_id is not null then
    insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
    values (c.org_id, me, 'crew_removed_from_channel', 'crew', crew::text,
            jsonb_build_object('channel_id', ch, 'by', case when by_owner then 'owner' else 'host' end));
  end if;
  return 'removed';
end $$;
revoke all on function public.msgr_crew_leave_channel(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_leave_channel(uuid, uuid) to authenticated;
