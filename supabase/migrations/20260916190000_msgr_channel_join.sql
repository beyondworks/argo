-- 조직에 들어왔다고 모든 채널이 저절로 열리지 않는다(유건 2026-09-16, 슬랙식).
--   · 사이드바·알림·안 읽음은 **참여한 채널**만. 공개 채널은 "찾아보기"에서 스스로 들어간다.
--   · 열람 자체는 공개 채널이면 조직원에게 열려 있다(슬랙과 같다) — 다만 들어가기 전에는 목록에도 알림에도 없다.
--   · 기존 사용자가 쓰던 채널을 잃지 않게, 글을 쓴 적 있는 사람과 관리자를 참여 상태로 옮긴다(아래 백필).

-- ── 1. 공개 채널 참여 — 조직원이 스스로 들어간다(초대 없이도, 대신 본인이 눌러야 한다) ──
create or replace function public.msgr_join_channel(ch uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch;
  if c.id is null then return false; end if;
  if c.kind <> 'public' then raise exception 'msgr_public_only' using errcode = '42501'; end if; -- 비공개·1:1은 초대로만
  if c.org_id is null or not coalesce(public.msgr_is_member(c.org_id), false) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if c.archived_at is not null or coalesce(public.msgr_org_locked(c.org_id), false) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if me = any (c.excluded_user_ids) then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 제외된 사람은 못 들어온다
  insert into public.msgr_channel_members (channel_id, member_kind, member_id)
    select ch, 'user', me
     where not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = me);
  return true;
end $$;
revoke all on function public.msgr_join_channel(uuid) from public, anon;
grant execute on function public.msgr_join_channel(uuid) to authenticated;

-- 찾아보기 목록 — 이 조직의 공개 채널 중 아직 안 들어간 것(제외된 채널은 빼고). 인원수는 참여자 기준.
create or replace function public.msgr_browse_channels(org uuid)
returns table (id uuid, name text, topic text, members int, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select c.id, c.name, c.topic,
           (select count(*)::int from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user'),
           c.created_at
      from public.msgr_channels c
     where c.org_id = org and c.kind = 'public' and c.archived_at is null
       and coalesce(public.msgr_is_member(org), false)
       and not (auth.uid() = any (c.excluded_user_ids))
       and not exists (select 1 from public.msgr_channel_members m
                        where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by c.created_at
$$;
revoke all on function public.msgr_browse_channels(uuid) from public, anon;
grant execute on function public.msgr_browse_channels(uuid) to authenticated;

-- ── 2. 알림 — 공개 채널도 참여자에게만 간다(조직원 전원 → 참여자) ──
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
$$;

-- ── 3. 기존 사용자 이관(백필) — 쓰던 채널을 잃지 않게 ──
-- 대상: 그 공개 채널에 글을 쓴 적 있는 사람 + 그 조직의 owner·admin. 그 밖의 조직원은 "찾아보기"에서 들어간다.
insert into public.msgr_channel_members (channel_id, member_kind, member_id)
select distinct c.id, 'user', u.user_id
  from public.msgr_channels c
  join lateral (
    select distinct msg.author_user_id as user_id from public.msgr_messages msg
     where msg.channel_id = c.id and msg.author_user_id is not null
    union
    select om.user_id from public.msgr_org_members om
     where om.org_id = c.org_id and om.removed_at is null and om.role in ('owner', 'admin')
  ) u on true
 where c.kind = 'public' and c.archived_at is null and c.org_id is not null
   and not (u.user_id = any (c.excluded_user_ids))
   and not exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = u.user_id);
