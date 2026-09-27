-- 아르고 오피스 배치(P0, 2026-09-26) — 유건 확정: "구조는 공유, 보기는 개인".
--   office_user_layouts  : 개인 보기(사이드바 순서·접힘·패널 폭·내 공간 홈 모듈 배치). 본인만 읽고 쓴다.
--   office_space_layouts : 조직 공간 구조(조직 홈 모듈 구성·위키 최상위). 조직 멤버는 읽고, 관리자·소유자만 쓴다.
-- DB 위생(프로젝트 규칙 9/23): 끌기가 끝날 때마다 저장이 오므로 **같은 값이면 행을 건드리지 않는다**(where … is distinct from).
-- 퇴사(msgr_org_members.removed_at)는 msgr_is_member/msgr_is_admin이 이미 걸러 즉시 차단된다.

create table if not exists public.office_user_layouts (
  user_id uuid not null references auth.users(id) on delete cascade,
  space_key text not null check (space_key ~ '^(me|org:[0-9a-f-]{36})$'),
  surface text not null check (surface ~ '^[a-z][a-z0-9_-]{0,31}$'),
  prefs jsonb not null default '{}'::jsonb check (octet_length(prefs::text) <= 16384),
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, space_key, surface)
);
alter table public.office_user_layouts enable row level security;
drop policy if exists office_user_layouts_own on public.office_user_layouts;
create policy office_user_layouts_own on public.office_user_layouts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.office_user_layouts to authenticated;

-- 저장은 이 함수로 — 같은 값이면 쓰지 않는다(호출자 권한으로 실행, RLS가 그대로 걸린다)
create or replace function public.office_layout_save(p_space text, p_surface text, p_prefs jsonb) returns void
  language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.office_user_layouts as l (user_id, space_key, surface, prefs)
    values (auth.uid(), p_space, p_surface, coalesce(p_prefs, '{}'::jsonb))
  on conflict (user_id, space_key, surface) do update
    set prefs = excluded.prefs, version = l.version + 1, updated_at = now()
    where l.prefs is distinct from excluded.prefs;
end $$;
revoke all on function public.office_layout_save(text, text, jsonb) from public, anon;
grant execute on function public.office_layout_save(text, text, jsonb) to authenticated;

create table if not exists public.office_space_layouts (
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  surface text not null check (surface ~ '^[a-z][a-z0-9_-]{0,31}$'),
  layout jsonb not null default '{}'::jsonb check (octet_length(layout::text) <= 32768),
  version integer not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, surface)
);
alter table public.office_space_layouts enable row level security;
drop policy if exists office_space_layouts_read on public.office_space_layouts;
create policy office_space_layouts_read on public.office_space_layouts for select to authenticated
  using (public.msgr_is_member(org_id));
-- 쓰기 정책은 두지 않는다 — 아래 함수만 관리자 확인 뒤 쓴다.
revoke insert, update, delete on public.office_space_layouts from anon, authenticated;
grant select on public.office_space_layouts to authenticated;

create or replace function public.office_space_layout_save(p_org uuid, p_surface text, p_layout jsonb) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not public.msgr_is_admin(p_org) then raise exception 'org admin only' using errcode = '42501'; end if;
  insert into public.office_space_layouts as l (org_id, surface, layout, updated_by)
    values (p_org, p_surface, coalesce(p_layout, '{}'::jsonb), auth.uid())
  on conflict (org_id, surface) do update
    set layout = excluded.layout, version = l.version + 1, updated_by = excluded.updated_by, updated_at = now()
    where l.layout is distinct from excluded.layout;
end $$;
revoke all on function public.office_space_layout_save(uuid, text, jsonb) from public, anon;
grant execute on function public.office_space_layout_save(uuid, text, jsonb) to authenticated;
