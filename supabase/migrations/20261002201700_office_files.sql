-- 오피스 문서함·거래처 파일·구글 드라이브 연결(유건 10/2 — 인트라넷 문서함·드라이브·거래처 첨부 이식, 트랙 B).
-- · 파일은 오피스 자체 보관: 조직별 Supabase Storage 버킷 office-files, 경로 '<범위>/<파일 id>/<이름>'
--   범위 = 'o-<조직 id>'(조직 — 손님 제외 멤버) | 'u-<사람 id>'(내 공간 — 본인만). 객체는 고치지 않는다(새로 올리기만).
-- · 기록은 office_files 한 표 — 문서함·거래처 파일(customer_id)·견적·계약·서명본(트랙 A, source 'generated'·'esign')·드라이브 링크(kind 'link').
--   표는 함수로만 읽고 쓴다(정책 없음 — office_assets와 같은 방식). 검색은 제목·파일명·추출 본문(OCR·문서 글자).
-- · 보존: 휴지통 30일 뒤 정리 대상(유건 승인 값 2026-09-26 — 페이지 휴지통과 같다). Storage 객체는 SQL로 지우면 안 되므로
--   (Supabase는 Storage API로만 지운다) 서버 정리(api/files sweep — Vercel 크론 하루 1회, 또는 scripts/files-sweep.mjs, 서비스 키)가
--   office_storage_sweep(20261002201900_office_docs.sql — 두 버킷을 함께 본다) 목록을 받아 Storage API로 지운 뒤 office_storage_sweep_done으로 행을 지운다.
--   화면을 아무도 열지 않아도 돈다(분리 검수 MEDIUM 1). 화면도 문서함을 열 때 하루 한 번 같은 일을 한다(office_file_expired — 자기 범위만).
--   객체가 남아 있으면 행을 지우지 않는다(파일을 잃지 않게). 올리다 실패해 행이 없는 객체(하루 지난 것, 열린 자리 없는 것)도 정리 대상이다.
--   OCR 글자는 행 안에만 둔다(따로 쌓이는 표 없음).
-- · 용량(분리 검수 MEDIUM 1): 범위마다 오피스 저장소(office-files + office-docs) 실제 객체 크기 합 상한 — 조직 10GiB, 내 공간 1GiB.
--   올리기 전에 자리(office_storage_slots — 경로·사람·1시간)를 받아야 Storage 정책이 올리기를 허락한다. 자리를 받을 때
--   (범위의 실제 객체 크기 합 + 열린 자리 크기 + 이번 크기)가 상한을 넘으면 거절, 등록 때 실제 객체 크기로 다시 센다. 사람당 열린 자리 50개.
-- · 크기·출처(분리 검수 LOW 6): 크기는 Storage 객체의 실제 크기(metadata.size). 출처는 서버가 정한다 — 'esign'은 같은 범위의 완료된 서명(ref_esign,
--   서명본과 같은 크기), 'generated'는 같은 범위의 견적·계약 문서(ref_doc)가 있을 때만. 클라이언트는 upload·mail·agent만 고를 수 있다.
--   같은 서명본은 문서함에 한 번만(ref_id 유일 — 두 관리자가 동시에 넣어도, 분리 검수 LOW 4).
-- · 서버 OCR 한도(분리 검수 HIGH 1): 사람마다 시간당 60회(office_ocr_usage — 한 시간 한 줄, 하루 지난 줄은 쓸 때·정리 때 지운다).
-- · 부하: 문서함을 열 때 목록 1회, 사람이 누를 때만 쓰기(올리기 = 자리 1 + 등록 1), OCR은 파일당 1회 쓰기 + 한도 1회, 정리 목록은 사람·기기당 하루 1회
--   + 서버 하루 1회. 폴링 없음.
-- · 구글 드라이브 토큰: office_drive_accounts/secrets — 메일과 같은 봉인 방식(OFFICE_MAIL_KEY, 사람·주소 AAD). 사람당 한 계정.

-- ── 버킷·Storage 정책 ──
insert into storage.buckets (id, name, public) values ('office-files', 'office-files', false) on conflict (id) do update set public = false;
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    update storage.buckets set file_size_limit = 52428800 where id = 'office-files'; -- 50MB(오피스 파일 상한 MAX_FILE과 같다)
  end if;
end $$;

/** 경로 첫 칸(범위)을 부른 사람이 쓸 수 있는가. p_admin = 조직 관리자만(남의 객체 지우기) */
create or replace function public.office_file_path_ok(p_name text, p_admin boolean default false) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare seg text := split_part(coalesce(p_name, ''), '/', 1); org uuid; r text;
begin
  if auth.uid() is null or array_length(string_to_array(p_name, '/'), 1) is distinct from 3 then return false; end if;
  if seg = 'u-' || auth.uid() then return true; end if;
  if seg !~ '^o-[0-9a-f-]{36}$' then return false; end if;
  begin org := substr(seg, 3)::uuid; exception when others then return false; end;
  r := public.msgr_role(org);
  return case when p_admin then r in ('owner', 'admin') else r is not null and r <> 'guest' end;
end $$;
revoke all on function public.office_file_path_ok(text, boolean) from public, anon;
grant execute on function public.office_file_path_ok(text, boolean) to authenticated;

drop policy if exists office_files_read on storage.objects;
create policy office_files_read on storage.objects for select to authenticated
  using (bucket_id = 'office-files' and public.office_file_path_ok(name));
-- ── 올리기 자리·용량(두 버킷 공용 — office-docs도 20261002201900에서 같은 자리를 쓴다) ──
create table if not exists public.office_storage_slots (
  bucket text not null check (bucket in ('office-files', 'office-docs')),
  path text not null check (length(path) <= 600),
  seg text not null,                                   -- 범위 첫 칸('o-<조직>'|'u-<사람>') — 용량을 범위로 센다
  bytes bigint not null check (bytes between 0 and 52428800),
  created_by uuid not null,
  expires_at timestamptz not null,
  primary key (bucket, path)
);
create index if not exists office_storage_slots_seg on public.office_storage_slots(seg, expires_at);
create index if not exists office_storage_slots_user on public.office_storage_slots(created_by, expires_at);
alter table public.office_storage_slots enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_storage_slots from anon, authenticated;

/** 범위 용량 상한(바이트) — 조직 10GiB, 내 공간 1GiB(분리 검수 MEDIUM 1, 스스로 정한 값 — 요금제와 묶을 때 여기만 바꾼다) */
create or replace function public.office_storage_quota(p_seg text) returns bigint
language sql immutable set search_path = public, pg_temp as $$
  select case when p_seg like 'o-%' then 10737418240::bigint else 1073741824::bigint end
$$;
/** 범위가 쓰는 실제 크기 — 두 버킷의 그 범위 객체 metadata.size 합(클라이언트가 말한 크기를 믿지 않는다). name 접두 색인(name_prefix_search)을 탄다 */
create or replace function public.office_storage_used(p_seg text) returns bigint
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)::bigint from storage.objects o
  where o.bucket_id in ('office-files', 'office-docs') and o.name like p_seg || '/%'
$$;
/** 올리기 자리 받기 — 부른 사람이 그 범위에 쓸 수 있는지는 부르는 쪽(office_file_write·office_docs_write)이 먼저 확인한다 */
create or replace function public.office_storage_reserve(p_bucket text, p_path text, p_seg text, p_bytes bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); used bigint;
begin
  if who is null then raise exception 'file_forbidden' using errcode = '42501'; end if;
  if p_bytes is null or p_bytes not between 0 and 52428800 or split_part(coalesce(p_path, ''), '/', 1) <> p_seg or p_path like '%..%' then raise exception 'file_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('office-storage:' || p_seg, 0));
  delete from public.office_storage_slots where seg = p_seg and expires_at < now(); -- 지난 자리(쓸 때 정리)
  if exists (select 1 from public.office_storage_slots where bucket = p_bucket and path = p_path) then
    if exists (select 1 from public.office_storage_slots where bucket = p_bucket and path = p_path and created_by = who) then return; end if; -- 같은 요청 다시
    raise exception 'file_conflict';
  end if;
  if exists (select 1 from storage.objects where bucket_id = p_bucket and name = p_path) then raise exception 'file_conflict'; end if;
  if (select count(*) from public.office_storage_slots where created_by = who and expires_at > now()) >= 50 then raise exception 'file_limit'; end if;
  used := public.office_storage_used(p_seg) + coalesce((select sum(bytes) from public.office_storage_slots where seg = p_seg and expires_at > now()), 0);
  if used + p_bytes > public.office_storage_quota(p_seg) then raise exception 'file_quota'; end if;
  insert into public.office_storage_slots(bucket, path, seg, bytes, created_by, expires_at) values (p_bucket, p_path, p_seg, p_bytes, who, now() + interval '1 hour');
end $$;
/** Storage 올리기 정책이 보는 것 — 이 사람이 받은, 아직 지나지 않은 자리 */
create or replace function public.office_storage_slot_ok(p_bucket text, p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.office_storage_slots s where s.bucket = p_bucket and s.path = p_name and s.created_by = auth.uid() and s.expires_at > now())
$$;
/** 등록 때 다시 세기 — 이미 올라온 이 객체를 포함한 실제 합 + (이 자리를 뺀) 열린 자리가 상한 안인가 */
create or replace function public.office_storage_fits(p_bucket text, p_path text, p_seg text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public.office_storage_used(p_seg) + coalesce((select sum(bytes) from public.office_storage_slots where seg = p_seg and expires_at > now() and not (bucket = p_bucket and path = p_path)), 0)
    <= public.office_storage_quota(p_seg)
$$;
revoke all on function public.office_storage_quota(text), public.office_storage_used(text), public.office_storage_reserve(text, text, text, bigint),
  public.office_storage_fits(text, text, text) from public, anon, authenticated; -- 내부용
revoke all on function public.office_storage_slot_ok(text, text) from public, anon;
grant execute on function public.office_storage_slot_ok(text, text) to authenticated; -- Storage 정책이 부른다

drop policy if exists office_files_insert on storage.objects;
create policy office_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'office-files' and public.office_file_path_ok(name) and public.office_storage_slot_ok('office-files', name));

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
-- 지우기: 올린 사람 본인(올리기 실패 정리·정리 대상) 또는 조직 관리자. 고치기(update) 정책은 없다 — 객체는 바뀌지 않는다
drop policy if exists office_files_delete on storage.objects;
create policy office_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'office-files' and public.office_file_path_ok(name) and (owner = (select auth.uid()) or public.office_file_path_ok(name, true)));

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
  storage_path text unique check (storage_path is null or length(storage_path) <= 600),
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

/** 부른 사람 기준 범위 — sc('o:<조직>'|'u:<사람>'), seg(Storage 경로 첫 칸), manager(조직 관리자 또는 내 공간) */
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
declare c record; fid uuid; f public.office_files%rowtype; ids uuid[]; ttl text; nm text; par uuid; done uuid[]; obj_owner uuid; cat text;
  obj_size bigint; src text; ref uuid; ref_size bigint; slot_bytes bigint;
begin
  select * into c from public.office_file_ctx(p_org);
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 450000 then raise exception 'file_input'; end if;
  cat := coalesce(nullif(p_data->>'category', ''), 'general');

  if p_action = 'file.reserve' then -- 올리기 자리(경로·크기) — 이 자리가 있어야 Storage 정책이 올리기를 허락한다
    fid := public.office_file_uuid(p_data->>'id');
    if fid is null or coalesce(p_data->>'storage_path', '') not like c.seg || '/' || fid || '/%' or array_length(string_to_array(p_data->>'storage_path', '/'), 1) <> 3 then raise exception 'file_input'; end if;
    if exists (select 1 from public.office_files where id = fid) then raise exception 'file_conflict'; end if;
    begin slot_bytes := (p_data->>'size')::bigint; exception when others then raise exception 'file_input'; end;
    perform public.office_storage_reserve('office-files', p_data->>'storage_path', c.seg, slot_bytes);
    return jsonb_build_object('path', p_data->>'storage_path');

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
      -- 올린 객체가 이 범위·이 id 자리에 실제로 있어야 한다(남의 경로·없는 파일을 등록하지 못하게)
      if coalesce(p_data->>'storage_path', '') not like c.seg || '/' || fid || '/%' or array_length(string_to_array(p_data->>'storage_path', '/'), 1) <> 3 then raise exception 'file_input'; end if;
      select o.owner, (o.metadata->>'size')::bigint into obj_owner, obj_size from storage.objects o where o.bucket_id = 'office-files' and o.name = p_data->>'storage_path';
      if not found then raise exception 'file_missing'; end if;
      if obj_owner is not null and obj_owner <> c.who then raise exception 'file_forbidden' using errcode = '42501'; end if;
      -- 크기는 실제 객체 크기(없으면 받은 자리 크기) — 클라이언트가 말한 크기를 믿지 않는다(LOW 6)
      obj_size := coalesce(obj_size, (select s.bytes from public.office_storage_slots s where s.bucket = 'office-files' and s.path = p_data->>'storage_path'), 0);
      if obj_size > 52428800 then raise exception 'file_input'; end if;
      if not public.office_storage_fits('office-files', p_data->>'storage_path', c.seg) then raise exception 'file_quota'; end if;
    end if;
    -- 출처는 서버가 정한다(LOW 6): 서명본·생성 문서는 같은 범위의 실제 원본이 있을 때만, 크기도 원본과 같아야
    src := case when p_action = 'link.create' then 'drive' when nullif(p_data->>'drive_id', '') is not null then 'drive'
      when p_data->>'source' in ('mail', 'agent') then p_data->>'source' else 'upload' end;
    if p_action = 'file.create' and nullif(p_data->>'ref_esign', '') is not null then
      ref := public.office_file_uuid(p_data->>'ref_esign');
      select (o.metadata->>'size')::bigint into ref_size from public.office_esign e left join storage.objects o on o.bucket_id = 'office-docs' and o.name = e.final_path
        where e.id = ref and e.scope = c.sc and e.status = 'completed' and e.final_path is not null;
      if not found or (ref_size is not null and ref_size <> obj_size) then raise exception 'file_input'; end if;
      src := 'esign';
    elsif p_action = 'file.create' and nullif(p_data->>'ref_doc', '') is not null then
      ref := public.office_file_uuid(p_data->>'ref_doc');
      select (o.metadata->>'size')::bigint into ref_size from public.office_docs d left join storage.objects o on o.bucket_id = 'office-docs' and o.name = d.pdf_path
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
    if p_action = 'file.create' then delete from public.office_storage_slots where bucket = 'office-files' and path = p_data->>'storage_path'; end if; -- 자리는 쓰였다
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
    else -- 영구 삭제: 휴지통에 있고(관리자 또는 올린 사람) Storage 객체가 이미 지워진 것만 — 객체가 남으면 행을 지우지 않는다
      with d as (delete from public.office_files x where x.id = any(ids) and x.scope = c.sc and x.deleted_at is not null and (c.manager or x.created_by = c.who)
          and not exists (select 1 from storage.objects o where o.bucket_id = 'office-files' and o.name = x.storage_path) returning x.id) select array_agg(d.id) into done from d;
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

-- ── 정리 대상 ── 휴지통 30일 지난 파일(관리자 또는 올린 사람) + 하루 지난 행 없는 객체(관리자 — 내 공간은 본인)
create or replace function public.office_file_expired(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record;
begin
  select * into c from public.office_file_ctx(p_org);
  return jsonb_build_object(
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'path', f.storage_path)) from (select id, storage_path from public.office_files f
        where f.scope = c.sc and f.deleted_at < now() - interval '30 days' and (c.manager or f.created_by = c.who) order by f.deleted_at limit 200) f), '[]'::jsonb),
    'orphans', case when not c.manager then '[]'::jsonb else coalesce((select jsonb_agg(o.name) from (select o.name from storage.objects o
        where o.bucket_id = 'office-files' and o.name like c.seg || '/%' and o.created_at < now() - interval '1 day'
          and not exists (select 1 from public.office_files f where f.storage_path = o.name)
          and not exists (select 1 from public.office_storage_slots s where s.bucket = 'office-files' and s.path = o.name and s.expires_at > now())
        order by o.created_at limit 200) o), '[]'::jsonb) end);
end $$;

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
  public.office_file_expired(uuid), public.office_drive_connect(uuid, text, text, text), public.office_drive_secret(), public.office_drive_token_put(text, timestamptz, text),
  public.office_drive_mark(text), public.office_drive_disconnect() from public, anon;
grant execute on function public.office_file_list(uuid, text, boolean, uuid), public.office_file_get(uuid, uuid), public.office_file_write(uuid, text, jsonb),
  public.office_file_expired(uuid), public.office_drive_connect(uuid, text, text, text), public.office_drive_secret(), public.office_drive_token_put(text, timestamptz, text),
  public.office_drive_mark(text), public.office_drive_disconnect() to authenticated;
