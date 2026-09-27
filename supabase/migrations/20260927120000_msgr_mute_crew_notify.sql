-- 검수 M4(2026-09-27): 숨긴 크루·봇의 글은 차단한 사람의 글과 같은 자리에서 빠져야 한다 — 안 읽음 수(채널별·공간별·
-- 폰 배지)와 푸시. 대화·인용·알림함·검색은 클라이언트가 mutedCrewIds로 이미 가린다(App.jsx). 각 함수의 최신 정의
-- (20260921170000·20260921150000) 본문에 크루 뮤트 조건 한 줄씩만 더한다.
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
       and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = (select auth.uid()) and b.blocked_crew = m.crew_id))
  where (c.org_id = org or (org is null and c.org_id is null)) and c.archived_at is null and public.msgr_can_read_channel(c.id)
  group by c.id
$fn$;
grant execute on function public.msgr_unread(uuid) to authenticated;

create or replace function public.msgr_unread_totals()
returns table (org_id uuid, n int, mention int)
language sql stable security invoker set search_path = public as $fn$
  with per as (
    select c.id, c.org_id,
           least(99, count(m.id))::int as n,
           least(99, count(m.id) filter (where m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', (select auth.uid())::text))))::int as mention
      from public.msgr_channels c
      left join public.msgr_reads r on r.channel_id = c.id and r.user_id = (select auth.uid())
      join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
           and (m.author_user_id is null or m.author_user_id <> (select auth.uid()))
           and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = (select auth.uid()) and b.blocked = m.author_user_id))
           and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = (select auth.uid()) and b.blocked_crew = m.crew_id))
     where c.archived_at is null and public.msgr_can_read_channel(c.id)
       and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = c.id and p.user_id = (select auth.uid()) and p.muted)
     group by c.id, c.org_id
  )
  select per.org_id, sum(per.n)::int, sum(per.mention)::int from per group by per.org_id
$fn$;
revoke all on function public.msgr_unread_totals() from public, anon;
grant execute on function public.msgr_unread_totals() to authenticated;

create or replace function public.msgr_push_unread_total(uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(n), 0)::int from (
    select least(99, count(m.id)) as n
    from public.msgr_channels c
    left join public.msgr_reads r on r.channel_id = c.id and r.user_id = uid
    join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null and m.kind = 'text'
         and (m.author_user_id is null or m.author_user_id <> uid)
         and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = uid and b.blocked = m.author_user_id))
         and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = uid and b.blocked_crew = m.crew_id))
         and (c.kind = 'dm'
              or m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', uid::text))
              or exists (select 1 from public.msgr_messages p where p.id = m.reply_to and p.author_user_id = uid)
              or (m.author_kind = 'crew' and exists (select 1 from public.msgr_messages p2 where p2.id = m.thread_root and p2.author_user_id = uid)))
    where c.archived_at is null and (
      (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
      or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    group by c.id
  ) s;
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;

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
    and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = s.u and b.blocked_crew = m.crew_id))
$$;
