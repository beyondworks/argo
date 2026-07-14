-- 요금제 경계(M-2d 스캐폴드) — plan은 서버(서비스 롤, M-4 결제 webhook)만 쓴다.
-- authenticated는 본인 행 select만: insert/update/delete 정책 없음 = 사용자가 자기 플랜을 못 바꾼다.
create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  updated_at timestamptz not null default now()
);
alter table public.entitlements enable row level security;

drop policy if exists entitlements_own_select on public.entitlements;
create policy entitlements_own_select on public.entitlements
  for select to authenticated using (user_id = (select auth.uid()));
