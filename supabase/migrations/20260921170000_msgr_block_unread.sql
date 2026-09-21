-- 차단한 사람의 글은 안 읽음 수에서 뺀다(2026-09-21, #682 검수 LOW) — 채널별(msgr_unread)·공간별(msgr_unread_totals)·폰 배지(msgr_push_unread_total).
-- 앞의 둘은 호출자 권한(security invoker)이라 차단 표를 못 읽는다 → '내가 차단했는가'만 답하는 도우미를 둔다(남의 차단은 알 수 없다).
-- 세 함수 모두 종전 정의(20260916150000·20260918184500·20260915120000) 그대로에 조건 한 줄만 더했다.
create or replace function public.msgr_i_blocked(author uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_user_blocks where blocker = auth.uid() and blocked = author)
$$;
revoke all on function public.msgr_i_blocked(uuid) from public, anon;
grant execute on function public.msgr_i_blocked(uuid) to authenticated;

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
       and not (m.author_kind = 'user' and public.msgr_i_blocked(m.author_user_id))
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
           and not (m.author_kind = 'user' and public.msgr_i_blocked(m.author_user_id))
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
         and (c.kind = 'dm' or m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', uid::text)))
    where c.archived_at is null and (
      (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
      or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    group by c.id
  ) s;
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;
