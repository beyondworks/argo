-- 폰 채널 탭 그룹(유건 확정 2026-10-02): '즐겨찾기 · 채널 · <그룹들…>' 메뉴의 사용자 그룹.
--  - 그룹은 나만 보인다(내 기기끼리 맞춰짐) — 행은 전부 user_id 본인 것만 읽고 쓴다.
--  - 조직 공간마다 따로 — 그룹은 org_id를 가지고, 연결은 그 조직의 채널(대화방 dm 제외)만.
--  - 채널 하나는 그룹 하나에만 — 연결의 기본 키가 (user_id, channel_id). 옮기면 같은 행의 group_id만 바뀐다.
--  - 그룹을 지우면 연결만 사라지고(cascade) 채널은 그대로 — 앱에서는 '채널' 메뉴로 돌아간다.
-- DB 위생: 사용자가 만들고 지우는 설정값이라 쌓이기만 하지 않는다(그룹 상한 50/조직). 앱은 폰 조직 공간을 열 때·앞으로 올 때 한 번 읽고,
-- 바꿀 때만 쓴다(폴링·방송 없음).

create table public.msgr_channel_groups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 30 and name !~ '[\r\n]'),
  pos integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index msgr_channel_groups_name on public.msgr_channel_groups (user_id, org_id, lower(name));
create index msgr_channel_groups_org on public.msgr_channel_groups (org_id);

create table public.msgr_channel_group_links (
  user_id uuid not null references auth.users (id) on delete cascade,
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  group_id uuid not null references public.msgr_channel_groups (id) on delete cascade,
  primary key (user_id, channel_id)
);
create index msgr_channel_group_links_group on public.msgr_channel_group_links (group_id);
create index msgr_channel_group_links_channel on public.msgr_channel_group_links (channel_id);

alter table public.msgr_channel_groups enable row level security;
alter table public.msgr_channel_group_links enable row level security;
revoke all on public.msgr_channel_groups, public.msgr_channel_group_links from anon, authenticated;
grant select, insert, update, delete on public.msgr_channel_groups, public.msgr_channel_group_links to authenticated;
grant all on public.msgr_channel_groups, public.msgr_channel_group_links to service_role;

-- 그룹: 본인 행만. 만들기·고치기는 지금 속한 조직에서만. 조직당 50개 상한은 아래 트리거(정책 안에서 같은 표를 세면 정책 재귀 오류).
create policy msgr_channel_groups_select on public.msgr_channel_groups for select to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_channel_groups_delete on public.msgr_channel_groups for delete to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_channel_groups_insert on public.msgr_channel_groups for insert to authenticated
  with check (user_id = (select auth.uid()) and public.msgr_is_member(org_id));
create policy msgr_channel_groups_update on public.msgr_channel_groups for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.msgr_is_member(org_id));

-- 소속·주인·만든 때는 바꿀 수 없다(검수 L-1) — RLS with check는 새 값만 본다. 두 조직에 속한 사람이 org_id를 바꾸면
-- 그룹이 다른 조직으로 넘어가고 옛 조직 채널의 연결이 그 아래 남았다. 옛 값을 보는 트리거로 잠근다(저장소 공통 msgr_lock_cols).
create trigger msgr_lock_channel_groups before update on public.msgr_channel_groups
  for each row execute function public.msgr_lock_cols('user_id', 'org_id', 'created_at');

-- 연결: 본인 행만. 넣거나 옮기는 곳은 내 그룹이고, 채널은 그 그룹과 같은 조직의 채널(dm 아님)이며 내가 볼 수 있는 것.
-- (msgr_channels 조회는 호출자 RLS를 거친다 — 볼 수 없는 채널은 없는 것과 같다)
create policy msgr_channel_group_links_select on public.msgr_channel_group_links for select to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_channel_group_links_delete on public.msgr_channel_group_links for delete to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_channel_group_links_insert on public.msgr_channel_group_links for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.msgr_channel_groups g join public.msgr_channels c on c.org_id = g.org_id
    where g.id = msgr_channel_group_links.group_id and g.user_id = (select auth.uid())
      and c.id = msgr_channel_group_links.channel_id and c.kind <> 'dm'));
create policy msgr_channel_group_links_update on public.msgr_channel_group_links for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (
    select 1 from public.msgr_channel_groups g join public.msgr_channels c on c.org_id = g.org_id
    where g.id = msgr_channel_group_links.group_id and g.user_id = (select auth.uid())
      and c.id = msgr_channel_group_links.channel_id and c.kind <> 'dm'));

create function public.msgr_channel_groups_cap() returns trigger
  language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (select count(*) from public.msgr_channel_groups g where g.user_id = new.user_id and g.org_id = new.org_id) >= 50 then
    raise exception 'msgr_group_limit' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger msgr_channel_groups_cap before insert on public.msgr_channel_groups
  for each row execute function public.msgr_channel_groups_cap();

notify pgrst, 'reload schema';
