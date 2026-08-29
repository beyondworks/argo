-- E2EE 키 인프라(단계 0) — 서버에는 공개키와 암호문(랩)만 놓인다. 평문 열쇠 컬럼은 어디에도 없다.
-- account_keys(평문 key_b64)와의 근본 차이가 이 파일의 존재 이유다. 설계 정본: 루트 E2EE-DESIGN.md §5.
-- 단계 0에서는 device_keys 등록만 실사용되고 나머지 3종은 P1(켜기·기기 승인·복구 코드)이 쓴다.
-- RLS는 전부 본인 행만(all-ops own-only) — 서비스 롤이 우회해 읽어도 전부 공개키·암호문뿐이다.

create table if not exists public.device_keys (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null,
  pubkey text not null,                     -- X25519 raw 32B base64 (공개키 — 비밀 아님)
  created_at timestamptz not null default now(),
  revoked_at timestamptz,                   -- 기기 제거 시각(P1) — 행 삭제 대신 폐기 표기(감사 가능)
  primary key (user_id, device_id)
);
alter table public.device_keys enable row level security;
drop policy if exists device_keys_own on public.device_keys;
create policy device_keys_own on public.device_keys
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.wrapped_deks (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null,
  wrap text not null,                       -- argokeywrap.v1 blob base64 (해당 기기 공개키로 랩된 DEK)
  wrapped_by text,                          -- 랩을 만든 기기(감사)
  created_at timestamptz not null default now(),
  primary key (user_id, device_id)
);
alter table public.wrapped_deks enable row level security;
drop policy if exists wrapped_deks_own on public.wrapped_deks;
create policy wrapped_deks_own on public.wrapped_deks
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.recovery_wraps (
  user_id uuid primary key references auth.users (id) on delete cascade,
  wrap text not null,                       -- 복구 코드 유도 KEK로 랩된 DEK
  kdf jsonb not null,                       -- {alg:'scrypt', N, r, p, salt} — 파라미터(비밀 아님)
  created_at timestamptz not null default now()
);
alter table public.recovery_wraps enable row level security;
drop policy if exists recovery_wraps_own on public.recovery_wraps;
create policy recovery_wraps_own on public.recovery_wraps
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create table if not exists public.key_mailbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  to_device text not null,
  from_device text not null,
  wrap text not null,                       -- 승인 시 전달되는 DEK 랩(내용은 서버가 못 봄)
  purpose text not null default 'device-approve',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes')
);
alter table public.key_mailbox enable row level security;
drop policy if exists key_mailbox_own on public.key_mailbox;
create policy key_mailbox_own on public.key_mailbox
  for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
