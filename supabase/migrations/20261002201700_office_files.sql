-- 오피스 문서함·거래처 파일·구글 드라이브 연결(유건 10/2 — 인트라넷 문서함·드라이브·거래처 첨부 이식, 트랙 B).
-- · 파일 바이트는 Cloudflare R2 버킷 argo-office(총괄 승인 10/2 — Supabase Storage를 쓰지 않는다). 키 '<범위>/files/<파일 id>.<확장자>'
--   범위 = 'o-<조직 id>'(조직 — 손님 제외 멤버) | 'u-<사람 id>'(내 공간 — 본인만). 키는 서버(DB 함수)가 정하고, 파일 이름은 키에 넣지 않는다(이름은 filename 칸).
--   객체는 고치지 않는다(새로 올리기만 — 서명 주소에 if-none-match: *).
-- · 브라우저와 R2가 바이트를 직접 주고받는다. 서명 주소는 오피스 서버 함수(apps/office/api/storage)가 만들고, **이 파일의 DB 함수가 허락한 키만** 서명한다
--   (r2_object_pending_mine — 올리기, r2_object_read_grant — 열기). 실제 크기는 서버가 R2 HEAD로 보고 r2_object_commit(service_role)으로 적는다.
-- · R2 객체 목록 r2_objects(3앱 공용 이름 — bucket 칸): 모든 객체가 행을 먼저 갖는다(pending → uploaded → claimed → deleting → 행 삭제).
--   용량은 이 표의 bytes 합, 남은 객체 찾기도 이 표로 — 행 없는 객체는 생기지 않게 "행 먼저, PUT 다음, 상태 바꾸기" 순서를 지킨다.
-- · 기록은 office_files 한 표 — 문서함·거래처 파일(customer_id)·견적·계약·서명본(트랙 A, source 'generated'·'esign')·드라이브 링크(kind 'link').
--   표는 함수로만 읽고 쓴다(정책 없음 — office_assets와 같은 방식). 검색은 제목·파일명·추출 본문(OCR·문서 글자).
-- · 삭제: 영구 삭제·문서 삭제는 기록을 지우면서 객체 행을 deleting으로 바꾸고(한 트랜잭션), 화면이 서버 함수 flush를 부르면 R2에서 지운 뒤 행을 없앤다.
--   보존: 휴지통 30일 뒤 정리(유건 승인 값 2026-09-26 — 페이지 휴지통과 같다). 정리는 서버 크론만 한다(api/files sweep — Vercel 크론 하루 1회,
--   또는 scripts/files-sweep.mjs, 서비스 키): office_storage_sweep이 ① 휴지통 30일 행 삭제 + deleting ② 만료된 올리기 자리(pending) ③ 1시간 넘게
--   등록 안 된 객체(uploaded) ④ deleting 목록을 주고, 서버가 R2에서 지운 뒤 r2_object_forget으로 행을 지운다. R2 삭제가 실패한 행은 남아 다음 날 다시.
--   OCR 글자는 행 안에만 둔다(따로 쌓이는 표 없음).
-- · 용량: 범위마다 오피스 R2 객체(문서함 + 문서 PDF·서명 파일) 크기 합 상한 — 숫자 자리 office_storage_quota(지금 값: 조직 10GiB, 내 공간 1GiB).
--   올리기 자리(pending)를 받을 때 (범위의 올라온 객체 합 + 열린 자리 + 이번 크기)가 상한을 넘으면 거절. 사람당 열린 자리 50개.
--   서버가 쓰는 객체(서명 그림·서명본)는 용량에 들어가지만 막지는 않는다(조직이 가득 차도 서명자의 서명이 실패하지 않게 — 총괄 결정 5).
--   하루 상한·플랫폼 예산 숫자 자리 office_storage_limits — 전부 미정(null). 귀속(올린 사람 vs 조직 풀)·3앱 범위도 미정 — seg·created_by·bucket 칸을 둘 다 둔다.
-- · 크기·출처(분리 검수 LOW 6): 크기는 서버가 R2 HEAD로 확인한 크기(r2_objects.bytes). 출처는 서버가 정한다 — 'esign'은 같은 범위의 완료된 서명(ref_esign,
--   서명본과 같은 크기), 'generated'는 같은 범위의 견적·계약 문서(ref_doc)가 있을 때만. 클라이언트는 upload·mail·agent만 고를 수 있다.
--   같은 서명본은 문서함에 한 번만(ref_id 유일 — 두 관리자가 동시에 넣어도, 분리 검수 LOW 4).
-- · 서버 OCR 한도(분리 검수 HIGH 1): 사람마다 시간당 60회(office_ocr_usage — 한 시간 한 줄, 하루 지난 줄은 쓸 때·정리 때 지운다).
-- · 부하(DB 위생): 폴링·심박 없음. 올리기 1건 = 자리 insert 1 + 상태 update 2(commit·등록) + 기록 insert 1. 열기는 DB 쓰기 0
--   (r2_object_read_grant는 stable — 다운로드 측정은 꺼 둠, 아래 설계 주석). 정리는 서버 하루 1회(한 번에 최대 500개).
-- · 구글 드라이브 토큰: office_drive_accounts/secrets — 메일과 같은 봉인 방식(OFFICE_MAIL_KEY, 사람·주소 AAD). 사람당 한 계정.

-- ── R2 객체 목록(3앱 공용 이름 — 메신저 argo-msgr·본체 argo-sync가 같은 표를 쓰면 bucket 칸으로 나눈다. 오피스 함수는 'argo-office'만 본다) ──
create table if not exists public.r2_objects (
  bucket text not null check (bucket ~ '^argo-[a-z]{2,20}$'),   -- 논리 버킷 이름(실제 버킷 이름은 서버 환경 변수 R2_OFFICE_BUCKET)
  key text not null check (length(key) between 1 and 1024 and key !~ '(^/|\.\.|//)'),
  seg text not null check (length(seg) <= 64),                     -- 범위 첫 칸('o-<조직>'|'u-<사람>') — 조직 풀로 셀 때
  created_by uuid,                                                 -- 올린 사람(서버가 쓴 서명 그림·서명본은 null) — 사람별로 셀 때
  bytes bigint not null check (bytes >= 0),                        -- pending: 신고 크기 / 그 뒤: 서버가 R2 HEAD로 확인한 크기(또는 서버가 직접 보낸 크기)
  mime text not null default '' check (length(mime) <= 200),
  state text not null check (state in ('pending', 'uploaded', 'claimed', 'deleting')),
  ref_kind text check (ref_kind in ('file', 'doc', 'esign')),
  ref_id uuid,
  etag text check (length(etag) <= 200),
  expires_at timestamptz,                                          -- pending 만료(서명 주소 5분 + 여유)
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (bucket, key)
);
create index if not exists r2_objects_seg on public.r2_objects(bucket, seg, state);
create index if not exists r2_objects_user on public.r2_objects(created_by, state, expires_at);
create index if not exists r2_objects_state on public.r2_objects(state, updated_at);
alter table public.r2_objects enable row level security; -- 정책 없음: 함수로만
revoke all on public.r2_objects from anon, authenticated;

/** 범위 용량 상한(바이트) — 숫자 자리(지금 값 그대로: 조직 10GiB, 내 공간 1GiB — 분리 검수 MEDIUM 1). 요금제·귀속이 정해지면 여기와 office_storage_used만 바꾼다 */
create or replace function public.office_storage_quota(p_seg text) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case when p_seg like 'o-%' then 10737418240::bigint else 1073741824::bigint end
$$;
/** 하루 상한·플랫폼 예산 — 숫자 자리, 전부 미정(null = 제한 없음, 총괄 10/2). 정해지면 여기만 바꾼다.
 *  daily_upload_*: office_storage_reserve가 r2_objects(올린 사람·오늘 만든 행)로 센다 — 따로 쓰는 표가 없어 쓰기 0.
 *  daily_download_grants_per_user·platform_*: 다운로드 측정을 켤 때 쓴다(지금은 꺼 둠 — 아래 '다운로드 측정' 설계 주석). */
create or replace function public.office_storage_limits() returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select jsonb_build_object('daily_upload_bytes_per_user', null, 'daily_upload_count_per_user', null, 'daily_download_grants_per_user', null,
    'platform_monthly_upload_bytes', null, 'platform_stored_bytes', null, 'platform_monthly_read_grants', null)
$$;
/** 범위가 쓰는 크기 — 그 범위의 올라온 객체(uploaded·claimed, 서버가 쓴 객체 포함) bytes 합. 귀속을 '올린 사람'으로 정하면 seg = 를 created_by = 로 바꾼다 */
create or replace function public.office_storage_used(p_seg text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(o.bytes), 0)::bigint from public.r2_objects o where o.bucket = 'argo-office' and o.seg = p_seg and o.state in ('uploaded', 'claimed')
$$;
/** 열린 올리기 자리 크기 — p_except 키는 빼고(등록 때 다시 셀 때) */
create or replace function public.office_storage_open(p_seg text, p_except text default null) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(o.bytes), 0)::bigint from public.r2_objects o
  where o.bucket = 'argo-office' and o.seg = p_seg and o.state = 'pending' and o.expires_at > now() and o.key is distinct from p_except
$$;
/** 서명에 넣을 형식 — 'type/subtype'만(매개변수·줄바꿈 없음), 아니면 application/octet-stream */
create or replace function public.office_storage_mime(p text) returns text
language sql immutable set search_path = public, pg_temp as $$
  select case when coalesce(p, '') ~ '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$' then lower(p) else 'application/octet-stream' end
$$;
/** 올리기 자리(pending 행) — 부른 사람이 그 범위에 쓸 수 있는지는 부르는 쪽(office_file_write·office_docs_write)이 먼저 확인하고, 키도 부르는 쪽이 정한다.
 *  지난 자리는 여기서 지우지 않는다 — R2에 객체가 남아 있을 수 있어, 정리 크론이 R2를 지운 뒤에만 행을 지운다(지우면 남은 객체를 찾을 근거가 없어진다) */
create or replace function public.office_storage_reserve(p_key text, p_seg text, p_bytes bigint, p_mime text, p_max bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); o public.r2_objects%rowtype; lim jsonb := public.office_storage_limits(); day_bytes bigint; day_n bigint;
begin
  if who is null then raise exception 'file_forbidden' using errcode = '42501'; end if;
  if p_bytes is null or p_bytes < 0 or p_bytes > p_max or split_part(coalesce(p_key, ''), '/', 1) <> p_seg or p_key like '%..%' or p_key like '%//%' or length(p_key) > 600 then raise exception 'file_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('office-storage:' || p_seg, 0));
  select * into o from public.r2_objects where bucket = 'argo-office' and key = p_key;
  if found then
    if o.state = 'pending' and o.created_by = who and o.expires_at > now() and o.bytes = p_bytes then return; end if; -- 같은 요청 다시
    raise exception 'file_conflict';
  end if;
  if (select count(*) from public.r2_objects where created_by = who and state = 'pending' and expires_at > now()) >= 50 then raise exception 'file_limit'; end if;
  if lim->>'daily_upload_bytes_per_user' is not null or lim->>'daily_upload_count_per_user' is not null then -- 숫자가 정해질 때만 센다(지금은 모두 null)
    select coalesce(sum(bytes), 0), count(*) into day_bytes, day_n from public.r2_objects where created_by = who and created_at >= date_trunc('day', now());
    if day_bytes + p_bytes > coalesce((lim->>'daily_upload_bytes_per_user')::bigint, 9223372036854775807)
       or day_n + 1 > coalesce((lim->>'daily_upload_count_per_user')::bigint, 9223372036854775807) then raise exception 'file_daily_limit'; end if;
  end if;
  if public.office_storage_used(p_seg) + public.office_storage_open(p_seg) + p_bytes > public.office_storage_quota(p_seg) then raise exception 'file_quota'; end if;
  insert into public.r2_objects(bucket, key, seg, created_by, bytes, mime, state, expires_at)
    values ('argo-office', p_key, p_seg, who, p_bytes, public.office_storage_mime(p_mime), 'pending', now() + interval '15 minutes');
end $$;
/** 등록 때 다시 세기 — 이미 올라온 이 객체를 포함한 합 + (이 자리를 뺀) 열린 자리가 상한 안인가 */
create or replace function public.office_storage_fits(p_key text, p_seg text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.office_storage_used(p_seg) + public.office_storage_open(p_seg, p_key) <= public.office_storage_quota(p_seg)
$$;
/** 기록이 객체를 가져간다(uploaded → claimed) — 내가 올린, 이 범위의 객체만. 같은 기록으로 다시 부르면 그대로(재시도). 돌려주는 값 = 실제 크기 */
create or replace function public.office_storage_claim(p_key text, p_seg text, p_kind text, p_id uuid) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.r2_objects%rowtype;
begin
  select * into o from public.r2_objects where bucket = 'argo-office' and key = p_key for update;
  if not found or o.seg <> p_seg or o.state not in ('uploaded', 'claimed') then raise exception 'file_missing'; end if;
  if o.created_by is distinct from auth.uid() then raise exception 'file_forbidden' using errcode = '42501'; end if; -- 남이 올린 객체
  if o.state = 'claimed' then
    if o.ref_kind = p_kind and o.ref_id = p_id then return o.bytes; end if;
    raise exception 'file_conflict';
  end if;
  update public.r2_objects set state = 'claimed', ref_kind = p_kind, ref_id = p_id, expires_at = null, updated_at = clock_timestamp() where bucket = 'argo-office' and key = p_key;
  return o.bytes;
end $$;
/** 지우기로 정한 객체 — 기록을 지우는 같은 트랜잭션에서 deleting으로(용량에서 바로 빠진다). R2 삭제는 서버(flush·정리 크론)가 한다 */
create or replace function public.office_storage_tombstone(p_keys text[]) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.r2_objects set state = 'deleting', updated_at = clock_timestamp() where bucket = 'argo-office' and key = any(coalesce(p_keys, '{}')) and state <> 'deleting'
$$;
/** 범위를 읽을 수 있나 — 내 공간은 본인, 조직은 손님 아닌 멤버(문서함·문서 모두 같은 기준) */
create or replace function public.office_storage_seg_ok(p_seg text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare org uuid; r text;
begin
  if auth.uid() is null or p_seg is null then return false; end if;
  if p_seg = 'u-' || auth.uid() then return true; end if;
  if p_seg !~ '^o-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  org := substr(p_seg, 3)::uuid;
  r := public.msgr_role(org);
  return r is not null and r <> 'guest';
end $$;
revoke all on function public.office_storage_quota(text), public.office_storage_limits(), public.office_storage_used(text), public.office_storage_open(text, text),
  public.office_storage_mime(text), public.office_storage_reserve(text, text, bigint, text, bigint), public.office_storage_fits(text, text),
  public.office_storage_claim(text, text, text, uuid), public.office_storage_tombstone(text[]), public.office_storage_seg_ok(text) from public, anon, authenticated; -- 내부용

-- ── 서버 함수(apps/office/api/storage)가 서명 전에 부르는 판정 — 사용자 JWT로. 둘 다 stable(DB 쓰기 0 — 열 때마다 쓰지 않는다) ──
/** 올리기: 내가 받은, 아직 지나지 않은 자리(pending)나 방금 확인된 객체(uploaded) — 서버는 이 결과의 key·bytes·mime으로만 서명한다(요청 본문 값을 쓰지 않는다) */
create or replace function public.r2_object_pending_mine(p_key text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('key', o.key, 'bytes', o.bytes, 'mime', o.mime, 'state', o.state) from public.r2_objects o
  where o.bucket = 'argo-office' and o.key = p_key and auth.uid() is not null and o.created_by = auth.uid()
    and ((o.state = 'pending' and o.expires_at > now()) or o.state = 'uploaded')
$$;
/** 열기: 요청한 키 중 읽어도 되는 것만(최대 50개) — 기록이 가져간 객체(claimed)는 그 범위를 읽을 수 있는 사람, 아직 등록 전(uploaded)은 올린 사람만.
 *  지우기로 정한 객체(deleting)·자리(pending)는 주지 않는다 */
create or replace function public.r2_object_read_grant(p_keys text[]) returns text[]
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'file_forbidden' using errcode = '42501'; end if;
  if p_keys is null or cardinality(p_keys) > 50 then raise exception 'file_input'; end if;
  return coalesce((select array_agg(o.key order by o.key) from public.r2_objects o
    where o.bucket = 'argo-office' and o.key = any(p_keys)
      and ((o.state = 'claimed' and public.office_storage_seg_ok(o.seg)) or (o.state = 'uploaded' and o.created_by = auth.uid()))), '{}');
end $$;

-- ── 서버만(service_role) — 상태만 바꾼다. 권한 판정은 그 전에 사용자 JWT 함수가 했다 ──
/** 올린 뒤 확인: 서버가 R2 HEAD로 본 크기가 자리 크기와 같을 때만 uploaded. 다시 불러도 쓰지 않는다 */
create or replace function public.r2_object_commit(p_key text, p_bytes bigint, p_etag text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.r2_objects%rowtype;
begin
  select * into o from public.r2_objects where bucket = 'argo-office' and key = p_key for update;
  if not found then raise exception 'file_missing'; end if;
  if o.state = 'uploaded' and o.bytes = p_bytes then return jsonb_build_object('state', o.state, 'bytes', o.bytes); end if;
  if o.state <> 'pending' or o.expires_at <= now() then raise exception 'file_missing'; end if;
  if p_bytes is distinct from o.bytes then raise exception 'file_size_mismatch'; end if;
  update public.r2_objects set state = 'uploaded', etag = left(p_etag, 200), expires_at = null, updated_at = clock_timestamp() where bucket = 'argo-office' and key = p_key;
  return jsonb_build_object('state', 'uploaded', 'bytes', o.bytes);
end $$;
/** 실패 정리: 서버가 R2에서 지운 뒤, 아직 기록이 가져가지 않은 행(pending·uploaded)만 지운다 */
create or replace function public.r2_object_fail(p_keys text[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.r2_objects where bucket = 'argo-office' and key = any(coalesce(p_keys, '{}')) and state in ('pending', 'uploaded');
  get diagnostics n = row_count;
  return n;
end $$;
/** 서버가 직접 쓰는 객체(서명 그림·서명본·드라이브 가져오기 아님 — 그것은 사용자 자리) — PUT 전에 pending, 뒤에 uploaded·claimed.
 *  용량에는 들어가지만 막지 않는다(총괄 결정 5). 지우기로 정한 행(deleting)은 되살리지 않는다 */
create or replace function public.r2_object_server_put(p_key text, p_seg text, p_bytes bigint, p_mime text, p_state text, p_ref_kind text default null, p_ref_id uuid default null, p_etag text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_state not in ('pending', 'uploaded', 'claimed') or p_bytes is null or p_bytes < 0 or split_part(coalesce(p_key, ''), '/', 1) <> p_seg
     or p_seg !~ '^[ou]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or p_key like '%..%' then raise exception 'file_input'; end if;
  if exists (select 1 from public.r2_objects where bucket = 'argo-office' and key = p_key and state = 'deleting') then raise exception 'file_conflict'; end if;
  insert into public.r2_objects as t(bucket, key, seg, created_by, bytes, mime, state, ref_kind, ref_id, etag, expires_at)
    values ('argo-office', p_key, p_seg, null, p_bytes, public.office_storage_mime(p_mime), p_state, p_ref_kind, p_ref_id, left(p_etag, 200),
      case when p_state = 'pending' then now() + interval '15 minutes' end)
  on conflict (bucket, key) do update set bytes = excluded.bytes, mime = excluded.mime, state = excluded.state, ref_kind = excluded.ref_kind, ref_id = excluded.ref_id,
    etag = excluded.etag, expires_at = excluded.expires_at, updated_at = clock_timestamp()
  where (t.bytes, t.mime, t.state, t.ref_kind, t.ref_id, t.etag) is distinct from (excluded.bytes, excluded.mime, excluded.state, excluded.ref_kind, excluded.ref_id, excluded.etag);
end $$;
/** 요청한 키 중 지우기로 정한 것만(flush가 R2에서 지울 목록) */
create or replace function public.r2_object_deleting(p_keys text[]) returns text[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(o.key order by o.key), '{}') from public.r2_objects o where o.bucket = 'argo-office' and o.key = any(coalesce(p_keys, '{}')) and o.state = 'deleting'
$$;
/** R2에서 지운 뒤 행 지우기 — deleting 행만(없는 행은 0건) */
create or replace function public.r2_object_forget(p_keys text[]) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.r2_objects where bucket = 'argo-office' and key = any(coalesce(p_keys, '{}')) and state = 'deleting';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.r2_object_pending_mine(text), public.r2_object_read_grant(text[]), public.r2_object_commit(text, bigint, text), public.r2_object_fail(text[]),
  public.r2_object_server_put(text, text, bigint, text, text, text, uuid, text), public.r2_object_deleting(text[]), public.r2_object_forget(text[]) from public, anon, authenticated;
grant execute on function public.r2_object_pending_mine(text), public.r2_object_read_grant(text[]) to authenticated;
grant execute on function public.r2_object_commit(text, bigint, text), public.r2_object_fail(text[]), public.r2_object_server_put(text, text, bigint, text, text, text, uuid, text),
  public.r2_object_deleting(text[]), public.r2_object_forget(text[]) to service_role;

-- ── 다운로드 측정(꺼 둠 — 총괄 결정 6, 10/2) ──
-- 열 때마다 DB에 쓰지 않는다(r2_object_read_grant는 stable이라 쓰기를 넣으면 실행 오류로 드러난다 — test/office-files-pg.test.mjs가 잠근다).
-- 켜기로 정하면 새 마이그레이션으로 아래를 만들고, read_grant를 volatile로 바꿔 허락한 키 수·bytes 합을 사람·하루 한 행에 더한다.
--   create table office_storage_usage(user_id uuid, day date, up_bytes bigint, up_n int, down_bytes bigint, down_n int, primary key (user_id, day));
--   보존 90일(정리 크론이 지운다 — 사람당 하루 1행, 1,000명 × 90일 = 9만 행 상한). 부하(켰을 때): 1,000명 × 하루 50회 열기 = 분당 약 35건 upsert.
--   플랫폼 합계는 하루 1회 크론이 한 줄 표(office_storage_platform)에 바뀔 때만 쓴다 — daily_download_grants_per_user·platform_* 상한은 그때 쓴다.

-- ── 서버 OCR 한도(사람마다 시간당 60회) ──
create table if not exists public.office_ocr_usage (
  user_id uuid not null,
  hour timestamptz not null,
  n integer not null default 0 check (n between 0 and 1000),
  primary key (user_id, hour)
);
alter table public.office_ocr_usage enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_ocr_usage from anon, authenticated;
/** OCR 한 번 쓰기 — 한도 안이면 true(이번 시간 줄 +1), 넘으면 false(쓰지 않는다). 하루 지난 내 줄은 여기서 지운다 */
create or replace function public.office_ocr_take() returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); h timestamptz := date_trunc('hour', now()); cnt integer;
begin
  if who is null then raise exception 'file_forbidden' using errcode = '42501'; end if;
  delete from public.office_ocr_usage where user_id = who and hour < h - interval '1 day';
  insert into public.office_ocr_usage as u (user_id, hour, n) values (who, h, 1)
    on conflict (user_id, hour) do update set n = u.n + 1 where u.n < 60
    returning n into cnt;
  return cnt is not null;
end $$;
revoke all on function public.office_ocr_take() from public, anon;
grant execute on function public.office_ocr_take() to authenticated;

-- ── 표 ──
create table if not exists public.office_file_folders (
  id uuid primary key,
  scope text not null check (scope ~ '^(u|o):'),
  parent_id uuid references public.office_file_folders(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists office_file_folders_scope on public.office_file_folders(scope);

create table if not exists public.office_files (
  id uuid primary key,
  scope text not null check (scope ~ '^(u|o):'),
  folder_id uuid references public.office_file_folders(id) on delete set null,
  kind text not null check (kind in ('file', 'link')),
  title text not null check (length(btrim(title)) between 1 and 300),
  filename text not null default '' check (length(filename) <= 300),
  mime text not null default '' check (length(mime) <= 200),
  size bigint not null default 0 check (size between 0 and 52428800),
  storage_path text unique check (storage_path is null or length(storage_path) <= 600), -- R2 키(r2_objects.key)
  link_url text check (link_url is null or (link_url ~* '^https://[^\s]+$' and length(link_url) <= 2000)),
  source text not null default 'upload' check (source in ('upload', 'drive', 'generated', 'esign', 'mail', 'agent')),
  drive_id text check (drive_id is null or drive_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  category text not null default 'general' check (category in ('quote', 'contract', 'bizcert', 'card', 'bankbook', 'evidence', 'archive', 'general')),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  customer_id uuid references public.office_business_customers(id) on delete set null,
  deal_id uuid references public.office_business_orders(id) on delete set null,
  ref_id uuid,                                                   -- 서버가 확인한 원본(서명 ref_esign · 견적·계약 문서 ref_doc)
  ocr_status text not null default 'none' check (ocr_status in ('none', 'pending', 'done', 'failed', 'unsupported')),
  summary text not null default '' check (length(summary) <= 1900),
  full_text text not null default '' check (length(full_text) <= 100000),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  check ((kind = 'file') = (storage_path is not null)),
  check ((kind = 'link') = (link_url is not null))
);
create index if not exists office_files_scope_live on public.office_files(scope, created_at desc) where deleted_at is null;
create index if not exists office_files_scope_trash on public.office_files(scope, deleted_at) where deleted_at is not null;
create index if not exists office_files_customer on public.office_files(customer_id) where customer_id is not null;
create unique index if not exists office_files_signed_once on public.office_files(ref_id) where source = 'esign'; -- 같은 서명본은 한 번만(분리 검수 LOW 4)
-- ponytail: 검색은 범위 안 ilike(범위당 수천 건 가정). 범위가 수만 건이 되면 pg_trgm 색인을 더한다

alter table public.office_files enable row level security;        -- 정책 없음: 함수로만
alter table public.office_file_folders enable row level security;
revoke all on public.office_files, public.office_file_folders from anon, authenticated;

-- ── 공통 ──
create or replace function public.office_file_uuid(p text) returns uuid
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p is null or p = '' then return null; end if;
  return p::uuid;
exception when others then raise exception 'file_input';
end $$;

/** 부른 사람 기준 범위 — sc('o:<조직>'|'u:<사람>'), seg(R2 키 첫 칸), manager(조직 관리자 또는 내 공간) */
create or replace function public.office_file_ctx(p_org uuid, out who uuid, out sc text, out seg text, out manager boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text;
begin
  who := auth.uid();
  if who is null then raise exception 'file_forbidden' using errcode = '42501'; end if;
  if p_org is null then sc := 'u:' || who; seg := 'u-' || who; manager := true; return; end if;
  r := public.msgr_role(p_org);
  if r is null or r = 'guest' then raise exception 'file_forbidden' using errcode = '42501'; end if;
  sc := 'o:' || p_org; seg := 'o-' || p_org; manager := r in ('owner', 'admin');
end $$;

create or replace function public.office_file_json(f public.office_files, p_full boolean default false) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', f.id, 'folder_id', f.folder_id, 'kind', f.kind, 'title', f.title, 'filename', f.filename, 'mime', f.mime, 'size', f.size,
    'storage_path', f.storage_path, 'link_url', f.link_url, 'source', f.source, 'drive_id', f.drive_id, 'category', f.category, 'tags', to_jsonb(f.tags),
    'customer_id', f.customer_id, 'deal_id', f.deal_id, 'ocr_status', f.ocr_status, 'created_by', f.created_by, 'created_at', f.created_at,
    'updated_at', f.updated_at, 'deleted_at', f.deleted_at,
    -- 목록에는 요약 앞 200자만(열 때 office_file_get으로 요약·전문) — 목록을 열 때마다 본문 전체를 내려받지 않게
    'summary', case when p_full then f.summary else left(f.summary, 200) end)
  || case when p_full then jsonb_build_object('full_text', f.full_text) else '{}'::jsonb end
$$;

-- 거래처·거래·폴더가 같은 범위인지(남의 범위 id로 묶지 못하게)
create or replace function public.office_file_refs(p_sc text, p_customer uuid, p_deal uuid, p_folder uuid) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_customer is not null and not exists (select 1 from public.office_business_customers where id = p_customer and scope = p_sc) then raise exception 'file_input'; end if;
  if p_deal is not null and not exists (select 1 from public.office_business_orders where id = p_deal and scope = p_sc) then raise exception 'file_input'; end if;
  if p_folder is not null and not exists (select 1 from public.office_file_folders where id = p_folder and scope = p_sc) then raise exception 'file_input'; end if;
end $$;

create or replace function public.office_file_tags(p jsonb) returns text[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare out text[];
begin
  if p is null or jsonb_typeof(p) = 'null' then return '{}'; end if;
  if jsonb_typeof(p) <> 'array' then raise exception 'file_input'; end if;
  select coalesce(array_agg(distinct btrim(x)), '{}') into out from jsonb_array_elements_text(p) x where btrim(x) <> '';
  if cardinality(out) > 20 or exists (select 1 from unnest(out) t where length(t) > 40) then raise exception 'file_input'; end if;
  return out;
end $$;

-- ── 목록 ── p_q: 제목·파일명·본문 검색, p_trash: 휴지통, p_customer: 그 거래처 파일만(거래처 카드)
create or replace function public.office_file_list(p_org uuid, p_q text default null, p_trash boolean default false, p_customer uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; q text := nullif(btrim(coalesce(p_q, '')), ''); pat text; rows jsonb; n int;
begin
  select * into c from public.office_file_ctx(p_org);
  if length(q) > 200 then raise exception 'file_input'; end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select coalesce(jsonb_agg(public.office_file_json(f) order by coalesce(f.deleted_at, f.created_at) desc), '[]'::jsonb), count(*) into rows, n
    from (select * from public.office_files f where f.scope = c.sc
            and (case when p_trash then f.deleted_at is not null else f.deleted_at is null end)
            and (p_customer is null or f.customer_id = p_customer)
            and (q is null or f.title ilike pat or f.filename ilike pat or f.full_text ilike pat or array_to_string(f.tags, ' ') ilike pat)
          order by coalesce(f.deleted_at, f.created_at) desc limit 1001) f;
  return jsonb_build_object(
    'files', case when n > 1000 then rows - 1000 else rows end, 'more', n > 1000, -- ponytail: 1000건까지, 넘으면 검색으로 좁힌다
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'parent_id', d.parent_id, 'name', d.name, 'created_by', d.created_by) order by d.name)
      from public.office_file_folders d where d.scope = c.sc), '[]'::jsonb),
    'bytes', coalesce((select sum(size) from public.office_files where scope = c.sc), 0),
    'manager', c.manager, 'me', c.who);
end $$;

create or replace function public.office_file_get(p_org uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; f public.office_files%rowtype;
begin
  select * into c from public.office_file_ctx(p_org);
  select * into f from public.office_files where id = p_id and scope = c.sc;
  if not found then raise exception 'file_not_found'; end if;
  return public.office_file_json(f, true);
end $$;

-- ── 쓰기 ──
create or replace function public.office_file_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; fid uuid; f public.office_files%rowtype; ids uuid[]; ttl text; nm text; par uuid; done uuid[]; cat text;
  obj_size bigint; src text; ref uuid; ref_size bigint; slot_bytes bigint; k text; obj public.r2_objects%rowtype; keys text[];
begin
  select * into c from public.office_file_ctx(p_org);
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 450000 then raise exception 'file_input'; end if;
  cat := coalesce(nullif(p_data->>'category', ''), 'general');

  if p_action = 'file.reserve' then -- 올리기 자리(R2 키·크기·형식) — 키는 서버가 정한다(<범위>/files/<id>.<확장자>, 이름은 넣지 않는다)
    fid := public.office_file_uuid(p_data->>'id');
    if fid is null then raise exception 'file_input'; end if;
    if exists (select 1 from public.office_files where id = fid) then raise exception 'file_conflict'; end if;
    begin slot_bytes := (p_data->>'size')::bigint; exception when others then raise exception 'file_input'; end;
    k := c.seg || '/files/' || fid || coalesce('.' || lower(substring(coalesce(p_data->>'filename', '') from '\.([A-Za-z0-9]{1,8})$')), '');
    perform public.office_storage_reserve(k, c.seg, slot_bytes, p_data->>'mime', 52428800);
    return jsonb_build_object('key', k, 'path', k);

  elsif p_action in ('file.create', 'link.create') then
    fid := public.office_file_uuid(p_data->>'id');
    ttl := btrim(coalesce(p_data->>'title', ''));
    if fid is null or length(ttl) not between 1 and 300 then raise exception 'file_input'; end if;
    perform public.office_file_refs(c.sc, public.office_file_uuid(p_data->>'customer_id'), public.office_file_uuid(p_data->>'deal_id'), public.office_file_uuid(p_data->>'folder_id'));
    if exists (select 1 from public.office_files where id = fid) then -- 같은 요청을 다시 보낸 경우(네트워크 재시도)
      if exists (select 1 from public.office_files where id = fid and scope = c.sc and created_by = c.who) then return jsonb_build_object('id', fid); end if;
      raise exception 'file_conflict';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('office-file-limit:' || c.sc, 0));
    if (select count(*) from public.office_files where scope = c.sc) >= 20000 then raise exception 'file_limit'; end if; -- 범위당 상한(휴지통 포함)
    if p_action = 'file.create' then
      -- 올린 객체가 이 범위·이 id 키로 R2에 확인돼 있어야 한다(서버가 HEAD로 확인한 uploaded — 남의 키·없는 파일을 등록하지 못하게)
      k := coalesce(p_data->>'storage_path', '');
      if k !~ ('^' || c.seg || '/files/' || fid || '(\.[a-z0-9]{1,8})?$') then raise exception 'file_input'; end if;
      select * into obj from public.r2_objects o where o.bucket = 'argo-office' and o.key = k;
      if not found or obj.state not in ('uploaded', 'claimed') then raise exception 'file_missing'; end if;
      if obj.created_by is distinct from c.who then raise exception 'file_forbidden' using errcode = '42501'; end if;
      -- 크기는 서버가 확인한 크기 — 클라이언트가 말한 크기를 믿지 않는다(LOW 6)
      obj_size := obj.bytes;
      if obj_size > 52428800 then raise exception 'file_input'; end if;
      if not public.office_storage_fits(k, c.seg) then raise exception 'file_quota'; end if;
    end if;
    -- 출처는 서버가 정한다(LOW 6): 서명본·생성 문서는 같은 범위의 실제 원본이 있을 때만, 크기도 원본과 같아야
    src := case when p_action = 'link.create' then 'drive' when nullif(p_data->>'drive_id', '') is not null then 'drive'
      when p_data->>'source' in ('mail', 'agent') then p_data->>'source' else 'upload' end;
    if p_action = 'file.create' and nullif(p_data->>'ref_esign', '') is not null then
      ref := public.office_file_uuid(p_data->>'ref_esign');
      select o.bytes into ref_size from public.office_esign e left join public.r2_objects o on o.bucket = 'argo-office' and o.key = e.final_path
        where e.id = ref and e.scope = c.sc and e.status = 'completed' and e.final_path is not null;
      if not found or (ref_size is not null and ref_size <> obj_size) then raise exception 'file_input'; end if;
      src := 'esign';
    elsif p_action = 'file.create' and nullif(p_data->>'ref_doc', '') is not null then
      ref := public.office_file_uuid(p_data->>'ref_doc');
      select o.bytes into ref_size from public.office_docs d left join public.r2_objects o on o.bucket = 'argo-office' and o.key = d.pdf_path
        where d.id = ref and d.scope = c.sc and d.pdf_path <> '';
      if not found or (ref_size is not null and ref_size <> obj_size) then raise exception 'file_input'; end if;
      src := 'generated';
    end if;
    insert into public.office_files(id, scope, folder_id, kind, title, filename, mime, size, storage_path, link_url, source, drive_id, category, tags,
        customer_id, deal_id, ref_id, ocr_status, summary, full_text, created_by)
      values (fid, c.sc, public.office_file_uuid(p_data->>'folder_id'), case when p_action = 'file.create' then 'file' else 'link' end, ttl,
        left(coalesce(p_data->>'filename', ''), 300), left(coalesce(p_data->>'mime', ''), 200), coalesce(obj_size, 0),
        case when p_action = 'file.create' then p_data->>'storage_path' end, case when p_action = 'link.create' then p_data->>'link_url' end,
        src, nullif(p_data->>'drive_id', ''),
        cat, public.office_file_tags(p_data->'tags'), public.office_file_uuid(p_data->>'customer_id'), public.office_file_uuid(p_data->>'deal_id'), ref,
        coalesce(nullif(p_data->>'ocr_status', ''), 'none'), left(coalesce(p_data->>'summary', ''), 1900), left(coalesce(p_data->>'full_text', ''), 100000), c.who);
    if p_action = 'file.create' then perform public.office_storage_claim(k, c.seg, 'file', fid); end if; -- 객체는 이 기록 것(정리 대상에서 빠진다)
    return jsonb_build_object('id', fid);

  elsif p_action = 'file.update' then -- 이름·분류·태그·거래처·거래·폴더(보낸 칸만). 조직 파일은 멤버 누구나(인트라넷 문서함과 같다)
    fid := public.office_file_uuid(p_data->>'id');
    select * into f from public.office_files where id = fid and scope = c.sc and deleted_at is null for update;
    if not found then raise exception 'file_not_found'; end if;
    if p_data ? 'title' then ttl := btrim(coalesce(p_data->>'title', '')); if length(ttl) not between 1 and 300 then raise exception 'file_input'; end if; else ttl := f.title; end if;
    perform public.office_file_refs(c.sc, case when p_data ? 'customer_id' then public.office_file_uuid(p_data->>'customer_id') end,
      case when p_data ? 'deal_id' then public.office_file_uuid(p_data->>'deal_id') end, case when p_data ? 'folder_id' then public.office_file_uuid(p_data->>'folder_id') end);
    update public.office_files set title = ttl,
        category = case when p_data ? 'category' then cat else category end,
        tags = case when p_data ? 'tags' then public.office_file_tags(p_data->'tags') else tags end,
        customer_id = case when p_data ? 'customer_id' then public.office_file_uuid(p_data->>'customer_id') else customer_id end,
        deal_id = case when p_data ? 'deal_id' then public.office_file_uuid(p_data->>'deal_id') else deal_id end,
        folder_id = case when p_data ? 'folder_id' then public.office_file_uuid(p_data->>'folder_id') else folder_id end,
        updated_at = clock_timestamp()
      where id = f.id;
    return jsonb_build_object('id', f.id);

  elsif p_action = 'file.ocr' then -- 글자 읽기 결과(서버 OCR 또는 브라우저 문서 글자 추출)
    fid := public.office_file_uuid(p_data->>'id');
    if coalesce(p_data->>'ocr_status', '') not in ('pending', 'done', 'failed', 'unsupported') then raise exception 'file_input'; end if;
    update public.office_files set ocr_status = p_data->>'ocr_status', summary = left(coalesce(p_data->>'summary', summary), 1900),
        full_text = left(coalesce(p_data->>'full_text', full_text), 100000), updated_at = clock_timestamp()
      where id = fid and scope = c.sc and kind = 'file' and deleted_at is null
        and (ocr_status, summary, full_text) is distinct from (p_data->>'ocr_status', left(coalesce(p_data->>'summary', summary), 1900), left(coalesce(p_data->>'full_text', full_text), 100000));
    if not found and not exists (select 1 from public.office_files where id = fid and scope = c.sc and kind = 'file' and deleted_at is null) then raise exception 'file_not_found'; end if;
    return jsonb_build_object('id', fid);

  elsif p_action in ('file.trash', 'file.restore', 'file.purge') then
    begin select coalesce(array_agg(distinct x::uuid), '{}') into ids from jsonb_array_elements_text(coalesce(p_data->'ids', '[]')) x;
    exception when others then raise exception 'file_input'; end;
    if cardinality(ids) not between 1 and 500 then raise exception 'file_input'; end if;
    if p_action = 'file.trash' then
      with u as (update public.office_files set deleted_at = clock_timestamp() where id = any(ids) and scope = c.sc and deleted_at is null returning id) select array_agg(id) into done from u;
    elsif p_action = 'file.restore' then
      with u as (update public.office_files set deleted_at = null, updated_at = clock_timestamp() where id = any(ids) and scope = c.sc and deleted_at is not null returning id) select array_agg(id) into done from u;
    else -- 영구 삭제: 휴지통에 있고(관리자 또는 올린 사람) — 기록을 지우면서 객체를 deleting으로(한 트랜잭션). R2 삭제는 화면이 부르는 flush·정리 크론이 한다
      with d as (delete from public.office_files x where x.id = any(ids) and x.scope = c.sc and x.deleted_at is not null and (c.manager or x.created_by = c.who)
          returning x.id, x.storage_path) select array_agg(d.id), array_agg(d.storage_path) filter (where d.storage_path is not null) into done, keys from d;
      perform public.office_storage_tombstone(keys);
      return jsonb_build_object('ids', to_jsonb(coalesce(done, '{}')), 'keys', to_jsonb(coalesce(keys, '{}')));
    end if;
    return jsonb_build_object('ids', to_jsonb(coalesce(done, '{}')));

  elsif p_action = 'folder.create' then
    fid := public.office_file_uuid(p_data->>'id'); nm := btrim(coalesce(p_data->>'name', '')); par := public.office_file_uuid(p_data->>'parent_id');
    if fid is null or length(nm) not between 1 and 120 then raise exception 'file_input'; end if;
    perform public.office_file_refs(c.sc, null, null, par);
    if exists (select 1 from public.office_file_folders where id = fid) then
      if exists (select 1 from public.office_file_folders where id = fid and scope = c.sc) then return jsonb_build_object('id', fid); end if;
      raise exception 'file_conflict';
    end if;
    if (select count(*) from public.office_file_folders where scope = c.sc) >= 2000 then raise exception 'file_limit'; end if;
    insert into public.office_file_folders(id, scope, parent_id, name, created_by) values (fid, c.sc, par, nm, c.who);
    return jsonb_build_object('id', fid);

  elsif p_action in ('folder.rename', 'folder.move', 'folder.delete') then
    fid := public.office_file_uuid(p_data->>'id');
    if not exists (select 1 from public.office_file_folders where id = fid and scope = c.sc) then raise exception 'file_not_found'; end if;
    if p_action = 'folder.rename' then
      nm := btrim(coalesce(p_data->>'name', ''));
      if length(nm) not between 1 and 120 then raise exception 'file_input'; end if;
      update public.office_file_folders set name = nm where id = fid and name is distinct from nm;
    elsif p_action = 'folder.move' then
      par := public.office_file_uuid(p_data->>'parent_id');
      perform public.office_file_refs(c.sc, null, null, par);
      -- 자기 자신이나 자기 아래로는 못 옮긴다
      if par is not null and (par = fid or exists (with recursive up as (select id, parent_id from public.office_file_folders where id = par
          union all select d.id, d.parent_id from public.office_file_folders d join up on d.id = up.parent_id) select 1 from up where up.id = fid)) then raise exception 'file_input'; end if;
      update public.office_file_folders set parent_id = par where id = fid and parent_id is distinct from par;
    else -- 지우기는 빈 폴더만(안의 파일을 잃지 않게 — 휴지통 파일도 안에 있으면 남는다)
      if exists (select 1 from public.office_files where folder_id = fid) or exists (select 1 from public.office_file_folders where parent_id = fid) then raise exception 'file_folder_not_empty'; end if;
      delete from public.office_file_folders where id = fid;
    end if;
    return jsonb_build_object('id', fid);
  end if;
  raise exception 'file_input';
exception when unique_violation then raise exception 'file_conflict';
end $$;


-- ── 서버 정리(service_role — Vercel 크론 하루 1회 api/files sweep, 또는 scripts/files-sweep.mjs). 화면을 아무도 열지 않아도 쌓이지 않게 ──
-- R2 객체는 SQL로 지울 수 없다 — 이 함수는 지울 키 목록을 주고, 서버가 R2에서 지운 뒤 r2_object_forget이 행을 지운다(지우지 못한 키는 행이 남아 다음 날 다시).
-- 대상: ① 휴지통 30일 지난 문서함 파일(기록 삭제 + 객체 deleting — 유건 승인 보존 기간) ② 만료된 올리기 자리(pending) ③ 1시간 넘게 기록이 가져가지 않은 객체(uploaded)
--       ④ deleting 전부(flush가 못 지운 것 포함). 함께: 하루 지난 OCR 한도 줄. 부하: 하루 1회, 한 번에 최대 p_limit개(쓰기 = 대상 수만큼 — 유휴 때 0).
create or replace function public.office_storage_sweep(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare lim integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
begin
  delete from public.office_ocr_usage where hour < now() - interval '1 day';
  with d as (delete from public.office_files where id in (select id from public.office_files where deleted_at < now() - interval '30 days' order by deleted_at limit lim)
      returning storage_path)
  update public.r2_objects set state = 'deleting', updated_at = clock_timestamp()
    where bucket = 'argo-office' and key in (select storage_path from d where storage_path is not null) and state <> 'deleting';
  update public.r2_objects set state = 'deleting', updated_at = clock_timestamp()
    where (bucket, key) in (select bucket, key from public.r2_objects where bucket = 'argo-office'
      and ((state = 'pending' and expires_at < now()) or (state = 'uploaded' and updated_at < now() - interval '1 hour')) limit lim);
  return jsonb_build_object('keys', coalesce((select jsonb_agg(x.key) from (select key from public.r2_objects where bucket = 'argo-office' and state = 'deleting' order by updated_at limit lim) x), '[]'::jsonb));
end $$;
revoke all on function public.office_storage_sweep(integer) from public, anon, authenticated;
grant execute on function public.office_storage_sweep(integer) to service_role;

-- ── 구글 드라이브 연결(사람당 한 계정, 봉인 토큰) ──
create table if not exists public.office_drive_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  address text not null,
  scopes text not null default '',                               -- 받은 권한(drive.readonly · 보내기를 켜면 drive.file)
  status text not null default 'ok' check (status in ('ok', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.office_drive_secrets (
  user_id uuid primary key references public.office_drive_accounts(user_id) on delete cascade,
  sealed text not null, access_sealed text, access_expires timestamptz, updated_at timestamptz not null default now()
);
alter table public.office_drive_accounts enable row level security;
alter table public.office_drive_secrets enable row level security;
revoke all on public.office_drive_accounts, public.office_drive_secrets from anon, authenticated;
grant select on public.office_drive_accounts to authenticated;
drop policy if exists office_drive_accounts_own on public.office_drive_accounts;
create policy office_drive_accounts_own on public.office_drive_accounts for select to authenticated using (user_id = auth.uid());

create or replace function public.office_drive_connect(p_expect uuid, p_address text, p_scopes text, p_sealed text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null or uid is distinct from p_expect then raise exception 'office_drive: session mismatch' using errcode = '42501'; end if;
  insert into office_drive_accounts(user_id, address, scopes) values (uid, lower(p_address), coalesce(p_scopes, ''))
  on conflict (user_id) do update set address = excluded.address, scopes = excluded.scopes, status = 'ok', updated_at = now();
  insert into office_drive_secrets(user_id, sealed) values (uid, p_sealed)
  on conflict (user_id) do update set sealed = excluded.sealed, access_sealed = null, access_expires = null, updated_at = now();
end $$;
create or replace function public.office_drive_secret()
returns table (user_id uuid, address text, scopes text, status text, sealed text, access_sealed text, access_expires timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select a.user_id, a.address, a.scopes, a.status, s.sealed, s.access_sealed, s.access_expires
  from office_drive_accounts a join office_drive_secrets s on s.user_id = a.user_id where a.user_id = auth.uid()
$$;
create or replace function public.office_drive_token_put(p_access_sealed text, p_expires timestamptz, p_sealed text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update office_drive_secrets s set access_sealed = p_access_sealed, access_expires = p_expires, sealed = coalesce(p_sealed, s.sealed), updated_at = now()
  where s.user_id = auth.uid() and (s.access_sealed is distinct from p_access_sealed or s.sealed is distinct from coalesce(p_sealed, s.sealed))
$$;
create or replace function public.office_drive_mark(p_status text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update office_drive_accounts set status = p_status, updated_at = now() where user_id = auth.uid() and status is distinct from p_status
$$;
create or replace function public.office_drive_disconnect() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from office_drive_accounts where user_id = auth.uid()   -- 가져온 파일·링크(office_files)는 지우지 않는다(기억 데이터)
$$;

-- ── 공개 페이지에서 '/파일' 블록(fileRef) 빼기 — 조직 파일 이름·id가 공개 링크로 새지 않게(20260928000915 정의 + fileRef) ──
create or replace function public.office_strip(n jsonb) returns jsonb
language sql immutable set search_path=public,pg_temp as $$
 select case
  when n->>'type'='moduleGrid' then '{}'::jsonb
  when jsonb_typeof(n)<>'object' or not(n?'content') or jsonb_typeof(n->'content')<>'array' then n
  else jsonb_set(n,'{content}',coalesce((select jsonb_agg(public.office_strip(c.value) order by c.ord)
   from jsonb_array_elements(n->'content') with ordinality as c(value,ord)
   where coalesce(c.value->>'type','') not in ('recordCard','mailRef','privateBlock','moduleGrid','fileRef')),'[]'::jsonb))
 end
$$;


-- ── 실행 권한 ──
revoke all on function public.office_file_uuid(text), public.office_file_ctx(uuid), public.office_file_json(public.office_files, boolean),
  public.office_file_refs(text, uuid, uuid, uuid), public.office_file_tags(jsonb) from public, anon, authenticated; -- 내부용
revoke all on function public.office_file_list(uuid, text, boolean, uuid), public.office_file_get(uuid, uuid), public.office_file_write(uuid, text, jsonb),
  public.office_drive_connect(uuid, text, text, text), public.office_drive_secret(), public.office_drive_token_put(text, timestamptz, text),
  public.office_drive_mark(text), public.office_drive_disconnect() from public, anon;
grant execute on function public.office_file_list(uuid, text, boolean, uuid), public.office_file_get(uuid, uuid), public.office_file_write(uuid, text, jsonb),
  public.office_drive_connect(uuid, text, text, text), public.office_drive_secret(), public.office_drive_token_put(text, timestamptz, text),
  public.office_drive_mark(text), public.office_drive_disconnect() to authenticated;
