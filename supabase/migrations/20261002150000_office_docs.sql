-- 오피스 견적·계약·전자서명(spec8 트랙 A, 10/2) — 인트라넷 lib/docgen(견적서·계약서)·lib/esign(SQLite 3표)·app/sign/[token] 이식.
-- 권한: 업무 원장과 같은 기준(office_business_scope) — 읽기 = 조직 멤버(손님 제외), 쓰기 = 소유자·관리자, 내 공간 = 본인.
-- 표는 RLS를 켜고 직접 권한을 모두 거둔다 — 아래 SECURITY DEFINER 함수로만 읽고 쓴다(업무 원장과 같은 방식).
-- 파일은 Storage 비공개 버킷 office-docs: <o-조직|u-사람>/docs/<문서>.pdf, <…>/esign/<서명>/orig.pdf·final.pdf·s-<서명자>-<n>.(png|jpg).
-- 공개 서명(로그인 없음)은 서버 함수(apps/office/api/esign, 서비스 키)만 부르는 office_esign_public_* 함수로 — 토큰 원문은 저장하지 않고 SHA-256만.
--
-- 부하(DB 위생): 사람이 버튼을 누를 때만 쓴다(만들기·보내기·서명 제출). 폴링·심박 없음. 서명 링크 열람 기록은 서명자마다 10분에 한 번,
-- 서명 한 건의 반복 기록(열람·이름 바꿈·다시 보냄·알림)은 500줄 상한(서명·완료·취소 같은 증빙 기록은 상한 없이 남긴다). 문서·서명 기록은 계약 증빙이라 보존한다(삭제는 사람이 할 때만, 그때 파일·기록이 함께 지워진다).
-- 조직·사람이 지워지면 함께 지워진다(아래 on delete cascade 없음 — scope 문자열로 묶여 있어 조직 삭제 정리 작업이 scope로 지운다).
-- 용량·올리기(분리 검수 MEDIUM 1): 사람이 올리는 파일(문서 PDF <seg>/docs/<문서>.pdf, 서명 원본 <seg>/esign/<서명>/orig.pdf)은 doc.reserve·esign.reserve로
-- 자리를 받아야 올라간다(내 공간 포함 — 그 밖의 경로에는 못 올린다). 자리·용량 규칙은 문서함(20261002100000)의 office_storage_* 와 같다(범위당 두 버킷 합).
-- 행 없는 객체(하루 지난 것)와 문서함 휴지통 30일 파일은 서버 정리(office_storage_sweep — 이 파일 끝, service_role 전용)가 화면 없이 지운다.

create table public.office_docs (
  id uuid primary key, scope text not null,
  kind text not null check (kind in ('quote','contract')),
  title text not null check (length(title) between 1 and 300),
  customer_name text not null default '' check (length(customer_name) <= 200),
  customer_id uuid references public.office_business_customers(id) on delete set null,
  order_id uuid references public.office_business_orders(id) on delete set null,
  input jsonb not null default '{}' check (octet_length(input::text) <= 100000),
  pdf_path text not null default '', pdf_size integer not null default 0 check (pdf_size between 0 and 20971520), pdf_hash text not null default '',
  filename text not null default '' check (length(filename) <= 200),
  supply bigint not null default 0, vat bigint not null default 0, total bigint not null default 0,
  created_by uuid, created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp()
);
create index on public.office_docs(scope, created_at desc);
create index on public.office_docs(order_id) where order_id is not null;

create table public.office_esign (
  id uuid primary key, scope text not null,
  doc_id uuid references public.office_docs(id) on delete set null,
  order_id uuid references public.office_business_orders(id) on delete set null,
  title text not null check (length(title) between 1 and 200),
  status text not null default 'draft' check (status in ('draft','sent','completed','cancelled')),
  orig_path text not null, doc_hash text not null check (doc_hash ~ '^[0-9a-f]{64}$'),
  final_path text, final_hash text,
  fields jsonb not null default '[]' check (jsonb_typeof(fields) = 'array' and octet_length(fields::text) <= 100000),
  pages integer check (pages between 1 and 500),
  mail_account uuid references public.office_mail_accounts(id) on delete set null, -- 서명 요청을 보낸 메일 계정(완료 알림도 같은 계정으로)
  created_by uuid, created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz, completed_at timestamptz, cancelled_at timestamptz,
  filed_at timestamptz,     -- 서명본을 문서함(트랙 B)에 넣은 시각
  notified_at timestamptz,  -- 완료 메일을 보낸 시각(서버가 못 보내면 비어 있고, 화면이 '완료 알림 보내기'를 보인다)
  order_sync text check (length(order_sync) <= 300)
);
create index on public.office_esign(scope, created_at desc);

create table public.office_esign_signers (
  id uuid primary key default gen_random_uuid(),
  esign_id uuid not null references public.office_esign(id) on delete cascade,
  ord smallint not null check (ord between 0 and 9),
  name text not null check (length(name) between 1 and 100),
  email text not null check (length(email) between 3 and 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  status text not null default 'pending' check (status in ('pending','signed')),
  token_hash text unique check (token_hash ~ '^[0-9a-f]{64}$'), token_expires timestamptz,
  opened_at timestamptz, signed_at timestamptz, ip text check (length(ip) <= 100), ua text check (length(ua) <= 300),
  placements jsonb not null default '[]' check (jsonb_typeof(placements) = 'array' and octet_length(placements::text) <= 200000),
  unique (esign_id, ord)
);

create table public.office_esign_events (
  id uuid primary key default gen_random_uuid(),
  esign_id uuid not null references public.office_esign(id) on delete cascade,
  actor text not null check (length(actor) <= 320),
  action text not null check (action in ('created','sent','opened','signed','completed','cancelled','renamed','resent','notified','filed')),
  ip text, ua text, at timestamptz not null default clock_timestamp()
);
create index on public.office_esign_events(esign_id, at);

do $$ declare tab text; begin
  foreach tab in array array['office_docs','office_esign','office_esign_signers','office_esign_events'] loop
    execute format('alter table public.%I enable row level security', tab);
    execute format('revoke all on public.%I from public, anon, authenticated', tab);
  end loop;
end $$;

-- scope('o:<조직>'|'u:<사람>') ↔ 저장소 첫 칸('o-<조직>'|'u-<사람>')
create function public.office_docs_seg(sc text) returns text language sql immutable set search_path = public, pg_temp as $$ select replace(sc, ':', '-') $$;

create function public.office_docs_event(p_esign uuid, p_actor text, p_action text, p_ip text default null, p_ua text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_action in ('opened','renamed','resent','notified') and (select count(*) from public.office_esign_events where esign_id = p_esign) >= 500 then return; end if; -- 반복 기록만 500줄 상한(증빙 기록은 항상 남긴다)
  insert into public.office_esign_events(esign_id, actor, action, ip, ua) values (p_esign, left(p_actor, 320), p_action, left(p_ip, 100), left(p_ua, 300));
end $$;

/** 저장소 경로 권한 — 첫 칸이 내 공간(u-<나>)이거나, 내가 멤버(쓰기는 소유자·관리자)인 조직(o-<조직>)일 때만.
 *  서명 한 건의 폴더(<…>/esign/<서명>/)는 그 서명 기록이 있는 동안 아무도 올리거나 지울 수 없다 — 원본·서명 그림·서명본을 바꿔 끼우지 못하게.
 *  (원본은 기록을 만들기 전에 올리고, 기록을 지운 뒤에 파일을 지운다. 서명 그림·서명본은 서비스 키 서버 함수가 쓴다.) */
create function public.office_docs_storage_ok(p_name text, p_write boolean) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare seg text := split_part(p_name, '/', 1); who uuid := auth.uid(); org uuid; r text;
begin
  if who is null or p_name like '%..%' then return false; end if;
  if p_write and p_name ~ '^[^/]+/esign/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
     and exists(select 1 from public.office_esign where id = split_part(p_name, '/', 3)::uuid) then return false; end if;
  if seg = 'u-' || who then return true; end if;
  if seg !~ '^o-[0-9a-f-]{36}$' then return false; end if;
  org := substr(seg, 3)::uuid;
  select m.role into r from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
    where m.org_id = org and m.user_id = who and m.removed_at is null and o.deleted_at is null;
  return r is not null and r <> 'guest' and (not p_write or r in ('owner','admin'));
end $$;

insert into storage.buckets(id, name, public) values ('office-docs', 'office-docs', false) on conflict (id) do nothing;
-- 크기·형식 제한(지원되는 Storage 판에서만 열이 있다)
do $$ begin
  update storage.buckets set file_size_limit = 20971520, allowed_mime_types = array['application/pdf','image/png','image/jpeg'] where id = 'office-docs';
exception when undefined_column then null; end $$;
drop policy if exists office_docs_read on storage.objects;
create policy office_docs_read on storage.objects for select to authenticated using (bucket_id = 'office-docs' and public.office_docs_storage_ok(name, false));
drop policy if exists office_docs_insert on storage.objects;
create policy office_docs_insert on storage.objects for insert to authenticated with check (bucket_id = 'office-docs' and public.office_docs_storage_ok(name, true) and public.office_storage_slot_ok('office-docs', name));
drop policy if exists office_docs_delete on storage.objects;
create policy office_docs_delete on storage.objects for delete to authenticated using (bucket_id = 'office-docs' and public.office_docs_storage_ok(name, true));
-- 고쳐 쓰기(update) 정책은 두지 않는다 — 발행한 PDF·서명본은 바꾸지 않는다(새로 만든다)

create function public.office_docs_signers_json(p_esign uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'ord', s.ord, 'name', s.name, 'email', s.email, 'status', s.status, 'signed_at', s.signed_at, 'opened_at', s.opened_at) order by s.ord), '[]')
  from public.office_esign_signers s where s.esign_id = p_esign
$$;
create function public.office_docs_esign_json(e public.office_esign) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select (to_jsonb(e) - 'scope' - 'mail_account') || jsonb_build_object('signers', public.office_docs_signers_json(e.id))
$$;

create function public.office_docs_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text := public.office_business_scope(p_org, false); writable boolean;
begin
  writable := p_org is null or exists(select 1 from public.msgr_org_members where org_id = p_org and user_id = auth.uid() and removed_at is null and role in ('owner','admin'));
  return jsonb_build_object(
    -- 목록에는 큰 칸(문서 입력값·서명 칸 배치)을 싣지 않는다 — 열 때 office_docs_get으로(전송량). ponytail: 최근 300건, 넘으면 페이지 나누기
    'docs', (select coalesce(jsonb_agg(to_jsonb(d) - 'scope' - 'input' order by d.created_at desc, d.id), '[]') from (select * from public.office_docs where scope = sc order by created_at desc, id limit 300) d),
    'esign', (select coalesce(jsonb_agg(public.office_docs_esign_json(e) - 'fields' order by e.created_at desc, e.id), '[]') from (select * from public.office_esign where scope = sc order by created_at desc, id limit 300) e),
    'can_write', writable);
end $$;

/** 한 건 전체(문서 입력값·서명 칸 배치 포함) — 다시 쓰기·이어 쓰기·서명 준비 화면이 열 때만 */
create function public.office_docs_get(p_org uuid, p_kind text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text := public.office_business_scope(p_org, false); out jsonb;
begin
  if p_kind = 'doc' then select to_jsonb(d) - 'scope' into out from public.office_docs d where d.id = p_id and d.scope = sc;
  elsif p_kind = 'esign' then select public.office_docs_esign_json(e) into out from public.office_esign e where e.id = p_id and e.scope = sc;
  end if;
  if out is null then raise exception 'docs_not_found'; end if;
  return out;
end $$;

create function public.office_docs_events(p_org uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare sc text := public.office_business_scope(p_org, false);
begin
  if not exists(select 1 from public.office_esign where id = p_id and scope = sc) then raise exception 'docs_not_found'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'actor', v.actor, 'action', v.action, 'ip', v.ip, 'at', v.at) order by v.at, v.id), '[]') from public.office_esign_events v where v.esign_id = p_id);
end $$;

/** 서명자 목록 정리 — 이름·이메일 둘 다, 최대 5명, 이메일 중복 없음 */
create function public.office_docs_clean_signers(p jsonb) returns jsonb language plpgsql immutable set search_path = public, pg_temp as $$
declare el jsonb; out jsonb := '[]'; seen text[] := '{}'; e text;
begin
  if jsonb_typeof(p) is distinct from 'array' then return '[]'; end if;
  for el in select value from jsonb_array_elements(p) loop
    e := lower(trim(coalesce(el->>'email', '')));
    if length(trim(coalesce(el->>'name', ''))) between 1 and 100 and e ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' and length(e) <= 320 and not e = any(seen) then
      out := out || jsonb_build_array(jsonb_build_object('name', trim(el->>'name'), 'email', trim(el->>'email'), 'token_hash', el->>'token_hash'));
      seen := seen || e;
    end if;
    exit when jsonb_array_length(out) >= 5;
  end loop;
  return out;
end $$;

create function public.office_docs_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  sc text := public.office_business_scope(p_org, true); who uuid := auth.uid(); seg text := public.office_docs_seg(sc);
  d public.office_docs%rowtype; e public.office_esign%rowtype; s public.office_esign_signers%rowtype;
  rid uuid; signers jsonb; el jsonb; i int := 0; paths text[];
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 300000 then raise exception 'docs_input'; end if;
  rid := nullif(p_data->>'id', '')::uuid;
  if p_action in ('doc.reserve', 'esign.reserve') then -- 올리기 자리(경로는 서버가 정한다 — 이 모양 밖에는 사람이 못 올린다)
    if rid is null then raise exception 'docs_input'; end if;
    if p_action = 'doc.reserve' then
      if exists(select 1 from public.office_docs where id = rid and scope <> sc) then raise exception 'docs_not_found'; end if;
      paths := array[seg || '/docs/' || rid || '.pdf'];
    else
      if exists(select 1 from public.office_esign where id = rid) then raise exception 'docs_state'; end if;
      paths := array[seg || '/esign/' || rid || '/orig.pdf'];
    end if;
    begin perform public.office_storage_reserve('office-docs', paths[1], seg, (p_data->>'size')::bigint);
    exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'docs_input'; end;
    return jsonb_build_object('path', paths[1]);
  elsif p_action = 'doc.save' then
    if rid is null or coalesce(p_data->>'kind', '') not in ('quote','contract') or length(trim(coalesce(p_data->>'title', ''))) not between 1 and 300 then raise exception 'docs_input'; end if;
    if p_data ? 'pdf_path' and (p_data->>'pdf_path') is distinct from seg || '/docs/' || rid || '.pdf' then raise exception 'docs_path'; end if;
    if nullif(p_data->>'customer_id', '') is not null and not exists(select 1 from public.office_business_customers where id = (p_data->>'customer_id')::uuid and scope = sc) then raise exception 'docs_not_found'; end if;
    if nullif(p_data->>'order_id', '') is not null and not exists(select 1 from public.office_business_orders where id = (p_data->>'order_id')::uuid and scope = sc) then raise exception 'docs_not_found'; end if;
    select * into d from public.office_docs where id = rid;
    if found and d.scope <> sc then raise exception 'docs_not_found'; end if;
    insert into public.office_docs as t(id, scope, kind, title, customer_name, customer_id, order_id, input, pdf_path, pdf_size, pdf_hash, filename, supply, vat, total, created_by)
    values (rid, sc, p_data->>'kind', trim(p_data->>'title'), left(coalesce(p_data->>'customer_name', ''), 200), nullif(p_data->>'customer_id', '')::uuid, nullif(p_data->>'order_id', '')::uuid,
      coalesce(p_data->'input', '{}'), coalesce(p_data->>'pdf_path', ''), coalesce((p_data->>'pdf_size')::int, 0), coalesce(p_data->>'pdf_hash', ''), left(coalesce(p_data->>'filename', ''), 200),
      coalesce((p_data->>'supply')::bigint, 0), coalesce((p_data->>'vat')::bigint, 0), coalesce((p_data->>'total')::bigint, 0), who)
    on conflict (id) do update set title = excluded.title, customer_name = excluded.customer_name, customer_id = excluded.customer_id, order_id = excluded.order_id, input = excluded.input,
      pdf_path = case when p_data ? 'pdf_path' then excluded.pdf_path else t.pdf_path end, pdf_size = case when p_data ? 'pdf_path' then excluded.pdf_size else t.pdf_size end,
      pdf_hash = case when p_data ? 'pdf_path' then excluded.pdf_hash else t.pdf_hash end, filename = excluded.filename, supply = excluded.supply, vat = excluded.vat, total = excluded.total, updated_at = clock_timestamp()
    returning * into d;
    if p_data ? 'pdf_path' then -- 크기는 실제 객체 크기(있으면), 자리는 쓰였다
      update public.office_docs x set pdf_size = (o.metadata->>'size')::int from storage.objects o
        where x.id = d.id and o.bucket_id = 'office-docs' and o.name = d.pdf_path and (o.metadata->>'size') is not null and x.pdf_size is distinct from (o.metadata->>'size')::int
        returning x.* into d;
      select * into d from public.office_docs where id = rid;
      delete from public.office_storage_slots where bucket = 'office-docs' and path = d.pdf_path;
    end if;
    return to_jsonb(d) - 'scope';
  elsif p_action = 'doc.delete' then
    delete from public.office_docs where id = rid and scope = sc returning * into d;
    if not found then raise exception 'docs_not_found'; end if;
    return jsonb_build_object('paths', to_jsonb(array_remove(array[nullif(d.pdf_path, '')], null)));
  elsif p_action = 'esign.create' then
    if rid is null or length(trim(coalesce(p_data->>'title', ''))) not between 1 and 200 or coalesce(p_data->>'doc_hash', '') !~ '^[0-9a-f]{64}$'
       or (p_data->>'orig_path') is distinct from seg || '/esign/' || rid || '/orig.pdf' or jsonb_typeof(coalesce(p_data->'fields', '[]')) <> 'array' or jsonb_array_length(coalesce(p_data->'fields', '[]')) > 200 then raise exception 'docs_input'; end if;
    if nullif(p_data->>'doc_id', '') is not null and not exists(select 1 from public.office_docs where id = (p_data->>'doc_id')::uuid and scope = sc) then raise exception 'docs_not_found'; end if;
    if nullif(p_data->>'order_id', '') is not null and not exists(select 1 from public.office_business_orders where id = (p_data->>'order_id')::uuid and scope = sc) then raise exception 'docs_not_found'; end if;
    insert into public.office_esign(id, scope, doc_id, order_id, title, orig_path, doc_hash, fields, pages, created_by)
      values (rid, sc, nullif(p_data->>'doc_id', '')::uuid, nullif(p_data->>'order_id', '')::uuid, trim(p_data->>'title'), p_data->>'orig_path', p_data->>'doc_hash', coalesce(p_data->'fields', '[]'), nullif(p_data->>'pages', '')::int, who)
      returning * into e;
    for el in select value from jsonb_array_elements(public.office_docs_clean_signers(p_data->'signers')) loop
      insert into public.office_esign_signers(esign_id, ord, name, email) values (e.id, i, el->>'name', el->>'email'); i := i + 1;
    end loop;
    perform public.office_docs_event(e.id, 'owner', 'created');
    delete from public.office_storage_slots where bucket = 'office-docs' and path = e.orig_path; -- 자리는 쓰였다
    return public.office_docs_esign_json(e);
  end if;

  -- 이하 서명 한 건에 대한 동작
  select * into e from public.office_esign where id = rid and scope = sc for update;
  if not found then raise exception 'docs_not_found'; end if;
  if p_action = 'esign.update' then
    if p_data ? 'title' then
      if length(trim(coalesce(p_data->>'title', ''))) not between 1 and 200 then raise exception 'docs_title'; end if;
      if trim(p_data->>'title') <> e.title then update public.office_esign set title = trim(p_data->>'title') where id = e.id; perform public.office_docs_event(e.id, 'owner', 'renamed'); end if;
    end if;
    if p_data ? 'fields' or p_data ? 'signers' then
      if e.status <> 'draft' then raise exception 'docs_state'; end if;
      if p_data ? 'fields' then
        if jsonb_typeof(p_data->'fields') <> 'array' or jsonb_array_length(p_data->'fields') > 200 then raise exception 'docs_input'; end if;
        update public.office_esign set fields = p_data->'fields' where id = e.id;
      end if;
      if p_data ? 'signers' then
        delete from public.office_esign_signers where esign_id = e.id;
        for el in select value from jsonb_array_elements(public.office_docs_clean_signers(p_data->'signers')) loop
          insert into public.office_esign_signers(esign_id, ord, name, email) values (e.id, i, el->>'name', el->>'email'); i := i + 1;
        end loop;
      end if;
    end if;
  elsif p_action = 'esign.send' then
    if e.status = 'completed' then raise exception 'docs_completed'; elsif e.status = 'sent' then raise exception 'docs_sent'; elsif e.status = 'cancelled' then raise exception 'docs_cancelled'; end if;
    signers := public.office_docs_clean_signers(p_data->'signers');
    if jsonb_array_length(signers) < 1 then raise exception 'docs_signers'; end if;
    if exists(select 1 from jsonb_array_elements(signers) x where coalesce(x->>'token_hash', '') !~ '^[0-9a-f]{64}$') then raise exception 'docs_input'; end if;
    if exists(select 1 from public.office_esign_signers where esign_id = e.id and status = 'signed') then raise exception 'docs_signed'; end if; -- 서명 기록 보호(인트라넷 send route:37-39)
    if nullif(p_data->>'mail_account', '') is not null and not exists(select 1 from public.office_mail_accounts where id = (p_data->>'mail_account')::uuid and user_id = who) then raise exception 'docs_input'; end if;
    if jsonb_typeof(coalesce(p_data->'fields', '[]')) <> 'array' or jsonb_array_length(coalesce(p_data->'fields', '[]')) > 200 then raise exception 'docs_input'; end if;
    delete from public.office_esign_signers where esign_id = e.id;
    for el in select value from jsonb_array_elements(signers) loop
      insert into public.office_esign_signers(esign_id, ord, name, email, token_hash, token_expires)
        values (e.id, i, el->>'name', el->>'email', el->>'token_hash', least(coalesce((p_data->>'expires_at')::timestamptz, now() + interval '30 days'), now() + interval '30 days'));
      i := i + 1;
    end loop;
    update public.office_esign set status = 'sent', sent_at = clock_timestamp(), fields = coalesce(p_data->'fields', fields), mail_account = nullif(p_data->>'mail_account', '')::uuid where id = e.id;
    perform public.office_docs_event(e.id, 'owner', 'sent');
  elsif p_action = 'esign.resend' then
    if e.status <> 'sent' or coalesce(p_data->>'token_hash', '') !~ '^[0-9a-f]{64}$' then raise exception 'docs_state'; end if;
    update public.office_esign_signers set token_hash = p_data->>'token_hash', token_expires = least(coalesce((p_data->>'expires_at')::timestamptz, now() + interval '30 days'), now() + interval '30 days')
      where id = (p_data->>'signer_id')::uuid and esign_id = e.id and status = 'pending' returning * into s;
    if not found then raise exception 'docs_state'; end if;
    perform public.office_docs_event(e.id, 'owner', 'resent');
    return jsonb_build_object('id', s.id, 'ord', s.ord, 'name', s.name, 'email', s.email);
  elsif p_action = 'esign.cancel' then
    if e.status = 'completed' then raise exception 'docs_completed'; end if;
    -- 전원이 서명했는데 서명본 만들기만 실패한 건은 취소하지 않는다('완료 다시 시도'로 끝낸다)
    if e.status = 'sent' and not exists(select 1 from public.office_esign_signers where esign_id = e.id and status <> 'signed') then raise exception 'docs_signed'; end if;
    if e.status <> 'cancelled' then
      update public.office_esign set status = 'cancelled', cancelled_at = clock_timestamp() where id = e.id;
      update public.office_esign_signers set token_hash = null where esign_id = e.id; -- 링크도 끊는다
      perform public.office_docs_event(e.id, 'owner', 'cancelled');
    end if;
  elsif p_action = 'esign.delete' then
    select array_agg(p) into paths from (
      select e.orig_path p union all select e.final_path where e.final_path is not null
      union all select x->>'img_path' from public.office_esign_signers g, jsonb_array_elements(g.placements) x where g.esign_id = e.id and x ? 'img_path') q;
    delete from public.office_esign where id = e.id;
    return jsonb_build_object('paths', to_jsonb(coalesce(paths, '{}')));
  elsif p_action = 'esign.finishable' then
    -- '완료 다시 시도'(api/esign finish) — 쓰기 권한자가 부르고, 전원 서명했는데 아직 완료되지 않은 건만 통과
    if e.status <> 'sent' or exists(select 1 from public.office_esign_signers where esign_id = e.id and status <> 'signed') then raise exception 'docs_state'; end if;
  elsif p_action = 'esign.filed' then
    update public.office_esign set filed_at = coalesce(filed_at, clock_timestamp()) where id = e.id and status = 'completed';
  elsif p_action = 'esign.notified' then
    update public.office_esign set notified_at = clock_timestamp() where id = e.id and status = 'completed';
    perform public.office_docs_event(e.id, 'owner', 'notified');
  else raise exception 'docs_action';
  end if;
  select * into e from public.office_esign where id = rid;
  return public.office_docs_esign_json(e);
end $$;

/* ── 공개 서명(서버 함수 전용 — service_role만 부를 수 있다). p_hash = 링크 토큰의 SHA-256 ── */
create function public.office_esign_public_find(p_hash text) returns table(signer public.office_esign_signers, esign public.office_esign)
language sql stable security definer set search_path = public, pg_temp as $$
  select s, e from public.office_esign_signers s join public.office_esign e on e.id = s.esign_id
  where p_hash ~ '^[0-9a-f]{64}$' and s.token_hash = p_hash and s.token_expires > now()
$$;

create function public.office_esign_public_state(p_hash text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record; local text; dom text;
begin
  select * into r from public.office_esign_public_find(p_hash);
  if not found then raise exception 'docs_invalid'; end if;
  if (r.esign).status in ('completed','cancelled') then return jsonb_build_object('status', (r.esign).status); end if;
  if (r.esign).status <> 'sent' then raise exception 'docs_invalid'; end if;
  local := split_part((r.signer).email, '@', 1); dom := split_part((r.signer).email, '@', 2);
  return jsonb_build_object('status', (r.signer).status, 'maskedEmail', left(local, 2) || repeat('*', greatest(2, length(local) - least(2, length(local)))) || '@' || dom);
end $$;

create function public.office_esign_public_open(p_hash text, p_email text, p_ip text, p_ua text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; org_name text;
begin
  select * into r from public.office_esign_public_find(p_hash);
  if not found then raise exception 'docs_invalid'; end if;
  if (r.esign).status = 'completed' then raise exception 'docs_completed'; elsif (r.esign).status = 'cancelled' then raise exception 'docs_cancelled'; elsif (r.esign).status <> 'sent' then raise exception 'docs_invalid'; end if;
  if lower(trim(coalesce(p_email, ''))) <> lower(trim((r.signer).email)) then raise exception 'docs_email'; end if;
  if (r.signer).status <> 'signed' and ((r.signer).opened_at is null or (r.signer).opened_at < now() - interval '10 minutes') then
    update public.office_esign_signers set opened_at = now() where id = (r.signer).id;
    perform public.office_docs_event((r.esign).id, (r.signer).email, 'opened', p_ip, p_ua); -- 열람 기록은 10분에 한 번
  end if;
  if (r.esign).scope like 'o:%' then select name into org_name from public.msgr_orgs where id = substr((r.esign).scope, 3)::uuid; end if;
  return jsonb_build_object('alreadySigned', (r.signer).status = 'signed',
    'signer', jsonb_build_object('name', (r.signer).name, 'email', (r.signer).email, 'status', (r.signer).status, 'ord', (r.signer).ord),
    'contract', jsonb_build_object('title', (r.esign).title, 'sender', coalesce(org_name, '')),
    'fields', (select coalesce(jsonb_agg(f), '[]') from jsonb_array_elements((r.esign).fields) f where (f->>'signer_ord')::int = (r.signer).ord),
    'orig_path', (r.esign).orig_path, 'pages', (r.esign).pages);
end $$;

/** 서버 함수가 그림을 저장하기 전에 — 링크·본인 이메일을 먼저 확인하고(남이 그림을 올리지 못하게) 서명 한 건·서명자 id·저장소 첫 칸·전원 서명 여부 */
create function public.office_esign_public_who(p_hash text, p_email text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r record;
begin
  select * into r from public.office_esign_public_find(p_hash);
  if not found then raise exception 'docs_invalid'; end if;
  if (r.esign).status = 'sent' and lower(trim(coalesce(p_email, ''))) <> lower(trim((r.signer).email)) then raise exception 'docs_email'; end if;
  return jsonb_build_object('esign_id', (r.esign).id, 'signer_id', (r.signer).id, 'seg', public.office_docs_seg((r.esign).scope), 'pages', (r.esign).pages, 'status', (r.esign).status, 'signer_status', (r.signer).status,
    'all_signed', not exists(select 1 from public.office_esign_signers where esign_id = (r.esign).id and status <> 'signed'));
end $$;

/** 서명 제출 — 서버 함수가 그림을 저장한 뒤 경로로 넘긴다(placements: [{ page, kind:'signature', xr, yr, wr, img_path } | { page, kind:'text', xr, yr, wr, text, sizeR }]) */
create function public.office_esign_public_submit(p_hash text, p_email text, p_placements jsonb, p_ip text, p_ua text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; done boolean; prefix text;
begin
  select * into r from public.office_esign_public_find(p_hash);
  if not found then raise exception 'docs_invalid'; end if;
  perform 1 from public.office_esign where id = (r.esign).id for update; -- 동시에 낸 두 서명자가 둘 다 '완료 아님'으로 보지 않게
  select * into r from public.office_esign_public_find(p_hash);
  if not found then raise exception 'docs_invalid'; end if; -- 잠그는 사이 취소돼 링크가 끊긴 경우
  if (r.esign).status = 'completed' then raise exception 'docs_completed'; elsif (r.esign).status = 'cancelled' then raise exception 'docs_cancelled'; elsif (r.esign).status <> 'sent' then raise exception 'docs_invalid'; end if;
  if lower(trim(coalesce(p_email, ''))) <> lower(trim((r.signer).email)) then raise exception 'docs_email'; end if;
  if (r.signer).status = 'signed' then raise exception 'docs_already'; end if;
  prefix := public.office_docs_seg((r.esign).scope) || '/esign/' || (r.esign).id || '/s-' || (r.signer).id || '-';
  if jsonb_typeof(p_placements) <> 'array' or jsonb_array_length(p_placements) not between 1 and 100 or octet_length(p_placements::text) > 200000
     or exists(select 1 from jsonb_array_elements(p_placements) x where x->>'kind' not in ('signature','text') or (x->>'kind' = 'signature' and (x->>'img_path') not like prefix || '%')) then raise exception 'docs_input'; end if;
  update public.office_esign_signers set status = 'signed', signed_at = now(), ip = left(p_ip, 100), ua = left(p_ua, 300), placements = p_placements where id = (r.signer).id;
  perform public.office_docs_event((r.esign).id, (r.signer).email, 'signed', p_ip, p_ua);
  select bool_and(status = 'signed') into done from public.office_esign_signers where esign_id = (r.esign).id;
  return jsonb_build_object('done', done, 'esign_id', (r.esign).id, 'signer_id', (r.signer).id);
end $$;

/** 서명본 합성 자료(서버 함수가 PDF를 만들 때) */
create function public.office_esign_public_bundle(p_esign uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', e.id, 'title', e.title, 'doc_hash', e.doc_hash, 'orig_path', e.orig_path, 'seg', public.office_docs_seg(e.scope), 'status', e.status, 'final_path', e.final_path, 'mail_account', e.mail_account,
    'signers', (select jsonb_agg(jsonb_build_object('id', s.id, 'ord', s.ord, 'name', s.name, 'email', s.email, 'status', s.status, 'signed_at', s.signed_at, 'ip', s.ip, 'placements', s.placements) order by s.ord) from public.office_esign_signers s where s.esign_id = e.id))
  from public.office_esign e where e.id = p_esign
$$;

/** 완료 — 서명본 경로·해시를 남기고, 연결된 거래가 견적 단계면 보낸 사람 권한으로 '계약'(order.confirm)으로 넘긴다.
 *  업무 원장 규칙을 다시 쓰지 않으려고 office_business_write를 그대로 부른다(그 함수는 auth.uid()로 권한을 보므로 이 트랜잭션 안에서만 보낸 사람으로 본다).
 *  넘기지 못해도(권한이 바뀜·재고 부족) 서명 완료는 그대로 — 사유를 order_sync에 남기고 화면이 알린다. */
create function public.office_esign_public_finalize(p_esign uuid, p_final_path text, p_final_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare e public.office_esign%rowtype; ord_status text; sync text; org uuid; old_sub text := current_setting('request.jwt.claim.sub', true); old_claims text := current_setting('request.jwt.claims', true);
begin
  select * into e from public.office_esign where id = p_esign for update;
  if not found then raise exception 'docs_not_found'; end if;
  if e.status = 'completed' then return jsonb_build_object('order_sync', e.order_sync, 'already', true); end if;
  if e.status <> 'sent' or exists(select 1 from public.office_esign_signers where esign_id = e.id and status <> 'signed') then raise exception 'docs_state'; end if;
  if p_final_path is distinct from public.office_docs_seg(e.scope) || '/esign/' || e.id || '/final.pdf' or coalesce(p_final_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'docs_input'; end if;
  if e.order_id is not null then
    select status into ord_status from public.office_business_orders where id = e.order_id;
    if ord_status is null then sync := 'missing';
    elsif ord_status <> 'draft' then sync := 'skipped:' || ord_status;
    elsif e.created_by is null then sync := 'failed:owner';
    else
      org := case when e.scope like 'o:%' then substr(e.scope, 3)::uuid end;
      begin
        perform set_config('request.jwt.claim.sub', e.created_by::text, true);
        perform set_config('request.jwt.claims', json_build_object('sub', e.created_by, 'role', 'authenticated')::text, true);
        perform public.office_business_write(org, md5('office-esign-confirm:' || e.id)::uuid, 'order.confirm', jsonb_build_object('id', e.order_id));
        sync := 'confirmed';
      exception when others then sync := left('failed:' || sqlerrm, 300);
      end;
      perform set_config('request.jwt.claim.sub', coalesce(old_sub, ''), true); -- 원래 호출자(service_role) 클레임으로 되돌린다
      perform set_config('request.jwt.claims', coalesce(old_claims, ''), true);
    end if;
  end if;
  update public.office_esign set status = 'completed', final_path = p_final_path, final_hash = p_final_hash, completed_at = clock_timestamp(), order_sync = sync where id = e.id;
  update public.office_esign_signers set token_hash = null where esign_id = e.id; -- 완료 뒤 링크 잠금(인트라넷: 완료 계약 접근 차단)
  perform public.office_docs_event(e.id, 'system', 'completed');
  return jsonb_build_object('order_sync', sync);
end $$;

create function public.office_esign_public_notified(p_esign uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.office_esign set notified_at = clock_timestamp() where id = p_esign and status = 'completed' and notified_at is null;
  if found then perform public.office_docs_event(p_esign, 'system', 'notified'); end if;
end $$;

/* ── 서버 정리(분리 검수 MEDIUM 1) — 화면을 아무도 열지 않아도 쌓이지 않게. service_role(서버 정리 함수·스크립트)만 부른다 ──
   Storage 객체는 SQL로 지우지 않는다(Supabase는 Storage API로만) — 이 함수는 지울 목록을 주고, 서버가 지운 뒤 office_storage_sweep_done이 행을 지운다.
   대상: ① 문서함 휴지통 30일 지난 파일의 객체 ② 하루 지난 행 없는 객체(문서함: 기록·열린 자리 없음 / 문서: 문서 PDF·서명 폴더의 기록 없음, 정해진 모양 밖 경로)
   함께: 하루 지난 올리기 자리·OCR 한도 줄은 여기서 지운다(쌓이는 운영 데이터). 실행 주기: 하루 1회(Vercel 크론 apps/office/vercel.json) — 한 번에 p_limit개. */
create or replace function public.office_storage_sweep(p_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare lim integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
begin
  delete from public.office_storage_slots where expires_at < now() - interval '1 day';
  delete from public.office_ocr_usage where hour < now() - interval '1 day';
  return jsonb_build_object('objects', coalesce((select jsonb_agg(jsonb_build_object('bucket', x.b, 'name', x.n)) from (
    (select 'office-files' b, f.storage_path n from public.office_files f where f.deleted_at < now() - interval '30 days' and f.storage_path is not null
       and exists (select 1 from storage.objects o where o.bucket_id = 'office-files' and o.name = f.storage_path) order by f.deleted_at limit lim)
    union all
    (select o.bucket_id, o.name from storage.objects o where o.bucket_id = 'office-files' and o.created_at < now() - interval '1 day'
       and not exists (select 1 from public.office_files f where f.storage_path = o.name)
       and not exists (select 1 from public.office_storage_slots s where s.bucket = 'office-files' and s.path = o.name and s.expires_at > now())
     order by o.created_at limit lim)
    union all
    (select o.bucket_id, o.name from storage.objects o where o.bucket_id = 'office-docs' and o.created_at < now() - interval '1 day'
       and not exists (select 1 from public.office_storage_slots s where s.bucket = 'office-docs' and s.path = o.name and s.expires_at > now())
       and not (case
         when o.name ~ '^[ou]-[0-9a-f-]{36}/docs/[0-9a-f-]{36}\.pdf$' then exists (select 1 from public.office_docs d where d.pdf_path = o.name)
         when o.name ~ '^[ou]-[0-9a-f-]{36}/esign/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then exists (select 1 from public.office_esign e
           where e.id = split_part(o.name, '/', 3)::uuid and public.office_docs_seg(e.scope) = split_part(o.name, '/', 1))
         else false end)
     order by o.created_at limit lim)
    limit lim) x), '[]'::jsonb));
end $$;
/** 서버가 객체를 지운 뒤 — 휴지통 30일 지난 문서함 행 중 객체가 없어진 것(링크 포함)만 지운다. 객체가 남으면 행을 남긴다 */
create or replace function public.office_storage_sweep_done() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  with d as (delete from public.office_files x where x.deleted_at < now() - interval '30 days'
      and (x.storage_path is null or not exists (select 1 from storage.objects o where o.bucket_id = 'office-files' and o.name = x.storage_path)) returning 1)
  select count(*) into n from d;
  return jsonb_build_object('rows', n);
end $$;
revoke all on function public.office_storage_sweep(integer), public.office_storage_sweep_done() from public, anon, authenticated;
grant execute on function public.office_storage_sweep(integer), public.office_storage_sweep_done() to service_role;

revoke all on function public.office_docs_seg(text), public.office_docs_event(uuid, text, text, text, text), public.office_docs_storage_ok(text, boolean),
  public.office_docs_signers_json(uuid), public.office_docs_esign_json(public.office_esign), public.office_docs_read(uuid), public.office_docs_get(uuid, text, uuid), public.office_docs_events(uuid, uuid),
  public.office_docs_clean_signers(jsonb), public.office_docs_write(uuid, text, jsonb),
  public.office_esign_public_find(text), public.office_esign_public_who(text, text), public.office_esign_public_state(text), public.office_esign_public_open(text, text, text, text),
  public.office_esign_public_submit(text, text, jsonb, text, text), public.office_esign_public_bundle(uuid), public.office_esign_public_finalize(uuid, text, text),
  public.office_esign_public_notified(uuid) from public, anon, authenticated;
grant execute on function public.office_docs_read(uuid), public.office_docs_get(uuid, text, uuid), public.office_docs_events(uuid, uuid), public.office_docs_write(uuid, text, jsonb), public.office_docs_storage_ok(text, boolean) to authenticated;
grant execute on function public.office_esign_public_who(text, text), public.office_esign_public_state(text), public.office_esign_public_open(text, text, text, text), public.office_esign_public_submit(text, text, jsonb, text, text),
  public.office_esign_public_bundle(uuid), public.office_esign_public_finalize(uuid, text, text), public.office_esign_public_notified(uuid) to service_role;
