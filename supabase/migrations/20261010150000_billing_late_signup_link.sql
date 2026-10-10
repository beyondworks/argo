-- 결제 먼저, 가입 나중 — 미연결 결제를 나중에 생긴 계정에 연결한다(2026-10-10).
--
-- 실사고(2026-10-10 운영 읽기 확인): 구독 subscription_created가 2026-10-09 21:00 UTC에 들어왔을 때 결제 이메일과 같은
-- Argo 계정이 없어 ls-webhook이 billing_unmatched(reason no-user)에 남기고 200으로 끝냈다. 같은 이메일 계정은 6시간 뒤
-- Google로 가입해 이메일 인증까지 됐지만, 남은 미연결 기록을 다시 보는 장치가 없어 결제한 사용자가 계속 Free였다.
--
-- ① billing_unmatched에 적용에 필요한 값을 남긴다 — plan·ls_status·ls_updated_at·ends_at·portal_url·test_mode.
--    예전 기록(새 열이 빈 행)은 그대로 둔다. 무엇을 적용할지 모르는 행은 자동 연결하지 않는다(수동 연결 대상).
-- ② 기록은 record_ls_unmatched 한 함수로만 쓴다(엣지·Next 수신자 둘 다). 같은 (구독, 사유)는 1행이고, 이벤트가 여러 번
--    오면 LS updated_at이 가장 최근인 상태가 남는다 — 순서 역전 규칙은 apply_ls_event와 같다(같은 값이면 쓰지 않는다).
-- ③ ls_link_late_signups — pg_cron 10분마다. 미해결 no-user 기록 중 결제 이메일과 같은 인증된 계정이 정확히 하나이고
--    (ls_user_by_email), 그 구독이 다른 계정에 연결돼 있지 않고, 그 계정이 다른 유효 구독을 갖고 있지 않을 때만
--    apply_ls_event(기록에 남은 값)를 부르고 resolved_at을 채운다. 할 일이 없으면 아무 행도 쓰지 않는다(잠금도 없다).
--
-- 잠금: 이 파일은 billing_unmatched 열 추가(그 표만 짧게 독점)와 함수 교체·cron 등록뿐이다. auth·storage 표를 잠그는
-- 정책·트리거 DDL은 없다(supautils 교착 2026-10-08 참고). auth.users에 트리거를 걸지 않고 크론으로 다시 본다.
-- linked_user_id는 auth.users 외래 키를 걸지 않는다 — 외래 키 생성은 auth.users를 잠근다. 기록용 값일 뿐이다.

alter table public.billing_unmatched
  add column if not exists plan text,
  add column if not exists ls_status text,
  add column if not exists ls_updated_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists portal_url text,
  add column if not exists test_mode boolean not null default false,
  add column if not exists linked_user_id uuid;

-- ── 기록 — 엣지(supabase/functions/ls-webhook)·Next(src/lsbilling.mjs recordUnmatched) 공용 ──
-- 반환: 'inserted' | 'updated' | 'kept'(해결된 행·더 오래된 이벤트·같은 값 — 쓰지 않음).
-- 해결된 행(resolved_at)은 바꾸지 않는다 — 운영자나 크론이 처리를 끝낸 기록의 근거를 덮지 않는다.
create or replace function public.record_ls_unmatched(
  p_event_name text,
  p_reason text,
  p_sub_id text,
  p_customer_id text,
  p_email text,
  p_plan text,
  p_status text,
  p_updated_at timestamptz,
  p_ends_at timestamptz,
  p_portal_url text,
  p_test_mode boolean
) returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inserted boolean;
begin
  insert into public.billing_unmatched as b
    (event_name, reason, ls_subscription_id, ls_customer_id, user_email,
     plan, ls_status, ls_updated_at, ends_at, portal_url, test_mode)
  values
    (coalesce(p_event_name, ''), coalesce(p_reason, ''), coalesce(p_sub_id, ''), coalesce(p_customer_id, ''), coalesce(p_email, ''),
     p_plan, p_status, p_updated_at, p_ends_at, p_portal_url, coalesce(p_test_mode, false))
  on conflict (ls_subscription_id, reason) do update set
    event_name = excluded.event_name,
    ls_customer_id = excluded.ls_customer_id,
    user_email = excluded.user_email,
    plan = excluded.plan,
    ls_status = excluded.ls_status,
    ls_updated_at = excluded.ls_updated_at,
    ends_at = excluded.ends_at,
    portal_url = excluded.portal_url,
    test_mode = excluded.test_mode
  where b.resolved_at is null
    -- 구독 번호가 빈 이벤트는 사유별 1행으로 뭉개진다 — 예전처럼 첫 기록을 유지한다(수동 처리 근거인 첫 결제 이메일을 덮지 않게)
    and b.ls_subscription_id <> ''
    -- 순서 역전 — apply_ls_event와 같은 규칙(어느 쪽이든 시각을 모르면 진행, 아니면 저장분이 더 최신일 때 멈춤)
    and (b.ls_updated_at is null or excluded.ls_updated_at is null or b.ls_updated_at <= excluded.ls_updated_at)
    -- LS 재전송(같은 페이로드)은 쓰지 않는다
    and (b.event_name, b.ls_customer_id, b.user_email, b.plan, b.ls_status, b.ls_updated_at, b.ends_at, b.portal_url, b.test_mode)
        is distinct from
        (excluded.event_name, excluded.ls_customer_id, excluded.user_email, excluded.plan, excluded.ls_status,
         excluded.ls_updated_at, excluded.ends_at, excluded.portal_url, excluded.test_mode)
  returning (xmax = 0) into v_inserted;
  if v_inserted is null then
    return 'kept';
  end if;
  return case when v_inserted then 'inserted' else 'updated' end;
end;
$$;
revoke all on function public.record_ls_unmatched(text, text, text, text, text, text, text, timestamptz, timestamptz, text, boolean) from public;
revoke execute on function public.record_ls_unmatched(text, text, text, text, text, text, text, timestamptz, timestamptz, text, boolean) from anon, authenticated;
grant execute on function public.record_ls_unmatched(text, text, text, text, text, text, text, timestamptz, timestamptz, text, boolean) to service_role;

-- ── 나중 가입 연결 — pg_cron이 10분마다 부른다. 반환: 이번에 처리한 기록 수 ──
-- 후보: 미해결 + no-user + 시험 결제 아님 + 구독 라이프사이클 이벤트(엣지 LIFECYCLE과 같은 목록 — probe·reconcile 같은 이름 제외)
--       + 기록된 최신 상태가 Pro이고 기간이 남음 + 구독 번호·결제 이메일이 있음 + 그 이메일의 인증된 계정이 정확히 하나.
--       새 열이 빈 옛 기록은 plan이 null이라 후보가 아니다.
-- 연결하지 않는 경우(웹훅 규칙과 같다):
--   · 그 구독이 이미 다른 계정에 연결돼 있다(duplicate-attribution — 1결제 N계정 Pro 차단)
--   · 그 계정이 지금 다른 구독으로 유효한 Pro다(email-account-has-subscription — ls-webhook holdsOtherActiveSub와 같은 판정)
--   · 같은 구독의 다른 사유 기록(email-account-has-subscription 등)이 더 최신이거나 시각을 모른다 — no-user 행의 상태가 낡았을 수 있다
--     (그 뒤 해지·만료가 다른 사유 행에만 쌓였으면 끝난 구독을 기한 없는 Pro로 연결하게 된다. 분리 검수 MEDIUM-1). 수동 판단 대상.
-- 그 구독이 이미 같은 계정에 연결돼 있으면(가입 뒤 다음 이벤트가 웹훅에서 바로 연결한 경우 등) 다시 적용하지 않고 해결 표시만 한다
-- — 기록의 상태가 연결된 행보다 오래됐을 수 있다.
-- 쓰기: 연결할 것이 정해진 기록만 잠그고(다시 읽어 확인) 쓴다. 후보가 없거나 전부 막히면 어떤 행도 잠그거나 쓰지 않는다.
create or replace function public.ls_link_late_signups() returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c record;
  r public.billing_unmatched%rowtype;
  v_res text;
  n integer := 0;
begin
  for c in
    select b.id, b.ls_subscription_id, x.uid
      from public.billing_unmatched b
      cross join lateral (select public.ls_user_by_email(b.user_email) as uid) x
     where b.resolved_at is null
       and b.reason = 'no-user'
       and not b.test_mode
       and b.event_name in ('subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_resumed',
                            'subscription_expired', 'subscription_paused', 'subscription_unpaused', 'subscription_plan_changed')
       and b.plan = 'pro'
       and b.ls_status in ('active', 'on_trial', 'past_due', 'cancelled')
       and (b.ends_at is null or b.ends_at > now())
       and b.ls_subscription_id <> ''
       and btrim(b.user_email) <> ''
       and x.uid is not null
       and not exists (select 1 from public.billing_unmatched o
                        where o.ls_subscription_id = b.ls_subscription_id and o.id <> b.id
                          and (o.ls_updated_at is null or b.ls_updated_at is null or o.ls_updated_at > b.ls_updated_at))
     order by b.id
  loop
    -- 판정은 잠그기 전에 한 번(막힌 후보는 잠그지도 쓰지도 않는다), 잠근 뒤 한 번 더 한다(그 사이 웹훅이 연결을 바꿨을 수 있다).
    -- 그 구독이 이미 다른 계정에 연결
    if exists (select 1 from public.entitlements e
                where e.ls_subscription_id = c.ls_subscription_id and e.user_id <> c.uid) then
      continue;
    end if;
    -- 그 계정이 지금 다른 구독으로 유효한 Pro(구독 번호 없는 행 — 그랜드파더링·운영자 부여 — 은 다른 구독이 아니다)
    if exists (select 1 from public.entitlements e
                where e.user_id = c.uid
                  and coalesce(e.ls_subscription_id, '') <> ''
                  and e.ls_subscription_id <> c.ls_subscription_id
                  and e.plan = 'pro'
                  and (e.ends_at is null or e.ends_at > now())) then
      continue;
    end if;

    -- 할 일이 정해졌다 — 이제야 기록을 잠그고 다시 읽는다(그 사이 웹훅이 상태를 바꿨거나 다른 실행이 처리했을 수 있다).
    select * into r from public.billing_unmatched b
     where b.id = c.id and b.resolved_at is null and b.reason = 'no-user' and not b.test_mode
       and b.plan = 'pro' and b.ls_status in ('active', 'on_trial', 'past_due', 'cancelled')
       and (b.ends_at is null or b.ends_at > now())
       and b.ls_subscription_id = c.ls_subscription_id
     for update skip locked;
    if not found or public.ls_user_by_email(r.user_email) is distinct from c.uid then
      continue;
    end if;
    if exists (select 1 from public.entitlements e
                where e.ls_subscription_id = r.ls_subscription_id and e.user_id <> c.uid)
       or exists (select 1 from public.entitlements e
                   where e.user_id = c.uid
                     and coalesce(e.ls_subscription_id, '') <> ''
                     and e.ls_subscription_id <> r.ls_subscription_id
                     and e.plan = 'pro'
                     and (e.ends_at is null or e.ends_at > now())) then
      continue;
    end if;

    if exists (select 1 from public.entitlements e
                where e.user_id = c.uid and e.ls_subscription_id = r.ls_subscription_id) then
      v_res := 'already_linked';
    else
      v_res := public.apply_ls_event(c.uid, r.plan, r.ls_subscription_id, r.ls_customer_id, r.ls_status,
                                     r.ls_updated_at, r.ends_at, r.portal_url);
    end if;
    -- pro 이벤트라 other_subscription(신원 가드)은 나오지 않는다. 그래도 연결되지 않았으면 해결 표시를 하지 않는다.
    if v_res in ('applied', 'already_linked') then
      update public.billing_unmatched set resolved_at = now(), linked_user_id = c.uid where id = c.id;
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;
revoke all on function public.ls_link_late_signups() from public;
revoke execute on function public.ls_link_late_signups() from anon, authenticated;
grant execute on function public.ls_link_late_signups() to service_role;

-- 10분마다. 부하: 미해결 후보 기록 수만큼 ls_user_by_email(auth.users 이메일 비교) 한 번씩 — 할 일이 없으면 쓰기 0.
-- 실행 기록(cron.job_run_details, 하루 144행)은 purge-cron-run-details(20260923220000, 7일 보존)가 지운다.
-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ls-link-late-signups', '*/10 * * * *', $c$select public.ls_link_late_signups()$c$);
  end if;
end $$;

-- 엣지 함수가 새 함수(record_ls_unmatched)를 바로 찾게 PostgREST 스키마 캐시를 다시 읽힌다.
notify pgrst, 'reload schema';
