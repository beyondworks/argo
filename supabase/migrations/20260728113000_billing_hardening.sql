-- 결제 견고화(PR #160 분리 검수 이월분 M1·M4)
--
-- [M1] apply_ls_event — 웹훅의 select→JS비교→upsert 3단계를 단일 문장
-- (insert ... on conflict do update ... where)으로 내려 원자화한다. 동시 전달(예: updated와
-- cancelled가 거의 동시에 발화)에서 두 요청이 같은 과거 스냅샷을 읽고 나중 쓰기가 과거 상태를
-- 최종으로 남기던 race를 없앤다 — 조건 판정과 쓰기가 한 문장이라 행 잠금 안에서 직렬화된다.
-- WHERE 조건은 src/lsbilling.mjs의 isStaleEvent·isOtherSubscriptionDowngrade와 동치(변경 시 양쪽 동기 필수):
--   ① 순서 역전: 저장분이 더 최신이면 스킵(비교 불가 null은 진행)
--   ② 구독 신원 가드(O1): 다른 구독의 강등(free)은 스킵(승격은 신원 무관 허용)
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
  v_stored_updated timestamptz;
begin
  insert into public.entitlements as e
    (user_id, plan, ls_subscription_id, ls_customer_id, ls_status, ls_updated_at, ends_at, portal_url, updated_at)
  values
    (p_user_id, p_plan, p_sub_id, p_customer_id, p_status, p_updated_at, p_ends_at, p_portal_url, now())
  on conflict (user_id) do update set
    plan = excluded.plan,
    ls_subscription_id = excluded.ls_subscription_id,
    ls_customer_id = excluded.ls_customer_id,
    ls_status = excluded.ls_status,
    ls_updated_at = excluded.ls_updated_at,
    ends_at = excluded.ends_at,
    portal_url = excluded.portal_url,
    updated_at = now()
  where
    (e.ls_updated_at is null or excluded.ls_updated_at is null or e.ls_updated_at <= excluded.ls_updated_at)
    and not (excluded.plan = 'free'
             and coalesce(e.ls_subscription_id, '') <> ''
             and e.ls_subscription_id <> excluded.ls_subscription_id)
  returning e.user_id into v_applied;
  if v_applied is not null then
    return 'applied';
  end if;
  -- 차단 사유 분류(진단·응답용) — on conflict가 행 잠금을 잡은 뒤라 같은 트랜잭션의 일관 조회다.
  select ls_updated_at into v_stored_updated from public.entitlements where user_id = p_user_id;
  if v_stored_updated is not null and p_updated_at is not null and p_updated_at < v_stored_updated then
    return 'stale';
  end if;
  return 'other_subscription';
end;
$$;

-- 호출 주체는 서버(서비스 롤)뿐 — 사용자가 RPC로 자기 플랜을 승격하는 구멍을 막는다.
revoke execute on function public.apply_ls_event(uuid, text, text, text, text, timestamptz, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.apply_ls_event(uuid, text, text, text, text, timestamptz, timestamptz, text)
  to service_role;

-- [M4] billing_unmatched — 웹훅 귀속 실패(no-user·test-mode·other-product·unknown-status)를
-- console.error 한 줄로 흘리지 않고 적재한다. 결제는 됐는데 pro가 안 붙은 건을 수동 귀속할 근거.
-- RLS on + 정책 없음 = 서비스 롤만 읽고 쓴다(사용자에게 타인 이메일·구독 id를 노출하지 않는다).
create table if not exists public.billing_unmatched (
  id bigint generated always as identity primary key,
  event_name text not null default '',
  reason text not null default '',
  ls_subscription_id text not null default '',
  ls_customer_id text not null default '',
  user_email text not null default '',
  created_at timestamptz not null default now()
);
alter table public.billing_unmatched enable row level security;
-- 같은 구독의 같은 사유는 1행 — subscription_updated가 구독 수명 내내 반복 발화해도 테이블이 불어나지 않는다.
create unique index if not exists billing_unmatched_dedup
  on public.billing_unmatched (ls_subscription_id, reason);
