-- 에이전트를 방에서 빼는 것은 그 에이전트의 주인만(유건 결정 2026-10-02, 기능 점검 D8).
-- "내가 만든 방에는 내 에이전트를 마음대로 넣고 뺄 수 있어야 하고, 친구가 방 설정에서 에이전트를 내보내면 안 된다."
--   넣기: 지금 규칙 그대로(내가 결재자인 방이면 바로, 친구 방이면 방장 허락 — msgr_crew_join).
--   빼기: 주인만. 방장이라도 남의 에이전트는 못 뺀다(불편하면 '에이전트 숨김'으로 스스로 가린다).
--   회사 에이전트(조직 서비스 계정이 소유한 상주 에이전트 — msgr_crew_is_company)는 사람 주인이 없어 종전처럼 방장이 뺀다.
--   주인이 방을 나가면 그 주인의 에이전트도 빠진다 — 규칙 14(20260918130000 트리거) 그대로, 이 파일은 바꾸지 않는다.
-- 막는 길 셋: ① 참여 행 직접 삭제(RLS) ② msgr_crew_leave_channel RPC ③ 공개 채널의 '내보내기' = 제외 목록(excluded_crew_ids)에 넣기.
-- ②는 방 관리자에게는 거절 대신 'owner_only'(아무것도 안 함)를 돌려준다 — 옛 앱의 사람 내보내기 순서(에이전트 RPC → 사람 행 삭제)가 멈추지 않게.

create or replace function public.msgr_crew_removable(ch uuid, crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_crews cr where cr.id = crew and cr.owner_user_id = auth.uid())
        or (coalesce(public.msgr_crew_is_company(crew), false) and coalesce(public.msgr_can_manage_channel(ch), false))
$$;
revoke all on function public.msgr_crew_removable(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_removable(uuid, uuid) to authenticated;

-- ① 직접 삭제 — 사람 행은 종전대로(나 자신 또는 방 관리자), 에이전트 행은 주인만(회사 에이전트는 방 관리자)
drop policy if exists msgr_channel_members_delete on public.msgr_channel_members;
create policy msgr_channel_members_delete on public.msgr_channel_members for delete to authenticated
  using ((member_kind = 'user' and (member_id = (select auth.uid()) or public.msgr_can_manage_channel(channel_id)))
      or (member_kind = 'crew' and public.msgr_crew_removable(channel_id, member_id)));

-- ② RPC — 20260918130000 정의 그대로, 권한 판정만 msgr_crew_removable로
create or replace function public.msgr_crew_leave_channel(ch uuid, crew uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; by_owner boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch;
  select * into cr from public.msgr_crews where id = crew;
  if c.id is null or cr.id is null then raise exception 'msgr_bad_member' using errcode = '22023'; end if;
  by_owner := cr.owner_user_id = me;
  if not public.msgr_crew_removable(ch, crew) then
    -- 방 관리자가 남의 에이전트를 빼려 하면 아무것도 하지 않고 'owner_only'를 돌려준다(예외 아님, 분리 검수 HIGH 2026-10-02).
    -- 이미 나간 옛 앱은 사람을 내보낼 때 그 사람의 에이전트부터 이 함수로 빼고, 오류가 나면 사람 행 삭제까지 가지 못했다.
    -- 사람 행이 지워지면 규칙 14 트리거(msgr_crews_follow_owner_out)가 그 사람의 에이전트를 같이 뺀다 — 에이전트만 단독으로 빼는 길은 여전히 없다.
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
  return 'removed';
end $$;
revoke all on function public.msgr_crew_leave_channel(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_leave_channel(uuid, uuid) to authenticated;

-- ③ 공개 채널 '내보내기'(제외 목록) — 새로 넣는 에이전트마다 같은 판정. 목록에서 빼기(되돌리기)는 막지 않는다.
-- auth.uid()가 없는 서버 작업(마이그레이션·정리 잡)은 그대로 통과한다.
create or replace function public.msgr_channel_exclude_crew_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare x uuid;
begin
  if auth.uid() is null then return new; end if;
  for x in select unnest(coalesce(new.excluded_crew_ids, '{}'::uuid[])) except select unnest(coalesce(old.excluded_crew_ids, '{}'::uuid[])) loop
    if not public.msgr_crew_removable(new.id, x) then raise exception 'msgr_crew_remove_owner_only' using errcode = '42501'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.msgr_channel_exclude_crew_guard() from public, anon, authenticated;
drop trigger if exists msgr_channel_exclude_crew_guard on public.msgr_channels;
create trigger msgr_channel_exclude_crew_guard before update of excluded_crew_ids on public.msgr_channels
  for each row when (old.excluded_crew_ids is distinct from new.excluded_crew_ids) execute function public.msgr_channel_exclude_crew_guard();

notify pgrst, 'reload schema';
