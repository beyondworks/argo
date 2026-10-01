-- 메신저 첫 사용 안내(사용법 둘러보기, 유건 결정 2026-10-01) — 본 기록을 계정 단위로 남겨 다른 기기에서 다시 뜨지 않게 한다.
--
-- 별도 표로 둔다 — msgr_profiles에는 친구가 서로 읽는 정책(msgr_profiles_friends_read)이 있어 열로 얹으면 친구가 내 기록을 읽는다
-- (msgr_ai_consent와 같은 이유). RLS 정책을 두지 않고(전면 차단) 아래 RPC 두 개로만 다룬다.
--
-- DB 위생(프로젝트 규칙 2026-09-23):
--  · 쓰기는 앱에서 '완료/건너뛰기'를 누를 때 한 번뿐이고, 같은 판 번호 이하면 행을 건드리지 않는다(where … < excluded.version).
--  · 읽기는 그 기기에서 아직 안 봤을 때 앱 실행당 한 번(본 기기는 기기 기록으로 판정해 호출 0).
--  · 행은 사용자당 하나로 고정되고 계정 삭제 때 함께 지워진다 — 쌓이는 데이터가 아니라 보존 기간 정리가 필요 없다.
create table if not exists public.msgr_guide_seen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version smallint not null check (version between 1 and 1000),
  seen_at timestamptz not null default now()
);
alter table public.msgr_guide_seen enable row level security;
revoke all on public.msgr_guide_seen from public, anon, authenticated;
grant all on public.msgr_guide_seen to service_role;

-- 본인이 본 안내 판 번호(안 봤으면 null)
create or replace function public.msgr_my_guide_seen() returns smallint
  language sql stable security definer set search_path = public, pg_temp as $$
    select version from public.msgr_guide_seen where user_id = auth.uid()
$$;

-- 이 판을 봤다고 남긴다 — 더 높은 판일 때만 쓴다(옛 앱이 낮은 번호로 되돌리지 못하고, 같은 번호면 쓰기 0)
create or replace function public.msgr_mark_guide_seen(p_version smallint) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  if p_version is null or p_version < 1 or p_version > 1000 then raise exception 'msgr_guide_version' using errcode = '22023'; end if;
  insert into public.msgr_guide_seen as g (user_id, version, seen_at) values (me, p_version, now())
    on conflict (user_id) do update set version = excluded.version, seen_at = now()
    where g.version < excluded.version;
end $$;

revoke all on function public.msgr_my_guide_seen() from public, anon;
grant execute on function public.msgr_my_guide_seen() to authenticated;
revoke all on function public.msgr_mark_guide_seen(smallint) from public, anon;
grant execute on function public.msgr_mark_guide_seen(smallint) to authenticated;
