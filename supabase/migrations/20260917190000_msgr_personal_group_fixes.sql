-- 개인 그룹 대화 분리 검수 반영(2026-09-17). 20260917120000_msgr_personal_group.sql은 라이브에 적용됐으므로 고치지 않고 덮어쓴다.
--   HIGH-1  차단한 두 사람이 한 그룹에 들어가면 쓰기 판정이 "방 안 누구든 차단 관계면 거부"라 그 둘은 그룹 전체에 못 썼다.
--           → 만들 때 구성원끼리 차단 관계가 있으면 거부, 쓰기 차단은 1:1(짝 방)에만 적용한다(카톡 그룹처럼 그룹은 계속 쓴다).
--   MEDIUM-4 옛 앱(구성원 열을 모름)은 그룹을 임의의 한 사람과의 1:1로 보였다 → 목록은 요청한 앱만 그룹을 받는다(include_groups).
--   MEDIUM-5 개인 그룹은 친구의 친구도 들어오는데 아무 구성원이나 모두의 기록을 지우거나 끝낼 수 있었다 → 관리(보관·삭제)는 만든 사람만.
--   MEDIUM-1 한 명이 나간 그룹이 1:1과 똑같이 보였다 → 목록이 is_group을 싣는다. other_user_id는 추가된 순서로 고정(매번 바뀌던 limit 1).

-- ── 1. 그룹 만들기 — 구성원끼리 차단 관계가 있으면 거부 ─────────────────────
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
  -- 구성원끼리 차단한 관계가 있으면 한 방에 강제로 넣지 않는다(차단한 사람을 차단 상대와 묶는 일)
  if exists (select 1 from public.msgr_friends f where f.status = 'blocked' and f.a = any (everyone) and f.b = any (everyone)) then
    raise exception 'msgr_group_blocked_pair' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm_group:' || array_to_string(everyone, ',')));
  select c.id into ch from public.msgr_channels c
   where c.org_id is null and c.kind = 'dm' and c.personal_pair is null and c.archived_at is null
     and (select array_agg(m.member_id order by m.member_id) from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user') = everyone
   limit 1;
  if ch is not null then return ch; end if;
  insert into public.msgr_channels (org_id, kind, name, created_by)
    values (null, 'dm', left('dm:' || coalesce(nullif(btrim(title), ''), 'group'), 80), me) returning id into ch;
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by)
    select ch, 'user', u, me from unnest(everyone) u;
  return ch;
end $$;
revoke all on function public.msgr_dm_personal_group(uuid[], text) from public, anon;
grant execute on function public.msgr_dm_personal_group(uuid[], text) to authenticated;

-- ── 2. 쓰기 — 차단은 개인 1:1(짝 방)에만 ───────────────────────────────────
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

-- ── 3. 관리 — 개인 그룹은 만든 사람만(보관·삭제·설정). 나가기는 msgr_leave_dm으로 각자 ───────
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids)
                          or (c.kind <> 'dm' and c.org_id is not null and coalesce(public.msgr_is_admin(c.org_id), false))
                          or (c.kind = 'dm' and not (c.org_id is null and c.personal_pair is null)
                              and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())))
                     and (c.org_id is null or coalesce(public.msgr_is_member(c.org_id), false)))
$$;

-- ── 4. 목록 — 그룹은 요청한 앱에만, is_group 표시, 상대는 추가 순서로 고정 ──────────
drop function if exists public.msgr_dm_personal_list();
drop function if exists public.msgr_dm_personal_list(boolean);
create function public.msgr_dm_personal_list(include_groups boolean default false)
  returns table (channel_id uuid, other_user_id uuid, last_at timestamptz, last_body text, name text, members jsonb, is_group boolean, created_by uuid)
  language sql stable security definer set search_path = public, pg_temp as $$
    select c.id,
           (select m.member_id from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid() order by m.added_at, m.member_id limit 1),
           (select max(x.created_at) from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null),
           (select x.body from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1),
           c.name,
           (select coalesce(jsonb_agg(jsonb_build_object('id', m.member_id, 'name', p.display_name) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m left join public.msgr_profiles p on p.user_id = m.member_id
             where m.channel_id = c.id and m.member_kind = 'user'),
           c.personal_pair is null,
           c.created_by
      from public.msgr_channels c
     where c.org_id is null and c.kind = 'dm' and c.archived_at is null
       and (include_groups or c.personal_pair is not null) -- 옛 앱(인자 없음)은 1:1만 — 그룹을 가짜 1:1로 그리지 않게
       and exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by 3 desc nulls last
$$;
revoke all on function public.msgr_dm_personal_list(boolean) from public;
grant execute on function public.msgr_dm_personal_list(boolean) to authenticated;

notify pgrst, 'reload schema';
