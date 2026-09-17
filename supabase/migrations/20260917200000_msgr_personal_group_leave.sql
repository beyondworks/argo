-- 개인 그룹 2차 검수 반영(2026-09-17).
--   HIGH-1 개인 그룹 관리를 만든 사람으로 좁히자(20260917190000) 나가기가 깨졌다 — msgr_leave_dm이 호출자 권한으로 채널 행을
--          `for update`로 잠그는데, 그 잠금은 update 정책(=관리 권한)을 요구해 구성원에게는 행이 안 보이고 false가 돌아왔다.
--          → 나가기는 자기 판정(security definer). 만든 사람이 나가면 남은 구성원(먼저 들어온 순)에게 관리를 넘긴다 — 아무도 정리할 수 없는 방이 남지 않게.
--   MEDIUM-2 같은 구성의 그룹이 이미 있으면 차단 검사보다 먼저 그 방을 돌려준다(방은 쓸 수 있는데 다시 열기가 실패하던 것).

create or replace function public.msgr_dm_personal_group(targets uuid[], title text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); ts uuid[]; x uuid; pr uuid[]; ch uuid; everyone uuid[];
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct u), '{}') into ts from unnest(coalesce(targets, '{}')) u where u is not null and u <> me;
  if cardinality(ts) < 2 then raise exception 'msgr_bad_target' using errcode = '22023'; end if; -- 한 명이면 msgr_dm_personal(한 쌍 한 방)
  if cardinality(ts) > 49 then raise exception 'msgr_group_too_big' using errcode = '22023'; end if;
  foreach x in array ts loop -- 수락된 친구만 — 친구가 아닌 사람을 방에 끌어넣지 못한다
    pr := public.msgr_friend_pair(me, x);
    if not exists (select 1 from public.msgr_friends f where f.a = pr[1] and f.b = pr[2] and f.status = 'accepted') then
      raise exception 'msgr_not_friend' using errcode = '42501';
    end if;
  end loop;
  select array_agg(u order by u) into everyone from unnest(ts || me) u;
  perform pg_advisory_xact_lock(hashtext('msgr_dm_group:' || array_to_string(everyone, ',')));
  select c.id into ch from public.msgr_channels c
   where c.org_id is null and c.kind = 'dm' and c.personal_pair is null and c.archived_at is null
     and (select array_agg(m.member_id order by m.member_id) from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user') = everyone
   limit 1;
  if ch is not null then return ch; end if;
  -- 구성원끼리 차단한 관계가 있으면 한 방에 강제로 넣지 않는다. 이미 있는 같은 구성의 방은 위에서 돌려준 뒤라 다시 열기는 막지 않는다(2차 검수 MEDIUM-2)
  if exists (select 1 from public.msgr_friends f where f.status = 'blocked' and f.a = any (everyone) and f.b = any (everyone)) then
    raise exception 'msgr_group_blocked_pair' using errcode = '42501';
  end if;
  insert into public.msgr_channels (org_id, kind, name, created_by)
    values (null, 'dm', left('dm:' || coalesce(nullif(btrim(title), ''), 'group'), 80), me) returning id into ch;
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by)
    select ch, 'user', u, me from unnest(everyone) u;
  return ch;
end $$;
revoke all on function public.msgr_dm_personal_group(uuid[], text) from public, anon;
grant execute on function public.msgr_dm_personal_group(uuid[], text) to authenticated;

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

notify pgrst, 'reload schema';
