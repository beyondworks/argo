-- 요금제 개편(2026-09-29 유건 확정) — 14일 무료 체험 폐지 + 결제자·부여 계정만 Pro + 클라우드 사본 30일 보관.
--
-- R1) 신규 체험 폐지, 이미 체험 중인 사람은 남은 기간 보장. 기준 시각 T = 이 마이그레이션이 적용되는
--     순간을 함수 본문에 리터럴로 굳힌다(DO 블록의 now() → format %L) — 이후 재평가되지 않는다.
--     T 이전 가입자만 created_at+14일까지 체험, T 이후 가입자는 체험 자체가 없다.
-- R2) is_pro()는 (a) 결제 유효 pro (b) entitlements.granted=true(운영자 부여) (c) T 이전 가입자 체험
--     (d) msgr_org_entitlements.paid_until > now()인 조직의 non-guest 활성 멤버 — 넷의 OR이다.
--     (d)는 기존 plan='team' 조건(결제 기록 없는 조직까지 자격을 줌)을 대체한다.
--     granted=true 행은 결제 웹훅(apply_ls_event)이 plan을 내리지 못한다 — ls_status·ends_at은 그대로 기록.
-- R4) purge_after(uid) — 별도 표 없이 계산. Pro면 null, 아니면
--     greatest(T, 체험 종료 시각(T 이전 가입자)·ends_at(지난 경우) 중 늦은 값, 없으면 T) + 30일.
--
-- 함수 분리: entitled_pro_for = 결제·부여·조직(체험 제외) OR. trial_end_for = 체험 종료 시각(T 이전
-- 가입자만, 지났어도 값을 준다 — purge_after의 "Pro를 잃은 시각"에 필요). is_pro_for = entitled OR 체험
-- 활성. is_pro()·my_plan()은 이 조립을 auth.uid() 스코프로 감싼 진입점. 넷 다 임의 uid를 받는
-- 내부 함수(entitled_pro_for·trial_end_for·is_pro_for·purge_after)는 service_role 전용 —
-- authenticated에 열면 누구나 남의 uid로 자격을 조회할 수 있다(타인 정보 노출).

alter table public.entitlements add column if not exists granted boolean not null default false;
comment on column public.entitlements.granted is '운영자가 수동으로 부여한 Pro(R2) — 결제 웹훅이 내릴 수 없다. scripts/sql/grant-pro.sql';

-- ── 결제·부여·조직 자격(체험 제외) — T 불필요, plain. ──
create or replace function public.entitled_pro_for(p_uid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' and (ends_at is null or ends_at > now())
                       from public.entitlements where user_id = p_uid), false)
        or coalesce((select granted from public.entitlements where user_id = p_uid), false)
        or exists (select 1 from public.msgr_org_members m
                     join public.msgr_org_entitlements e on e.org_id = m.org_id
                     join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
                    where m.user_id = p_uid and m.removed_at is null and m.role <> 'guest'
                      and e.paid_until > now())
$$;

-- ── T 의존 함수 3개(trial_end_for·is_pro_for·purge_after)를 한 DO 블록에서 만든다 — 같은 t 하나만
--    읽어 전부에 굳힌다(트랜잭션 경계로 now()가 갈리는 경우를 원천 차단). is_pro_for는 T를 직접
--    담지 않지만 trial_end_for가 이미 만들어진 뒤여야 하고, purge_after는 is_pro_for·trial_end_for
--    둘 다 있어야 해서 순서가 있다 — 그래서 셋을 같은 블록·같은 순서로 둔다. ──
do $$
declare t timestamptz := now(); -- 기준 시각 T(R1) — 이 마이그레이션 적용 순간에 고정.
begin
  execute format($fmt$
    create or replace function public.trial_end_for(p_uid uuid) returns timestamptz
      language sql stable security definer set search_path = public, pg_temp as $body$
        select case when created_at < %1$L::timestamptz then created_at + interval '14 days' end
          from auth.users where id = p_uid
      $body$;
  $fmt$, t);

  execute $sql$
    create or replace function public.is_pro_for(p_uid uuid) returns boolean
      language sql stable security definer set search_path = public, pg_temp as $body$
        select public.entitled_pro_for(p_uid) or coalesce(public.trial_end_for(p_uid) > now(), false)
      $body$;
  $sql$;

  execute format($fmt$
    create or replace function public.purge_after(p_uid uuid) returns timestamptz
      language sql stable security definer set search_path = public, pg_temp as $body$
        select case when public.is_pro_for(p_uid) then null
          else greatest(%1$L::timestamptz,
                 coalesce(
                   greatest(
                     public.trial_end_for(p_uid),
                     (select case when e.ends_at is not null and e.ends_at <= now() then e.ends_at end
                        from public.entitlements e where e.user_id = p_uid)
                   ),
                   %1$L::timestamptz
                 )
               ) + interval '30 days'
          end
      $body$;
  $fmt$, t);
end $$;

-- ── is_pro() — 기존 자리(20260903120000). auth.uid() 스코프로 is_pro_for를 감싼다. 시그니처 불변. ──
create or replace function public.is_pro() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.is_pro_for(auth.uid())
$$;
revoke all on function public.is_pro() from public;
revoke execute on function public.is_pro() from anon;
grant execute on function public.is_pro() to authenticated;

-- ── my_plan() — 앱(entitlement.mjs fetchPlan·app/api/me/billing·app/api/me/e2ee)의 단일 진입점.
--    쿠키·기기세션(사용자 JWT) 경로는 인자 없이 self, 서비스 롤 폴백 경로만 p_uid를 명시(auth.uid()
--    없음 확인 후). authenticated가 남의 p_uid를 넣으면 거부(자기 것만) — R3 "앱·서버 판정 일치". ──
create or replace function public.my_plan(p_uid uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid; te timestamptz;
begin
  -- 경계는 역할로 판정한다 — "sub 클레임이 없으면 서비스 경로"로 보면 sub 없는 authenticated 토큰이 남의 판정을 읽는다(검수 #753 H1).
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
              nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role') = 'service_role' then
    uid := p_uid; -- 서비스 롤 경로(기기 세션 폴백, app/api/me/billing) — 호출부가 검증된 uid를 넘긴다
  else
    uid := auth.uid();
    if p_uid is not null and p_uid is distinct from uid then
      raise exception 'my_plan_forbidden' using errcode = '42501';
    end if;
  end if;
  if uid is null then
    return jsonb_build_object('plan', 'free', 'trialEndsAt', null, 'purgeAfter', null);
  end if;
  te := public.trial_end_for(uid);
  return jsonb_build_object(
    'plan', case when public.entitled_pro_for(uid) then 'pro'
                 when te is not null and te > now() then 'trial'
                 else 'free' end,
    'trialEndsAt', case when te is not null and te > now() then te else null end,
    'purgeAfter', public.purge_after(uid)
  );
end
$$;

-- ── 권한 재고정(멱등) — 임의 uid를 받는 내부 함수는 authenticated·anon에 절대 열지 않는다(타인 자격 조회 방지). ──
do $$ declare f text; begin
  foreach f in array array[
    'trial_end_for(uuid)', 'entitled_pro_for(uuid)', 'is_pro_for(uuid)', 'purge_after(uuid)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
revoke all on function public.my_plan(uuid) from public;
revoke execute on function public.my_plan(uuid) from anon;
grant execute on function public.my_plan(uuid) to authenticated, service_role;

-- ── 삭제 대상 후보(R4 운영 스크립트용) — 표 대신 함수. scripts/cloud-purge.mjs가 service_role로 호출. ──
create or replace function public.plan_purge_candidates() returns table(user_id uuid, purge_after timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select u.id, public.purge_after(u.id)
      from auth.users u
     where not public.is_pro_for(u.id) and public.purge_after(u.id) < now()
$$;
revoke all on function public.plan_purge_candidates() from public;
revoke execute on function public.plan_purge_candidates() from anon, authenticated;
grant execute on function public.plan_purge_candidates() to service_role;

-- ── apply_ls_event(20260728113000) 재정의 — granted=true 행은 결제 웹훅이 plan을 못 내린다(R2).
--    ls_status·ls_subscription_id·ends_at 등은 그대로 기록(결제 상태 관측은 유지, 접근만 안 내려간다).
--    시그니처 불변(8개 인자) — create or replace만으로 충분, drop 불필요(주석 20260728113000 규칙 참조). ──
create or replace function public.apply_ls_event(
  p_user_id uuid,
  p_plan text,
  p_sub_id text,
  p_customer_id text,
  p_status text,
  p_updated_at timestamptz,
  p_ends_at timestamptz,
  p_portal_url text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_applied uuid;
  v_stored_sub text;
begin
  p_sub_id := coalesce(p_sub_id, '');
  insert into public.entitlements as e
    (user_id, plan, ls_subscription_id, ls_customer_id, ls_status, ls_updated_at, ends_at, portal_url, updated_at)
  values
    (p_user_id, p_plan, p_sub_id, p_customer_id, p_status, p_updated_at, p_ends_at, p_portal_url, now())
  on conflict (user_id) do update set
    plan = case when e.granted then e.plan else excluded.plan end, -- R2: 부여 Pro는 웹훅이 plan을 못 내린다
    ls_subscription_id = excluded.ls_subscription_id,
    ls_customer_id = excluded.ls_customer_id,
    ls_status = excluded.ls_status,
    ls_updated_at = excluded.ls_updated_at,
    ends_at = excluded.ends_at,
    portal_url = excluded.portal_url,
    updated_at = now()
  where
    (coalesce(e.ls_subscription_id, '') <> excluded.ls_subscription_id
     or e.ls_updated_at is null or excluded.ls_updated_at is null
     or e.ls_updated_at <= excluded.ls_updated_at)
    and not (excluded.plan = 'free'
             and coalesce(e.ls_subscription_id, '') <> ''
             and e.ls_subscription_id <> excluded.ls_subscription_id)
  returning e.user_id into v_applied;
  if v_applied is not null then
    return 'applied';
  end if;
  select coalesce(ls_subscription_id, '') into v_stored_sub from public.entitlements where user_id = p_user_id;
  if v_stored_sub = p_sub_id then
    return 'stale';
  end if;
  return 'other_subscription';
end;
$$;
revoke execute on function public.apply_ls_event(uuid, text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.apply_ls_event(uuid, text, text, text, text, timestamptz, timestamptz, text)
  to service_role;
