-- 개인 공간 그룹 대화(유건 2026-09-17: "개인 쪽에는 그룹을 맺는 기능이 없네?").
--   · 친구 여러 명과 조직 밖 대화방 하나. 1:1(personal_pair 방)은 그대로 두고, 그룹은 짝 키가 없는 org 없는 dm이다.
--   · msgr_dm_shape는 짝 키가 있는 방만 정원을 본다 → 그룹 방은 트리거가 막지 않는다. 사람을 넣는 길은 이 definer RPC뿐이다(멤버 insert 정책이 dm 사람 행을 막는다).

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
  perform pg_advisory_xact_lock(hashtext('msgr_dm_group:' || array_to_string(everyone, ','))); -- 같은 구성을 두 기기가 동시에 만들 때 한 방만
  -- 같은 사람 구성의 살아 있는 그룹이 있으면 그 방(만들 때마다 같은 방이 늘지 않게 — 조직 그룹 대화와 같은 규칙)
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

-- 목록 — 그룹 방은 상대가 여럿이다. 종전 열(channel_id·other_user_id·last_at·last_body)은 그대로 두고 구성원·이름을 더한다(옛 앱은 새 열을 무시한다).
-- 친구가 아닌 구성원(친구의 친구)도 이름이 보이게 프로필 이름을 함께 싣는다.
drop function if exists public.msgr_dm_personal_list();
create function public.msgr_dm_personal_list() returns table (channel_id uuid, other_user_id uuid, last_at timestamptz, last_body text, name text, members jsonb)
  language sql stable security definer set search_path = public, pg_temp as $$
    select c.id,
           (select m.member_id from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid() limit 1),
           (select max(x.created_at) from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null),
           (select x.body from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1),
           c.name,
           (select coalesce(jsonb_agg(jsonb_build_object('id', m.member_id, 'name', p.display_name) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m left join public.msgr_profiles p on p.user_id = m.member_id
             where m.channel_id = c.id and m.member_kind = 'user')
      from public.msgr_channels c
     where c.org_id is null and c.kind = 'dm' and c.archived_at is null
       and exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by 3 desc nulls last
$$;
revoke all on function public.msgr_dm_personal_list() from public;
grant execute on function public.msgr_dm_personal_list() to authenticated;

notify pgrst, 'reload schema';
