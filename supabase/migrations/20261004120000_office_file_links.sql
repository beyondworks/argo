-- 오피스 15차: 문서함 파일 공유 링크(유건 결정 5, 2026-10-04 — 메일 첨부 3MB를 넘는 파일은 문서함에 올리고 받는 사람이 열 수 있는 링크를 본문에).
-- · 문서함 파일 하나에 대한 공개 링크. 토큰 원문은 DB에 두지 않는다 — 화면이 만든 무작위 토큰(32바이트)의 SHA-256만 저장한다(서명 링크 office_esign_signers.token_hash와 같은 방식).
-- · 링크로 열리는 것은 그 파일 하나뿐: 공개 서버 함수(apps/office/api/files — link·link-get, service_role)가 해시로 이 표를 찾고 파일 기록과 R2 객체(claimed)를 확인한 뒤
--   몇 분짜리 서명 주소를 만든다. 만료(기본 30일)·끊김(revoked_at)·지운 파일(휴지통 또는 영구 삭제)은 모두 같은 '열 수 없는 링크'다(어느 쪽인지 밖에 알리지 않는다).
-- · 만들기·끊기: 내 공간은 본인, 조직 공간은 그 파일을 올린 사람이나 관리자(owner·admin). 끊기는 링크를 만든 사람도. 목록 보기는 그 파일을 볼 수 있는 사람.
-- · 보존: 만료됐거나 끊은 링크 행은 기존 정리 작업(office_storage_sweep — api/files sweep, 하루 1회)이 지운다. 영구 삭제한 파일의 링크는 함께 지워진다(on delete cascade).
-- · 상한: 파일당 살아 있는 링크 20개, 사람당 1,000개. 공개 열기·내려받기는 DB 쓰기 0(stable). 이미 끊은 링크는 다시 쓰지 않는다.
-- · 부하: 메일 보내기 한 번 = 큰 파일 수만큼 insert 1. 링크 열기 = 서버 함수 1 + stable 읽기 1, 내려받기 = 서버 함수 1 + stable 읽기 1(바이트는 브라우저 ↔ R2 직접). 폴링 없음.

create table if not exists public.office_file_links (
  id uuid primary key,
  file_id uuid not null references public.office_files(id) on delete cascade,
  scope text not null check (scope ~ '^(u|o):'),                      -- 파일의 범위(권한 판정용 사본)
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  source text not null default 'manual' check (source in ('manual', 'mail')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists office_file_links_file on public.office_file_links(file_id);
create index if not exists office_file_links_owner on public.office_file_links(created_by) where revoked_at is null;
create index if not exists office_file_links_expiry on public.office_file_links(expires_at);
alter table public.office_file_links enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_file_links from anon, authenticated;

/** 만들기·끊기(로그인한 사람) — link.create {id, file_id, token_hash, days(1~90, 기본 30), source} · link.revoke {id} */
create or replace function public.office_file_link_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; f public.office_files%rowtype; l public.office_file_links%rowtype; lid uuid; h text; days integer;
begin
  select * into c from public.office_file_ctx(p_org); -- 손님·남은 file_forbidden
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'file_input'; end if;
  lid := public.office_file_uuid(p_data->>'id');
  if lid is null then raise exception 'file_input'; end if;

  if p_action = 'link.create' then
    h := lower(coalesce(p_data->>'token_hash', ''));
    if h !~ '^[0-9a-f]{64}$' then raise exception 'file_input'; end if;
    begin days := coalesce(nullif(p_data->>'days', '')::integer, 30); exception when others then raise exception 'file_input'; end;
    if days not between 1 and 90 then raise exception 'file_input'; end if;
    select * into f from public.office_files where id = public.office_file_uuid(p_data->>'file_id') and scope = c.sc and deleted_at is null;
    if not found then raise exception 'file_not_found'; end if;
    if f.kind <> 'file' then raise exception 'file_input'; end if; -- 드라이브 링크는 드라이브에서 공유한다
    if not (c.manager or f.created_by = c.who) then raise exception 'file_forbidden' using errcode = '42501'; end if;
    select * into l from public.office_file_links where id = lid;
    if found then -- 같은 요청을 다시 보낸 경우(네트워크 재시도)
      if l.token_hash = h and l.created_by = c.who and l.file_id = f.id then return jsonb_build_object('id', l.id, 'expires_at', l.expires_at); end if;
      raise exception 'file_conflict';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('office-file-link:' || c.who, 0));
    if (select count(*) from public.office_file_links where file_id = f.id and revoked_at is null and expires_at > now()) >= 20
       or (select count(*) from public.office_file_links where created_by = c.who and revoked_at is null and expires_at > now()) >= 1000 then raise exception 'file_limit'; end if;
    insert into public.office_file_links(id, file_id, scope, token_hash, source, created_by, expires_at)
      values (lid, f.id, c.sc, h, case when p_data->>'source' = 'mail' then 'mail' else 'manual' end, c.who, clock_timestamp() + make_interval(days => days))
      returning * into l;
    return jsonb_build_object('id', l.id, 'expires_at', l.expires_at);

  elsif p_action = 'link.revoke' then
    select * into l from public.office_file_links where id = lid and scope = c.sc;
    if not found then raise exception 'file_not_found'; end if;
    select * into f from public.office_files where id = l.file_id;
    if not (c.manager or l.created_by = c.who or f.created_by = c.who) then raise exception 'file_forbidden' using errcode = '42501'; end if;
    update public.office_file_links set revoked_at = clock_timestamp() where id = lid and revoked_at is null; -- 이미 끊은 링크는 다시 쓰지 않는다
    return jsonb_build_object('id', lid);
  end if;
  raise exception 'file_input';
exception when unique_violation then raise exception 'file_conflict';
end $$;

/** 파일 상세의 살아 있는 링크 — 그 파일을 볼 수 있는 사람. can: 만들기·끊기를 할 수 있나(관리자·내 공간·올린 사람) */
create or replace function public.office_file_link_list(p_org uuid, p_file uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; f public.office_files%rowtype;
begin
  select * into c from public.office_file_ctx(p_org);
  select * into f from public.office_files where id = p_file and scope = c.sc;
  if not found then raise exception 'file_not_found'; end if;
  return jsonb_build_object('can', c.manager or f.created_by = c.who,
    'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'source', l.source, 'created_at', l.created_at, 'expires_at', l.expires_at,
        'mine', l.created_by = c.who) order by l.created_at desc)
      from public.office_file_links l where l.file_id = f.id and l.revoked_at is null and l.expires_at > now()), '[]'::jsonb));
end $$;

/** 공개 열기(서버 함수 전용 — service_role). p_hash = 링크 토큰의 SHA-256. 열 수 있으면 이름·크기·형식·R2 키(서버만 쓴다), 아니면 null.
 *  열 수 있는 조건: 끊지 않았고 만료 전, 파일이 휴지통·영구 삭제가 아니고, 객체가 기록이 가진(claimed) 상태 */
create or replace function public.office_file_link_open(p_hash text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('name', coalesce(nullif(f.filename, ''), f.title), 'size', o.bytes, 'mime', f.mime, 'key', f.storage_path, 'expires_at', l.expires_at,
      'org', case when l.scope like 'o:%' then (select g.name from public.msgr_orgs g where g.id = substr(l.scope, 3)::uuid) end)
  from public.office_file_links l
  join public.office_files f on f.id = l.file_id and f.scope = l.scope
  join public.r2_objects o on o.bucket = 'argo-office' and o.key = f.storage_path and o.state = 'claimed'
  where p_hash ~ '^[0-9a-f]{64}$' and l.token_hash = p_hash and l.revoked_at is null and l.expires_at > now()
    and f.deleted_at is null and f.kind = 'file'
$$;

-- ── 서버 정리(20261002201700 정의 + 만료·끊은 링크 행 지우기). 나머지 동작·권한은 그대로 ──
create or replace function public.office_storage_sweep(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare lim integer := least(greatest(coalesce(p_limit, 500), 1), 1000); links integer;
begin
  delete from public.office_ocr_usage where hour < now() - interval '1 day';
  with d as (delete from public.office_files where id in (select id from public.office_files where deleted_at < now() - interval '30 days' order by deleted_at limit lim)
      returning storage_path)
  update public.r2_objects set state = 'deleting', updated_at = clock_timestamp()
    where bucket = 'argo-office' and key in (select storage_path from d where storage_path is not null) and state <> 'deleting';
  update public.r2_objects set state = 'deleting', updated_at = clock_timestamp()
    where (bucket, key) in (select bucket, key from public.r2_objects where bucket = 'argo-office'
      and ((state = 'pending' and expires_at < now() - interval '1 hour') or (state = 'uploaded' and updated_at < now() - interval '1 hour')) limit lim);
  -- 15차: 만료됐거나 끊은 공유 링크 행(다시 열 수 없는 행 — 보존할 이유가 없다). 한 번에 최대 lim×10개
  with x as (delete from public.office_file_links where id in (select id from public.office_file_links where expires_at < now() or revoked_at is not null limit lim * 10) returning 1)
  select count(*) into links from x;
  return jsonb_build_object('keys', coalesce((select jsonb_agg(x.key) from (select key from public.r2_objects where bucket = 'argo-office' and state = 'deleting' order by updated_at limit lim) x), '[]'::jsonb),
    'links', links);
end $$;

revoke all on function public.office_file_link_write(uuid, text, jsonb), public.office_file_link_list(uuid, uuid), public.office_file_link_open(text), public.office_storage_sweep(integer) from public, anon, authenticated;
grant execute on function public.office_file_link_write(uuid, text, jsonb), public.office_file_link_list(uuid, uuid) to authenticated;
grant execute on function public.office_file_link_open(text), public.office_storage_sweep(integer) to service_role;
