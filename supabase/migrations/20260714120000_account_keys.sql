-- 계정 키 — 크레덴셜 봉투 암호화(v2)의 계정별 루트 키. 본인만 읽고 1회 생성(갱신·삭제 정책 없음 — 회전은 후속).
-- 서비스 롤은 RLS 우회(워커·셀프호스트가 테넌트 키를 읽는 경로).
create table if not exists public.account_keys (
  user_id uuid primary key references auth.users (id) on delete cascade,
  key_b64 text not null,
  created_at timestamptz not null default now()
);
alter table public.account_keys enable row level security;

drop policy if exists account_keys_own_select on public.account_keys;
create policy account_keys_own_select on public.account_keys
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists account_keys_own_insert on public.account_keys;
create policy account_keys_own_insert on public.account_keys
  for insert to authenticated with check (user_id = (select auth.uid()));
