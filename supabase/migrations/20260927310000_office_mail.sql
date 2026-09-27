-- 아르고 오피스 메일 계정(유건 확정 2026-09-27): Gmail·Google Workspace를 "로그인 → 권한 승인"으로 연결, 한 사람이 여러 계정.
-- 메일 본문은 DB에 두지 않는다 — 메일 서버(Gmail)에 있고 볼 때 가져온다. 여기에는 계정 목록과 봉인한 토큰만.
--
-- 토큰은 서버 함수(apps/office/api)가 OFFICE_MAIL_KEY로 봉인(AES-256-GCM, 사용자·주소를 AAD로 묶음)한 문자열만 저장한다.
-- 서버 함수는 서비스 키 없이 요청자의 JWT로 아래 함수를 부른다 — 봉인 문자열이 본인에게 돌아가도 키가 없으면 풀 수 없고,
-- 남의 계정 봉인 문자열을 제 계정에 넣어도 AAD가 달라 풀리지 않는다.
-- 부하: 계정 연결·해제·토큰 갱신(계정당 최대 시간당 1회, 바뀔 때만)만 쓴다. 메일 목록·읽기는 DB를 쓰지 않는다.

create table if not exists public.office_mail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('google')),          -- ponytail: 'microsoft'·'imap'은 그 단계에서 check에 더한다
  address text not null,
  display_name text,
  hosted_domain text,                                             -- Google Workspace 회사 도메인(개인 Gmail은 null)
  status text not null default 'ok' check (status in ('ok', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, address)
);
create table if not exists public.office_mail_secrets (
  account_id uuid primary key references public.office_mail_accounts(id) on delete cascade,
  sealed text not null,                                           -- 봉인한 갱신 토큰
  access_sealed text,                                             -- 봉인한 접근 토큰(1시간) — 매 요청마다 갱신하지 않으려고
  access_expires timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.office_mail_accounts enable row level security;
alter table public.office_mail_secrets enable row level security;
revoke all on public.office_mail_accounts, public.office_mail_secrets from anon, authenticated;
grant select on public.office_mail_accounts to authenticated;
drop policy if exists office_mail_accounts_own on public.office_mail_accounts;
create policy office_mail_accounts_own on public.office_mail_accounts for select to authenticated using (user_id = auth.uid());
-- office_mail_secrets: 정책 없음·권한 없음 — 아래 함수로만.

/** 연결(새로 또는 다시). p_expect = 연결을 시작한 사용자(서버가 서명한 state) — 다른 세션이 끝내면 거절(CSRF) */
create or replace function public.office_mail_connect(p_expect uuid, p_provider text, p_address text, p_name text, p_hd text, p_sealed text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); acc uuid;
begin
  if uid is null or uid is distinct from p_expect then raise exception 'office_mail: session mismatch' using errcode = '42501'; end if;
  insert into office_mail_accounts (user_id, provider, address, display_name, hosted_domain)
    values (uid, p_provider, lower(p_address), nullif(p_name, ''), nullif(p_hd, ''))
  on conflict (user_id, provider, address) do update
    set display_name = excluded.display_name, hosted_domain = excluded.hosted_domain, status = 'ok', updated_at = now()
  returning id into acc;
  insert into office_mail_secrets (account_id, sealed) values (acc, p_sealed)
  on conflict (account_id) do update set sealed = excluded.sealed, access_sealed = null, access_expires = null, updated_at = now();
  return acc;
end $$;

/** 서버 함수가 계정 토큰을 꺼낸다 — 본인 계정만(봉인된 채로) */
create or replace function public.office_mail_secret(p_account uuid)
returns table (user_id uuid, provider text, address text, status text, sealed text, access_sealed text, access_expires timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.user_id, a.provider, a.address, a.status, s.sealed, s.access_sealed, s.access_expires
  from office_mail_accounts a join office_mail_secrets s on s.account_id = a.id
  where a.id = p_account and a.user_id = auth.uid()
$$;

/** 접근 토큰 갱신 결과 저장 — 서버가 갱신했을 때만 부른다(같은 값이면 쓰지 않는다) */
create or replace function public.office_mail_token_put(p_account uuid, p_access_sealed text, p_expires timestamptz, p_sealed text default null)
returns void language sql security definer set search_path = public, pg_temp as $$
  update office_mail_secrets s set access_sealed = p_access_sealed, access_expires = p_expires, sealed = coalesce(p_sealed, s.sealed), updated_at = now()
  from office_mail_accounts a
  where s.account_id = p_account and a.id = s.account_id and a.user_id = auth.uid()
    and (s.access_sealed is distinct from p_access_sealed or s.sealed is distinct from coalesce(p_sealed, s.sealed))
$$;

/** 상태 표시(갱신 토큰 만료 → 'expired') — 바뀔 때만 쓴다 */
create or replace function public.office_mail_mark(p_account uuid, p_status text)
returns void language sql security definer set search_path = public, pg_temp as $$
  update office_mail_accounts set status = p_status, updated_at = now()
  where id = p_account and user_id = auth.uid() and status is distinct from p_status
$$;

/** 연결 해제 — 계정·토큰 삭제(서버가 구글 쪽 권한 철회를 먼저 한다). 메일 메모 같은 기억 데이터는 이 표에 묶지 않는다 */
create or replace function public.office_mail_disconnect(p_account uuid)
returns void language sql security definer set search_path = public, pg_temp as $$
  delete from office_mail_accounts where id = p_account and user_id = auth.uid()
$$;

revoke all on function public.office_mail_connect(uuid, text, text, text, text, text), public.office_mail_secret(uuid),
  public.office_mail_token_put(uuid, text, timestamptz, text), public.office_mail_mark(uuid, text), public.office_mail_disconnect(uuid) from public, anon;
grant execute on function public.office_mail_connect(uuid, text, text, text, text, text), public.office_mail_secret(uuid),
  public.office_mail_token_put(uuid, text, timestamptz, text), public.office_mail_mark(uuid, text), public.office_mail_disconnect(uuid) to authenticated;
