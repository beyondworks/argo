-- 레몬스퀴지 구독 메타(M-4 웹훅) — plan 환산의 근거·구독 관리 포털 링크 저장.
-- 쓰기는 여전히 서버(서비스 롤, /api/billing/webhook)만 — 사용자 정책(own select)은 그대로라
-- 본인 행 조회로 포털 링크·상태를 볼 수 있다. plan 체크 제약은 기존('free'|'pro') 유지.
alter table public.entitlements add column if not exists ls_subscription_id text;
alter table public.entitlements add column if not exists ls_customer_id text;
alter table public.entitlements add column if not exists ls_status text;
alter table public.entitlements add column if not exists ls_updated_at timestamptz;
alter table public.entitlements add column if not exists ends_at timestamptz;
alter table public.entitlements add column if not exists portal_url text;
