-- 베타 피드백 — 인앱 폼(/api/feedback)이 insert. 로그인 사용자가 자기 컨텍스트로 남긴다.
-- 조회는 service role(관리자 대시보드)만 — select 정책을 두지 않아 anon/authenticated는 못 읽는다.
-- user_id는 default auth.uid()가 채우므로 라우트가 따로 넣지 않는다. 멱등: if not exists / drop-if-exists.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid default auth.uid() references auth.users(id) on delete set null,
  email text,
  message text not null,
  meta jsonb,
  created_at timestamptz default now()
);

alter table public.feedback enable row level security;

drop policy if exists feedback_insert on public.feedback;
create policy feedback_insert on public.feedback
  for insert to authenticated
  with check (true);
