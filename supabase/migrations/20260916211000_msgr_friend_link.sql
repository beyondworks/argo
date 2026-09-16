-- 친구 추가를 링크 하나로(유건 2026-09-16: "초대코드 방식 더 간단해야함 — 링크 공유 > 승인").
--   · 조직 초대와 **완전히 다른 문**이다. 이 링크로는 조직에 들어오지 않는다(개인과 조직 분리).
--   · 링크를 만든 쪽은 그 자체로 동의한 것이고, 받은 쪽이 수락하면 그 자리에서 친구가 된다(카톡 링크와 같은 모양).
--   · 코드는 24바이트 hex 48자 — 조직 초대 코드와 형식이 같아 앱의 붙여넣기 파서를 그대로 쓴다. 표가 달라 섞이지 않는다.
create table if not exists public.msgr_friend_links (
  code text primary key default encode(gen_random_bytes(24), 'hex'),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days', -- 굴러다니는 링크가 영원히 살지 않게
  revoked_at timestamptz
);
create index if not exists msgr_friend_links_owner on public.msgr_friend_links (owner_user_id);
alter table public.msgr_friend_links enable row level security;
-- 표에는 권한을 주지 않는다 — 발급·수락·회수는 아래 RPC(definer)로만. 남의 링크를 읽어 친구가 되는 길을 만들지 않는다.
drop policy if exists msgr_friend_links_self on public.msgr_friend_links;
create policy msgr_friend_links_self on public.msgr_friend_links for all to authenticated
  using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));

/** 내 친구 링크 — 살아 있는 것이 있으면 그것을 주고, 없으면 만든다(공유물이 매번 바뀌면 사람이 헷갈린다). */
create or replace function public.msgr_friend_link_mine() returns table (code text, expires_at timestamptz)
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  return query
    with live as (
      select l.code, l.expires_at from public.msgr_friend_links l
       where l.owner_user_id = me and l.revoked_at is null and l.expires_at > now()
       order by l.created_at desc limit 1
    ), made as (
      insert into public.msgr_friend_links (owner_user_id)
      select me where not exists (select 1 from live)
      returning msgr_friend_links.code, msgr_friend_links.expires_at
    )
    select * from live union all select * from made;
end $$;
revoke all on function public.msgr_friend_link_mine() from public, anon;
grant execute on function public.msgr_friend_link_mine() to authenticated;

/** 링크 회수 — 공유물이 새면 이걸로 끊는다. 다음에 만들면 새 코드가 나온다. */
create or replace function public.msgr_friend_link_revoke() returns void
  language sql security definer set search_path = public, pg_temp as $$
    update public.msgr_friend_links set revoked_at = now()
     where owner_user_id = auth.uid() and revoked_at is null
$$;
revoke all on function public.msgr_friend_link_revoke() from public, anon;
grant execute on function public.msgr_friend_link_revoke() to authenticated;

/** 링크 수락 — 그 자리에서 친구가 된다. 반환: 'friend' | 'self' | 'already'. 조직과는 무관하다. */
create or replace function public.msgr_friend_link_accept(code text) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); owner_id uuid; pr uuid[]; cur public.msgr_friends; want text := code; -- 인자 이름(API)과 열 이름이 같아 안에서 갈라 쓴다
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select l.owner_user_id into owner_id from public.msgr_friend_links l
   where l.code = want and l.revoked_at is null and l.expires_at > now();
  if owner_id is null then raise exception 'msgr_link_invalid' using errcode = '22023'; end if; -- 없는·만료된·회수된 링크
  if owner_id = me then return 'self'; end if;
  pr := public.msgr_friend_pair(me, owner_id);
  select * into cur from public.msgr_friends f where f.a = pr[1] and f.b = pr[2];
  if cur.a is not null and cur.status = 'blocked' then raise exception 'msgr_friend_blocked' using errcode = '42501'; end if;
  if cur.a is not null and cur.status = 'accepted' then return 'already'; end if;
  -- 링크를 만든 쪽은 이미 동의했고, 여는 쪽이 수락했다 — 양쪽 동의가 모였으니 바로 친구다(요청 대기를 두지 않는다).
  insert into public.msgr_friends (a, b, status, requested_by, decided_at) values (pr[1], pr[2], 'accepted', owner_id, now())
    on conflict (a, b) do update set status = 'accepted', decided_at = now();
  return 'friend';
end $$;
revoke all on function public.msgr_friend_link_accept(text) from public, anon;
grant execute on function public.msgr_friend_link_accept(text) to authenticated;
