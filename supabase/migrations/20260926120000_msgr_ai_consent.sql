-- App Store 5.1.2(2025-11 신설, 제3자 AI 공개·동의) — 2026-09-27 재설계(유건 결정: "처음 한 번 필수 동의").
-- 로그인 뒤(기존 사용자는 업데이트 뒤 첫 실행) 조직 공간에 들어가기 전 한 번 동의 화면을 보여준다. 동의하면 기존처럼
-- 전 기능, 거부하면 조직 공간은 막고 개인 공간(조직 밖 1:1)만 쓴다. 설정·조직 진입 시점에 다시 동의하거나 철회할 수
-- 있다(철회 = 조직 공간에서 나가는 효과). "크루에게 보낼 때마다" 확인하던 이전 설계는 없앤다.
--
-- 별도 표(msgr_ai_consent)로 둔다 — msgr_profiles에는 친구가 서로 읽는 정책(msgr_profiles_friends_read)이 있어
-- 열로 얹으면 친구가 내 동의 시각을 볼 수 있었다(검수 L2). 이 표는 RLS 정책을 아예 두지 않고(전면 차단) RPC로만
-- 접근한다 — 본인도 직접 select/upsert 못 한다(검수 L3).
create table if not exists public.msgr_ai_consent (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consent_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.msgr_ai_consent enable row level security;
revoke all on public.msgr_ai_consent from public, anon, authenticated;

create or replace function public.msgr_set_ai_consent(consent boolean) returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); at timestamptz;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  at := case when consent then now() else null end;
  insert into public.msgr_ai_consent (user_id, consent_at, updated_at) values (me, at, now())
    on conflict (user_id) do update set consent_at = at, updated_at = now();
  return at;
end $$;

-- 본인의 동의 시각 — 설정 화면·조직 진입 게이트가 쓴다.
create or replace function public.msgr_my_ai_consent() returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
    select consent_at from public.msgr_ai_consent where user_id = auth.uid()
$$;

-- 서버 사이드(엣지 함수 등 service_role) 전용 — 임의 사용자의 동의 여부를 아무나 물을 수 없게 한다(검수 L4).
-- 본인 조회는 msgr_my_ai_consent, 게이트웨이의 "그 사람이 내 크루로 오는 걸 동의했나"는 아래 msgr_org_ai_consent_ok(조직
-- 범위로 한정)를 쓴다 — 둘 다 이 함수와는 별개다.
create or replace function public.msgr_ai_consent_ok(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_ai_consent where user_id = p_user and consent_at is not null)
$$;
revoke all on function public.msgr_ai_consent_ok(uuid) from public, anon, authenticated;
grant execute on function public.msgr_ai_consent_ok(uuid) to service_role;

-- 게이트웨이(호스트 브리지, 일반 인증 세션)가 크루 턴을 넘길지 판단할 때 쓰는 좁은 창구 — 같은 조직에 활성 크루를
-- 가진 사람만 물을 수 있고, 대상도 그 조직 멤버여야 한다(임의 uuid 프로브 방지, 검수 L4 취지). 조직 멤버 명단은 이미
-- 서로 보이는 정보라 새 프라이버시 경계가 생기지 않는다. org 단위라 크루가 여럿이어도 사람당 한 번만 물으면 된다(검수 L9).
create or replace function public.msgr_org_ai_consent_ok(p_org uuid, p_author uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select
      exists (select 1 from public.msgr_crews where org_id = p_org and owner_user_id = auth.uid() and status = 'active')
      and exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = p_author and removed_at is null)
      and exists (select 1 from public.msgr_ai_consent where user_id = p_author and consent_at is not null)
$$;
revoke all on function public.msgr_org_ai_consent_ok(uuid, uuid) from public, anon;
grant execute on function public.msgr_org_ai_consent_ok(uuid, uuid) to authenticated;

revoke all on function public.msgr_set_ai_consent(boolean) from public, anon; grant execute on function public.msgr_set_ai_consent(boolean) to authenticated;
revoke all on function public.msgr_my_ai_consent() from public, anon; grant execute on function public.msgr_my_ai_consent() to authenticated;
