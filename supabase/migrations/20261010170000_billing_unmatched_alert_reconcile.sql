-- 결제했는데 Pro가 연결되지 않은 건을 운영자가 바로 알게 한다(2026-10-10 유건: "결제하면 당연히 pro를 누려야하는데 매번 왜이러냐").
--
-- 실사고: 9/27·10/3(결제 이메일 ≠ 계정 이메일, user_id 없는 랜딩 결제)과 10/10(결제 먼저·가입 나중 → billing_unmatched no-user)이
-- 모두 고객 문의로 알려졌다. billing_unmatched에 기록은 남아도 아무도 보지 않았고, LS 활성 구독과 entitlements를 맞춰 보는 장치도 없었다.
--
-- ① 미연결 알림 — billing_unmatched에 실결제 행이 새로 들어오면(INSERT만) 운영자 기기로 푸시한다. 경로는 신고 알림과 같다:
--    트리거 → pg_net → msgr-push(엣지, billing_unmatched_id 분기) → msgr_report_operators의 푸시 토큰. 새 외부 서비스는 없다.
--    알림 대상: 사유가 연결 실패(no-user·duplicate-attribution·email-account-has-subscription)이거나 하루 대사가 찾은 불일치
--    (reconcile-ls-pro-not-linked·reconcile-pro-not-in-ls)이고, 구독 번호가 LS 실번호(숫자)이며, 시험 결제·probe가 아닌 행.
--    같은 (구독, 사유)는 표의 고유 색인으로 1행이라 알림도 1번이다(같은 이벤트 재전송·갱신은 UPDATE라 알림이 다시 나가지 않는다).
--    한 시간에 20행 넘게 들어오면 푸시는 건너뛴다(오작동 때 운영자 기기 폭주 방지) — 행은 표에 남는다.
--    알림 실패가 기록을 막지 않는다(예외는 삼킨다 — 웹훅 응답이 500이 되면 LS 재시도만 늘어난다).
--    푸시 내용: 구독 번호·가린 이메일·사유뿐(msgr-push/core.js billingPushText). 이메일 전체는 보내지 않는다.
-- ② 하루 1회 대사 — pg_cron이 ls-reconcile(엣지)을 부른다. LS 구독 목록과 entitlements를 대조해 불일치를 billing_unmatched에
--    적는다(→ ①로 알림). 자동 수정은 하지 않는다. 엣지 주소·호출 비밀은 msgr_settings(ls_reconcile_url·ls_reconcile_secret)에서
--    읽는다 — 둘 중 하나라도 없으면 아무것도 하지 않는다(엣지 배포 전에 이 파일을 적용해도 안전).
--
-- 잠금: billing_unmatched 열 추가·트리거(그 표만 짧게 독점)와 함수·cron 등록뿐. auth·storage 표를 잠그는 DDL은 없다.
-- 부하: 알림은 미연결 행이 생길 때만(지금까지 운영 2행), 대사는 하루 1번 호출 + 불일치가 새로 생길 때만 쓰기.
-- PR #933(record_ls_unmatched·ls_link_late_signups)과 독립 — test_mode 열은 그 PR이 더하므로 to_jsonb로 읽는다(없으면 false).

alter table public.billing_unmatched add column if not exists notified_at timestamptz;
comment on column public.billing_unmatched.notified_at is '운영자 푸시 선점(msgr-push가 null→now로 한 번만 잡는다). 알림 대상이 아니면 null로 남는다.';

-- 알림 대상인가 — msgr-push/core.js billingAlertable과 같은 규칙(test/billing-alert-pg.test.mjs가 두 쪽을 같은 사례로 대조한다).
create or replace function public.billing_unmatched_alertable(r public.billing_unmatched) returns boolean
  language sql stable set search_path = public, pg_temp as $$
    select r.resolved_at is null
       and r.reason in ('no-user', 'duplicate-attribution', 'email-account-has-subscription',
                        'reconcile-ls-pro-not-linked', 'reconcile-pro-not-in-ls')
       and r.ls_subscription_id ~ '^[0-9]+$'
       and r.event_name !~* '(probe|test)'
       and not coalesce((to_jsonb(r) ->> 'test_mode')::boolean, false)
$$;
revoke all on function public.billing_unmatched_alertable(public.billing_unmatched) from public, anon, authenticated;

create or replace function public.billing_unmatched_notify() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if not public.billing_unmatched_alertable(new) then return new; end if;
  if not exists (select 1 from public.msgr_report_operators) then return new; end if;
  if (select count(*) from public.billing_unmatched where created_at > now() - interval '1 hour') > 20 then
    return new; -- 오작동으로 행이 쏟아지면 푸시는 건너뛴다. 행은 남는다
  end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(),
    body := jsonb_build_object('billing_unmatched_id', new.id), timeout_milliseconds := 5000);
  return new;
exception when others then return new; -- 알림 실패가 미연결 기록을 막지 않는다
end $$;
revoke all on function public.billing_unmatched_notify() from public, anon, authenticated;
drop trigger if exists billing_unmatched_notify on public.billing_unmatched;
create trigger billing_unmatched_notify after insert on public.billing_unmatched
  for each row execute function public.billing_unmatched_notify();

-- 하루 대사 호출 — 주소·비밀이 둘 다 있을 때만. 응답은 기다리지 않는다(pg_net 비동기).
create or replace function public.ls_reconcile_kick() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; sec text;
begin
  select value into url from public.msgr_settings where key = 'ls_reconcile_url';
  select value into sec from public.msgr_settings where key = 'ls_reconcile_secret';
  if coalesce(url, '') = '' or coalesce(sec, '') = '' then return; end if;
  perform net.http_post(url := url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || sec),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
end $$;
revoke all on function public.ls_reconcile_kick() from public, anon, authenticated;

-- 매일 00:20 UTC(09:20 KST). pg_cron이 없는 환경(로컬 PG 테스트)에서는 등록하지 않는다. 같은 이름이면 갱신이라 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ls-reconcile-daily', '20 0 * * *', $c$select public.ls_reconcile_kick()$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
