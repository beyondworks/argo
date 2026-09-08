-- 프로필·친구(유건 지시 2026-09-09 "이메일 계정으로 유저 찾아서 친구 추가 — 디스코드·슬랙·텔레그램 참고").
--  · msgr_profiles: 계정 단위 아이디(handle)·표시 이름·검색 허용 스위치. 조직 멤버 이름(msgr_org_members.display_name)의 기본값이 된다.
--  · 찾기 = RPC msgr_find_user(q): 이메일은 **정확히 일치**하고 그 사람이 이메일 검색을 허용했을 때만, 아이디는 앞부분 일치 + 아이디 검색 허용. 이메일은 결과에 싣지 않는다.
--  · 친구 = msgr_friends(a<b 정규화, status pending|accepted|blocked, requested_by). 요청·수락·거절·차단 RPC. 친구가 되면 알림함(v1)이 요청·수락을 보인다.
--  · 친구 DM은 같은 조직이 있을 때 그 조직 DM으로(조직 밖 대화 공간은 v2). 없으면 "조직에 초대"로 잇는다.
create table if not exists public.msgr_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  handle text unique check (handle is null or handle ~ '^[a-z0-9][a-z0-9_.]{2,23}$'),
  display_name text check (display_name is null or length(display_name) between 1 and 40),
  email_search boolean not null default false,   -- 이메일로 나를 찾을 수 있게
  handle_search boolean not null default true,   -- 아이디로 나를 찾을 수 있게
  accept_requests boolean not null default true, -- 친구 요청 받기
  updated_at timestamptz not null default now()
);
alter table public.msgr_profiles enable row level security;
drop policy if exists msgr_profiles_self on public.msgr_profiles;
create policy msgr_profiles_self on public.msgr_profiles for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.msgr_profiles to authenticated;

create table if not exists public.msgr_friends (
  a uuid not null references auth.users (id) on delete cascade,
  b uuid not null references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'blocked')),
  requested_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  primary key (a, b),
  check (a < b)
);
alter table public.msgr_friends enable row level security;
drop policy if exists msgr_friends_read on public.msgr_friends;
create policy msgr_friends_read on public.msgr_friends for select to authenticated using (a = (select auth.uid()) or b = (select auth.uid())); -- 쓰기는 RPC만
grant select on public.msgr_friends to authenticated;
create index if not exists msgr_friends_b on public.msgr_friends (b);
-- 친구가 되면 서로 프로필을 읽는다(정책은 친구 표 뒤에)
drop policy if exists msgr_profiles_friends_read on public.msgr_profiles;
create policy msgr_profiles_friends_read on public.msgr_profiles for select to authenticated
  using (exists (select 1 from public.msgr_friends f where f.status = 'accepted' and ((f.a = user_id and f.b = (select auth.uid())) or (f.b = user_id and f.a = (select auth.uid())))));

create or replace function public.msgr_friend_pair(x uuid, y uuid) returns uuid[] language sql immutable as $$ select case when x < y then array[x, y] else array[y, x] end $$;

-- 찾기: 이메일 정확 일치(허용한 사람만) 또는 아이디 앞부분(허용한 사람만). 본인·차단 관계는 제외. 최대 10명. 이메일은 돌려주지 않는다.
create or replace function public.msgr_find_user(q text) returns table (user_id uuid, handle text, display_name text, relation text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); needle text := lower(btrim(coalesce(q, '')));
begin
  if me is null then raise exception 'msgr_auth'; end if;
  if length(needle) < 3 then return; end if;
  return query
    select u.id, p.handle, coalesce(p.display_name, split_part(u.email, '@', 1)),
           coalesce((select case when f.status = 'accepted' then 'friend' when f.status = 'pending' and f.requested_by = me then 'sent' when f.status = 'pending' then 'received' else f.status end
                       from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id)), 'none')
      from auth.users u left join public.msgr_profiles p on p.user_id = u.id
     where u.id <> me
       and ((needle like '%@%' and lower(u.email) = needle and coalesce(p.email_search, false))
            or (needle not like '%@%' and p.handle is not null and p.handle like needle || '%' and coalesce(p.handle_search, true)))
       and not exists (select 1 from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id) and f.status = 'blocked')
     order by p.handle nulls last limit 10;
end $$;
revoke all on function public.msgr_find_user(text) from public;
grant execute on function public.msgr_find_user(text) to authenticated;

create or replace function public.msgr_friend_request(target uuid) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[]; cur public.msgr_friends;
begin
  if me is null then raise exception 'msgr_auth'; end if;
  if target is null or target = me then raise exception 'msgr_friend_self'; end if;
  if not exists (select 1 from auth.users where id = target) then raise exception 'msgr_friend_no_user'; end if;
  if exists (select 1 from public.msgr_profiles p where p.user_id = target and not p.accept_requests) then raise exception 'msgr_friend_closed'; end if;
  pr := public.msgr_friend_pair(me, target);
  select * into cur from public.msgr_friends where a = pr[1] and b = pr[2];
  if cur.a is null then insert into public.msgr_friends (a, b, status, requested_by) values (pr[1], pr[2], 'pending', me); return 'sent'; end if;
  if cur.status = 'blocked' then raise exception 'msgr_friend_blocked'; end if;
  if cur.status = 'accepted' then return 'friend'; end if;
  if cur.requested_by = me then return 'sent'; end if;
  update public.msgr_friends set status = 'accepted', decided_at = now() where a = pr[1] and b = pr[2]; return 'friend'; -- 상대가 먼저 보냈으면 요청 = 수락
end $$;
create or replace function public.msgr_friend_decide(other uuid, accept boolean) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[]; cur public.msgr_friends;
begin
  if me is null then raise exception 'msgr_auth'; end if;
  pr := public.msgr_friend_pair(me, other);
  select * into cur from public.msgr_friends where a = pr[1] and b = pr[2];
  if cur.a is null or cur.status <> 'pending' or cur.requested_by = me then raise exception 'msgr_friend_no_request'; end if;
  if accept then update public.msgr_friends set status = 'accepted', decided_at = now() where a = pr[1] and b = pr[2]; return 'friend'; end if;
  delete from public.msgr_friends where a = pr[1] and b = pr[2]; return 'declined';
end $$;
create or replace function public.msgr_friend_remove(other uuid, block boolean default false) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[];
begin
  if me is null then raise exception 'msgr_auth'; end if;
  pr := public.msgr_friend_pair(me, other);
  if block then
    insert into public.msgr_friends (a, b, status, requested_by, decided_at) values (pr[1], pr[2], 'blocked', me, now())
      on conflict (a, b) do update set status = 'blocked', requested_by = me, decided_at = now();
  else
    delete from public.msgr_friends where a = pr[1] and b = pr[2] and status <> 'blocked';
  end if;
end $$;
-- 친구 목록(표시 이름·아이디 포함): 상대 프로필은 friends_read 정책으로도 읽히지만 이름 조립을 한 번에
create or replace function public.msgr_my_friends() returns table (user_id uuid, handle text, display_name text, status text, requested_by uuid, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when f.a = auth.uid() then f.b else f.a end, p.handle, coalesce(p.display_name, split_part(u.email, '@', 1)), f.status, f.requested_by, f.created_at
      from public.msgr_friends f
      join auth.users u on u.id = case when f.a = auth.uid() then f.b else f.a end
      left join public.msgr_profiles p on p.user_id = u.id
     where (f.a = auth.uid() or f.b = auth.uid()) and f.status <> 'blocked'
     order by f.status, f.created_at desc
$$;
revoke all on function public.msgr_friend_request(uuid) from public; grant execute on function public.msgr_friend_request(uuid) to authenticated;
revoke all on function public.msgr_friend_decide(uuid, boolean) from public; grant execute on function public.msgr_friend_decide(uuid, boolean) to authenticated;
revoke all on function public.msgr_friend_remove(uuid, boolean) from public; grant execute on function public.msgr_friend_remove(uuid, boolean) to authenticated;
revoke all on function public.msgr_my_friends() from public; grant execute on function public.msgr_my_friends() to authenticated;
