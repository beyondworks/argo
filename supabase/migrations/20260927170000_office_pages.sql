-- 아르고 오피스 페이지·공유(P1, 2026-09-27) — 유건 확정 규칙(2026-09-26):
--   · 공간: 내 공간(만든 사람) / 조직 공간(메신저 조직 = 오피스 조직). 조직 소유자·관리자 = 전체 권한, 멤버 = 기본 편집,
--     게스트 = 공유받은 것만, 퇴사(removed_at)·조직 밖 사람 = 없음(공유가 있어도).
--   · 공유: 페이지마다 사람별 역할(보기·편집·전체) + 일반 접근(초대된 사람만·조직 보기·조직 편집) + 링크 게시. 하위 페이지는 상속.
--   · 비공개(조직 위키, 관리자): 관리자와 지정한 사람만, 하위까지. 비공개 블록은 따로 저장해 권한 없는 사람은 데이터를 받지 못한다.
--   · 복제는 공유·비공개·비공개 블록을 따라가지 않는다. 버전 90일, 휴지통 30일 뒤 정리.
-- 쓰기는 전부 아래 함수로만(권한 확인 뒤) — 표에 직접 쓰는 정책은 두지 않는다.
-- ponytail: 권한은 조상 경로를 매번 거슬러 올라가 판정한다(깊이 상한 32). 트리가 크게 깊어져 느려지면 경로 캐시 열을 둔다.

create table if not exists public.office_pages (
  id uuid primary key,                                    -- 브라우저가 만든 id(바로 열고 쓰기 위해)
  space_kind text not null check (space_kind in ('me', 'org')),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.msgr_orgs(id) on delete cascade,
  parent_id uuid references public.office_pages(id) on delete cascade,
  position text not null default 'a0' check (length(position) between 1 and 64),
  title text not null default '' check (length(title) <= 500),
  icon text check (icon is null or length(icon) <= 32),
  content jsonb not null default '{}'::jsonb check (octet_length(content::text) <= 1048576),
  general text not null default 'invited' check (general in ('invited', 'org_view', 'org_edit')),
  restricted boolean not null default false,
  is_template boolean not null default false,
  version integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references auth.users(id) on delete set null,
  check ((space_kind = 'me' and org_id is null) or (space_kind = 'org' and org_id is not null))
);
create index if not exists office_pages_parent on public.office_pages (parent_id);
create index if not exists office_pages_org on public.office_pages (org_id) where org_id is not null;
create index if not exists office_pages_owner_me on public.office_pages (owner_user_id) where space_kind = 'me';
create index if not exists office_pages_archived on public.office_pages (archived_at) where archived_at is not null;

create table if not exists public.office_shares (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.office_pages(id) on delete cascade,
  principal_kind text not null check (principal_kind in ('user', 'link')),
  user_id uuid references auth.users(id) on delete cascade,
  role text not null default 'view' check (role in ('view', 'edit', 'full')),
  link_token text unique,
  published boolean not null default false,
  allow_index boolean not null default false,            -- 검색 엔진 노출(기본 끔)
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((principal_kind = 'user' and user_id is not null and link_token is null) or (principal_kind = 'link' and user_id is null and link_token is not null))
);
create unique index if not exists office_shares_user on public.office_shares (page_id, user_id) where principal_kind = 'user';
create unique index if not exists office_shares_link on public.office_shares (page_id) where principal_kind = 'link';

create table if not exists public.office_page_versions (
  page_id uuid not null references public.office_pages(id) on delete cascade,
  version integer not null,
  title text not null default '',
  content jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (page_id, version)
);
create index if not exists office_page_versions_created on public.office_page_versions (created_at);

create table if not exists public.office_private_blocks (
  page_id uuid not null references public.office_pages(id) on delete cascade,
  block_id text not null check (block_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  content jsonb not null default '{}'::jsonb check (octet_length(content::text) <= 262144),
  allowed uuid[] not null default '{}',
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (page_id, block_id)
);

-- ── 권한 판정: 'none' | 'view' | 'edit' | 'full' ──
create or replace function public.office_page_access(p_page uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  head public.office_pages;
  node public.office_pages;
  cur uuid := p_page;
  depth int := 0;
  hidden boolean := false;       -- 자신이나 조상이 비공개
  archived boolean := false; archived_mine boolean := false;
  shared int := 0; r int; base int := 0; res int; role text;
begin
  if uid is null then return 'none'; end if;
  select * into head from public.office_pages where id = p_page;
  if not found then return 'none'; end if;
  while cur is not null and depth < 32 loop
    select * into node from public.office_pages where id = cur;
    exit when not found;
    hidden := hidden or node.restricted;
    if node.archived_at is not null then archived := true; archived_mine := archived_mine or node.archived_by = uid; end if;
    select coalesce(max(case s.role when 'view' then 1 when 'edit' then 2 when 'full' then 3 end), 0) into r
      from public.office_shares s where s.page_id = cur and s.principal_kind = 'user' and s.user_id = uid;
    shared := greatest(shared, r);
    cur := node.parent_id; depth := depth + 1;
  end loop;
  if head.space_kind = 'me' then
    base := case when head.owner_user_id = uid then 3 else 0 end;
  else
    role := public.msgr_role(head.org_id);           -- 퇴사·삭제된 조직이면 null
    if role is null then return 'none'; end if;      -- 조직 페이지는 구성원(게스트 포함)에게만 — 공유가 있어도
    if role in ('owner', 'admin') then base := 3;
    elsif role = 'guest' or hidden then base := 0;
    else base := case head.general when 'org_edit' then 2 when 'org_view' then 1 else 0 end;
    end if;
  end if;
  res := greatest(base, shared);
  if archived and res < 3 and not archived_mine then return 'none'; end if; -- 휴지통은 지운 사람과 전체 권한자만
  return case res when 3 then 'full' when 2 then 'edit' when 1 then 'view' else 'none' end;
end $$;

/** 자신이나 조상이 비공개인가(관리자 지정 숨김) — 이동·공개 링크·복제가 같은 기준을 쓴다 */
create or replace function public.office_page_hidden(p_page uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  with recursive up as (select id, parent_id, restricted, 0 as d from public.office_pages where id = p_page
                        union all select p.id, p.parent_id, p.restricted, up.d + 1 from public.office_pages p join up on p.id = up.parent_id where up.d < 32)
  select coalesce(bool_or(restricted), false) from up
$$;

alter table public.office_pages enable row level security;
alter table public.office_shares enable row level security;
alter table public.office_page_versions enable row level security;
alter table public.office_private_blocks enable row level security;

drop policy if exists office_pages_read on public.office_pages;
create policy office_pages_read on public.office_pages for select to authenticated using (public.office_page_access(id) <> 'none');
drop policy if exists office_shares_read on public.office_shares;
create policy office_shares_read on public.office_shares for select to authenticated
  using (public.office_page_access(page_id) = 'full' or (principal_kind = 'user' and user_id = auth.uid())); -- 남의 공유·링크 토큰은 전체 권한자만, 내게 온 공유는 나도
drop policy if exists office_page_versions_read on public.office_page_versions;
create policy office_page_versions_read on public.office_page_versions for select to authenticated using (public.office_page_access(page_id) <> 'none');
drop policy if exists office_private_blocks_read on public.office_private_blocks;
create policy office_private_blocks_read on public.office_private_blocks for select to authenticated
  using (public.office_page_access(page_id) = 'full' or (auth.uid() = any(allowed) and public.office_page_access(page_id) <> 'none'));
drop policy if exists office_private_blocks_write on public.office_private_blocks;
create policy office_private_blocks_write on public.office_private_blocks for all to authenticated
  using (public.office_page_access(page_id) = 'full') with check (public.office_page_access(page_id) = 'full');

create or replace function public.office_private_blocks_author() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then new.created_by := case when tg_op = 'UPDATE' then old.created_by else auth.uid() end; end if;
  return new;
end $$;
drop trigger if exists office_private_blocks_author on public.office_private_blocks;
create trigger office_private_blocks_author before insert or update on public.office_private_blocks
  for each row execute function public.office_private_blocks_author();

revoke all on public.office_pages, public.office_shares, public.office_page_versions, public.office_private_blocks from anon;
grant select on public.office_pages, public.office_shares, public.office_page_versions to authenticated;
revoke insert, update, delete on public.office_pages, public.office_shares, public.office_page_versions from authenticated;
grant select, insert, update, delete on public.office_private_blocks to authenticated;

create or replace function public.office_need(p_page uuid, p_min text) returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a text := public.office_page_access(p_page);
begin
  if (case a when 'full' then 3 when 'edit' then 2 when 'view' then 1 else 0 end)
     < (case p_min when 'full' then 3 when 'edit' then 2 else 1 end) then
    raise exception 'office: % access required', p_min using errcode = '42501';
  end if;
end $$;

-- ── 만들기(같은 id 재시도는 한 번만) ──
-- p_template: 템플릿(유건 9/27 — 사본을 템플릿으로, 최상위에만, 조직 것은 관리자만·멤버는 보기만). 인자 수가 바뀌어 옛 6인자 함수는 지운다(PostgREST 모호성).
drop function if exists public.office_page_create(uuid, uuid, uuid, text, text, jsonb);
create or replace function public.office_page_create(p_id uuid, p_org uuid, p_parent uuid, p_position text, p_title text, p_content jsonb, p_template boolean default false) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); par public.office_pages; ex public.office_pages;
begin
  if uid is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into ex from public.office_pages where id = p_id;
  if found then
    if ex.created_by = uid then return p_id; end if;
    raise exception 'office: id taken' using errcode = '23505';
  end if;
  if p_template and p_parent is not null then raise exception 'office: templates live at top level' using errcode = '22023'; end if;
  if p_parent is not null then
    select * into par from public.office_pages where id = p_parent;
    if not found then raise exception 'office: parent missing' using errcode = '23503'; end if;
    perform public.office_need(p_parent, 'edit');
    if par.org_id is distinct from p_org then raise exception 'office: parent in another space' using errcode = '22023'; end if;
  elsif p_org is not null and not public.msgr_is_admin(p_org) then
    raise exception 'office: only admins add top-level wiki pages' using errcode = '42501'; -- 위키 최상위 섹션은 관리자만
  end if;
  insert into public.office_pages (id, space_kind, owner_user_id, org_id, parent_id, position, title, content, general, is_template, created_by, updated_by)
  values (p_id, case when p_org is null then 'me' else 'org' end,
          case when p_org is null then coalesce(par.owner_user_id, uid) else uid end,  -- 공유받아 만든 하위 페이지도 원래 주인의 공간에 속한다
          p_org, p_parent, coalesce(p_position, 'a0'), coalesce(p_title, ''), coalesce(p_content, '{}'::jsonb),
          case when p_org is null then 'invited' when p_template then 'org_view' else coalesce(par.general, 'org_edit') end, coalesce(p_template, false), uid, uid);
  return p_id;
end $$;

-- ── 저장: 버전이 다르면 충돌, 같은 내용이면 쓰기 0, 10분 넘게 쉰 뒤의 첫 저장은 이전 모습을 버전으로 남긴다 ──
create or replace function public.office_page_save(p_id uuid, p_title text, p_content jsonb, p_base_version integer) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare pg public.office_pages;
begin
  perform public.office_need(p_id, 'edit');
  select * into pg from public.office_pages where id = p_id for update;
  if pg.title = coalesce(p_title, '') and pg.content = coalesce(p_content, '{}'::jsonb) then return pg.version; end if;
  if pg.version <> p_base_version then raise exception 'version_conflict' using errcode = 'P0001', detail = pg.version::text; end if;
  if pg.updated_at < now() - interval '10 minutes' then
    insert into public.office_page_versions (page_id, version, title, content, created_by)
      values (pg.id, pg.version, pg.title, pg.content, pg.updated_by) on conflict do nothing;
  end if;
  update public.office_pages set title = coalesce(p_title, ''), content = coalesce(p_content, '{}'::jsonb),
    version = pg.version + 1, updated_by = auth.uid(), updated_at = now() where id = p_id;
  return pg.version + 1;
end $$;

create or replace function public.office_page_restore(p_id uuid, p_version integer) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare pg public.office_pages; v public.office_page_versions;
begin
  perform public.office_need(p_id, 'edit');
  select * into v from public.office_page_versions where page_id = p_id and version = p_version;
  if not found then raise exception 'office: version missing' using errcode = '22023'; end if;
  select * into pg from public.office_pages where id = p_id for update;
  insert into public.office_page_versions (page_id, version, title, content, created_by)   -- 되돌리기 전 모습도 남긴다
    values (pg.id, pg.version, pg.title, pg.content, pg.updated_by) on conflict do nothing;
  update public.office_pages set title = v.title, content = v.content, version = pg.version + 1, updated_by = auth.uid(), updated_at = now() where id = p_id;
  return pg.version + 1;
end $$;

create or replace function public.office_page_move(p_id uuid, p_parent uuid, p_position text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare pg public.office_pages; par public.office_pages;
begin
  perform public.office_need(p_id, 'edit');
  select * into pg from public.office_pages where id = p_id;
  if p_parent is not null then
    perform public.office_need(p_parent, 'edit');
    select * into par from public.office_pages where id = p_parent;
    if par.org_id is distinct from pg.org_id or (pg.space_kind = 'me' and par.owner_user_id <> pg.owner_user_id) then
      raise exception 'office: parent in another space' using errcode = '22023';
    end if;
    if exists (with recursive up as (select id, parent_id from public.office_pages where id = p_parent
                 union all select p.id, p.parent_id from public.office_pages p join up on p.id = up.parent_id)
               select 1 from up where id = p_id) then
      raise exception 'office: cannot move into itself' using errcode = '22023';
    end if;
  elsif pg.org_id is not null and not public.msgr_is_admin(pg.org_id) then
    raise exception 'office: only admins add top-level wiki pages' using errcode = '42501';
  end if;
  if pg.org_id is not null and not public.msgr_is_admin(pg.org_id)
     and public.office_page_hidden(p_id) is distinct from (pg.restricted or (p_parent is not null and public.office_page_hidden(p_parent))) then
    raise exception 'office: only admins move pages across restricted areas' using errcode = '42501'; -- 편집 공유자가 비공개 밖으로 옮겨 숨김을 푸는 것(검수 M2)
  end if;
  update public.office_pages set parent_id = p_parent, position = p_position, updated_at = now()
   where id = p_id and (parent_id is distinct from p_parent or position is distinct from p_position);
end $$;

-- ── 휴지통 ──
create or replace function public.office_page_archive(p_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_id, 'edit');
  with recursive t as (select id from public.office_pages where id = p_id
                       union all select c.id from public.office_pages c join t on c.parent_id = t.id)
  update public.office_pages set archived_at = now(), archived_by = auth.uid() where id in (select id from t) and archived_at is null;
end $$;

create or replace function public.office_page_restore_archived(p_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare pg public.office_pages;
begin
  select * into pg from public.office_pages where id = p_id;
  if not found or pg.archived_at is null then return; end if;
  if pg.archived_by is distinct from auth.uid() then perform public.office_need(p_id, 'full'); -- 지운 사람 또는 전체 권한자
  else perform public.office_need(p_id, 'view'); end if;                                     -- 지운 사람도 지금 접근할 수 있어야(퇴사하면 못 되살린다)
  with recursive t as (select id from public.office_pages where id = p_id
                       union all select c.id from public.office_pages c join t on c.parent_id = t.id)
  update public.office_pages set archived_at = null, archived_by = null
   where id in (select id from t) and archived_at is not null and archived_by is not distinct from pg.archived_by;
end $$;

create or replace function public.office_page_delete(p_id uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_id, 'full');
  delete from public.office_pages where id = p_id;
end $$;

-- ── 복제(공유·비공개·비공개 블록은 따라가지 않는다) ──
create or replace function public.office_page_duplicate(p_id uuid, p_title text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); src public.office_pages; r record; map jsonb := '{}'::jsonb; nid uuid; root uuid; admin boolean; src_acc text;
begin
  perform public.office_need(p_id, 'view');
  src_acc := public.office_page_access(p_id);
  select * into src from public.office_pages where id = p_id;
  if src.parent_id is not null then perform public.office_need(src.parent_id, 'edit');
  elsif src.org_id is not null and not public.msgr_is_admin(src.org_id) then raise exception 'office: only admins add top-level wiki pages' using errcode = '42501';
  elsif src.space_kind = 'me' and src.owner_user_id <> uid then raise exception 'office: not your space' using errcode = '42501';
  end if;
  admin := src.org_id is not null and public.msgr_is_admin(src.org_id);
  for r in with recursive t as (select p.*, 0 as d from public.office_pages p where p.id = p_id
                                union all select c.*, t.d + 1 from public.office_pages c join t on c.parent_id = t.id
                                 where c.archived_at is null and public.office_page_access(c.id) <> 'none')   -- 볼 수 없는 하위(비공개 등)는 복사하지 않는다
           select * from t order by d loop
    nid := gen_random_uuid();
    if r.id = p_id then root := nid; end if;
    map := map || jsonb_build_object(r.id::text, nid);
    insert into public.office_pages (id, space_kind, owner_user_id, org_id, parent_id, position, title, icon, content, general, restricted, created_by, updated_by)
    values (nid, r.space_kind, case when r.space_kind = 'me' then r.owner_user_id else uid end, r.org_id,
            case when r.id = p_id then r.parent_id else (map ->> r.parent_id::text)::uuid end,
            case when r.id = p_id then left(r.position || 'm', 64) else r.position end,
            case when r.id = p_id then coalesce(p_title, r.title) else r.title end,
            r.icon, r.content, r.general, r.restricted and not admin, uid, uid);
  end loop;
  -- 비공개 영역의 사본은 공유가 따라가지 않아 만든 사람도 못 본다(재검수 LOW) — 만든 사람에게만 붙인다. 원본을 전체 권한으로 보던 사람이 아니면 편집까지(남에게 공유는 못 한다)
  if public.office_page_access(root) = 'none' then
    insert into public.office_shares (page_id, principal_kind, user_id, role, created_by)
    values (root, 'user', uid, case when src_acc = 'full' then 'full' else 'edit' end, uid);
  end if;
  return root;
end $$;

-- ── 공유·일반 접근·비공개·게시 ──
create or replace function public.office_share_set(p_page uuid, p_user uuid, p_role text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_page, 'full');
  if p_role is null then delete from public.office_shares where page_id = p_page and principal_kind = 'user' and user_id = p_user; return; end if;
  insert into public.office_shares (page_id, principal_kind, user_id, role, created_by) values (p_page, 'user', p_user, p_role, auth.uid())
  on conflict (page_id, user_id) where principal_kind = 'user' do update set role = excluded.role where office_shares.role is distinct from excluded.role;
end $$;

create or replace function public.office_page_set_general(p_page uuid, p_general text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_page, 'full');
  update public.office_pages set general = p_general where id = p_page and general is distinct from p_general;
end $$;

create or replace function public.office_page_set_restricted(p_page uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare pg public.office_pages;
begin
  select * into pg from public.office_pages where id = p_page;
  if not found or pg.space_kind <> 'org' or not public.msgr_is_admin(pg.org_id) then
    raise exception 'office: only org admins restrict pages' using errcode = '42501';
  end if;
  update public.office_pages set restricted = p_on where id = p_page and restricted is distinct from p_on;
end $$;

create or replace function public.office_page_publish(p_page uuid, p_on boolean) returns text
  language plpgsql security definer set search_path = public, pg_temp as $$
declare tok text;
begin
  perform public.office_need(p_page, 'full');
  select link_token into tok from public.office_shares where page_id = p_page and principal_kind = 'link';
  if tok is null then
    tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');  -- 244비트. pgcrypto는 라이브에서 extensions 스키마라 search_path=public에서 안 보인다(9/27 실측)
    insert into public.office_shares (page_id, principal_kind, link_token, published, created_by) values (p_page, 'link', tok, p_on, auth.uid());
  else
    update public.office_shares set published = p_on where page_id = p_page and principal_kind = 'link' and published is distinct from p_on;
  end if;
  return tok;
end $$;

-- 검색 엔진 노출(기본 끔) — 게시 링크에만 붙는다. 같은 값이면 쓰지 않는다.
create or replace function public.office_page_set_index(p_page uuid, p_on boolean) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_page, 'full');
  update public.office_shares set allow_index = p_on where page_id = p_page and principal_kind = 'link' and allow_index is distinct from p_on;
end $$;

-- 공유 창의 사람 목록 — 전체 권한자만. 이름·역할만 내주고 이메일은 싣지 않는다(msgr_find_user와 같은 원칙).
create or replace function public.office_page_people(p_page uuid) returns table (user_id uuid, name text, role text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.office_need(p_page, 'full');
  return query
    select s.user_id, coalesce(pr.display_name, split_part(u.email, '@', 1)), s.role
      from public.office_shares s join auth.users u on u.id = s.user_id
      left join public.msgr_profiles pr on pr.user_id = s.user_id
     where s.page_id = p_page and s.principal_kind = 'user'
     order by s.created_at;
end $$;

-- 공개 화면에서 뺄 노드(기록 카드·메일 참조·비공개 블록 자리표시)
create or replace function public.office_strip(n jsonb) returns jsonb
  language sql immutable set search_path = public, pg_temp as $$
  select case
    when jsonb_typeof(n) <> 'object' or not (n ? 'content') or jsonb_typeof(n -> 'content') <> 'array' then n
    else jsonb_set(n, '{content}', coalesce((
      select jsonb_agg(public.office_strip(c.value) order by c.ord)
        from jsonb_array_elements(n -> 'content') with ordinality as c(value, ord)
       where coalesce(c.value ->> 'type', '') not in ('recordCard', 'mailRef', 'privateBlock')), '[]'::jsonb))
  end
$$;

create or replace function public.office_public_page(p_token text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('title', p.title, 'content', public.office_strip(p.content), 'org', o.name, 'index', s.allow_index)
    from public.office_shares s
    join public.office_pages p on p.id = s.page_id and p.archived_at is null
    left join public.msgr_orgs o on o.id = p.org_id
   where s.principal_kind = 'link' and s.published and s.link_token = p_token
     and (p.org_id is null or o.deleted_at is null) and not public.office_page_hidden(p.id)
$$;

-- ── 페이지 목록 — 후보를 내 공간·내 조직·내게 공유된 트리로 먼저 좁히고, 권한 판정(RLS)은 그 후보에만 돈다.
-- 전체 표를 조건 없이 읽으면 모든 사용자가 불러올 때마다 테넌트 전체 페이지 × 조상 깊이만큼 판정했다(검수 M3, #533과 같은 계열).
-- 후보(내 공간·내 조직·공유받은 트리)를 먼저 id로 구하고, 권한 판정은 그 후보에만 한다(재검수 M3: invoker면 RLS 판정이 표 전체에 먼저 붙는다).
-- definer라 RLS를 거치지 않으므로 읽기 정책(office_pages_read)과 같은 판정 office_page_access <> 'none'을 여기서 직접 건다 — 결과 동일은 드릴이 잠근다.
create or replace function public.office_page_list() returns setof public.office_pages
  language sql stable security definer set search_path = public, pg_temp as $$
  with recursive shared as (
    select s.page_id as id from public.office_shares s where s.principal_kind = 'user' and s.user_id = auth.uid()
    union select c.id from public.office_pages c join shared on c.parent_id = shared.id),
  cand as materialized (
    select x.id, public.office_page_access(x.id) as acc from (
      select p.id from public.office_pages p where p.space_kind = 'me' and p.owner_user_id = auth.uid()
      union select p.id from public.office_pages p join public.msgr_org_members m on m.org_id = p.org_id and m.user_id = auth.uid() and m.removed_at is null
      union select id from shared) x)
  select p.* from public.office_pages p join cand on cand.id = p.id where cand.acc <> 'none'
$$;
revoke all on function public.office_page_list() from public, anon;
grant execute on function public.office_page_list() to authenticated;

-- ── 정리(휴지통 30일·버전 90일) — 기억 데이터 정리 기간은 유건 승인 값(2026-09-26) ──
create or replace function public.office_purge() returns void
  language sql security definer set search_path = public, pg_temp as $$
  delete from public.office_pages where archived_at < now() - interval '30 days';
  delete from public.office_page_versions where created_at < now() - interval '90 days';
$$;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('office-purge', '43 3 * * *', $c$select public.office_purge()$c$);
  end if;
end $$;

-- ── 실행 권한 ──
do $$ declare f text; begin
  foreach f in array array[
    'office_page_access(uuid)', 'office_need(uuid, text)', 'office_page_create(uuid, uuid, uuid, text, text, jsonb, boolean)',
    'office_page_save(uuid, text, jsonb, integer)', 'office_page_restore(uuid, integer)', 'office_page_move(uuid, uuid, text)',
    'office_page_archive(uuid)', 'office_page_restore_archived(uuid)', 'office_page_delete(uuid)', 'office_page_duplicate(uuid, text)',
    'office_share_set(uuid, uuid, text)', 'office_page_set_general(uuid, text)', 'office_page_set_restricted(uuid, boolean)',
    'office_page_publish(uuid, boolean)', 'office_page_set_index(uuid, boolean)', 'office_page_people(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.office_public_page(text) from public;
grant execute on function public.office_public_page(text) to anon, authenticated;
revoke all on function public.office_purge() from public, anon, authenticated;
-- 내부용(정의자 함수 안에서만 부른다) — 밖에서 비공개 여부를 떠보지 못하게
revoke all on function public.office_page_hidden(uuid) from public, anon, authenticated;
revoke all on function public.office_private_blocks_author() from public, anon, authenticated;
