-- Pro 첨부 상한(유건 2026-10-12 "프로도 용량 제한, 20GB · 파일 상한 500MB"): 무료 = 저장 1GB(20261011150000)·파일 25MB 그대로,
-- Pro·체험 = 저장 20GB·파일 500MB. 판정은 is_pro_for(결제·운영자 부여·유료 조직 좌석·남은 체험) — 새 판정을 만들지 않는다.
-- 파일 하나 상한이 플랜별로 갈리므로 버킷 전역 상한(file_size_limit)은 큰 쪽(500MB)으로 올리고, 플랜별 거절은 _msgr_upload_gate가 한다
-- (버킷 상한은 사용자를 모른다). 무료 총량과 같은 자리·같은 오류 체계(PT402)를 쓴다.
--
-- 켜고 끄기: msgr_settings 'pro_storage_limit_bytes' = Pro 총량 바이트(20GB = 21474836480). 없거나 숫자가 아니거나 0 이하면 Pro 총량은
--   무제한(꺼짐) — 무료 키(free_storage_limit_bytes)와 독립이다. 파일 하나 상한(무료 25MB · Pro 500MB)은 스위치 없이 항상 적용
--   (무료 25MB는 종전 버킷 설정이 하던 것을 계승한다).
-- 켜기(적용 뒤): insert into public.msgr_settings(key, value) values ('pro_storage_limit_bytes', '21474836480') on conflict (key) do update set value = excluded.value;
-- 적용: bash scripts/msgr-live-apply.sh 20261012120000_msgr_pro_storage_limit
-- 되돌리기: pro 키 삭제(Pro 총량 무제한으로). 파일 상한까지 되돌리려면 이 파일의 상수 2개와 버킷 값(26214400)을 함께 되돌린다.

-- 1) 파일 하나 상한 — 플랜별 한 곳. p_uid = 올리는 사람(에이전트 파일은 주인 — _msgr_attachment_uploader와 같은 기준).
create or replace function public._msgr_file_max(p_uid uuid) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public.is_pro_for(p_uid) then return 524288000; end if;
  return 26214400;
end $$;
revoke all on function public._msgr_file_max(uuid) from public, anon, authenticated;

-- 2) Pro 총량 한도 — 꺼져 있으면 NULL(행 없음·비숫자·0 이하는 꺼짐, 무료 키와 같은 규칙)
create or replace function public._msgr_pro_storage_limit() returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  select value into v from public.msgr_settings where key = 'pro_storage_limit_bytes';
  if coalesce(v, '') !~ '^[0-9]{1,18}$' or v::bigint <= 0 then return null; end if;
  return v::bigint;
end $$;
revoke all on function public._msgr_pro_storage_limit() from public, anon, authenticated;

-- 3) 플랜별 총량 한도 — Pro는 pro 키, 무료는 free 키. 둘 다 없으면 NULL(무제한)
create or replace function public._msgr_limit_for(p_uid uuid) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_uid is not null and public.is_pro_for(p_uid) then return public._msgr_pro_storage_limit(); end if;
  return public._msgr_storage_limit();
end $$;
revoke all on function public._msgr_limit_for(uuid) from public, anon, authenticated;

-- 4) 총량 판정 — 20261011150000의 "쓴 양 + 이번 크기 ≤ 한도"를 플랜별 한도로. Pro라고 무조건 참이던 꼬리(is_pro_for)는 없앤다(Pro 상한이 생겼으므로)
create or replace function public._msgr_upload_allowed(p_uid uuid, p_size bigint, p_except text default null) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare lim bigint := public._msgr_limit_for(p_uid);
begin
  if lim is null or p_uid is null then return true; end if;
  return public._msgr_storage_used(p_uid, p_except) + greatest(coalesce(p_size, 0), 1) <= lim;
end $$;
revoke all on function public._msgr_upload_allowed(uuid, bigint, text) from public, anon, authenticated;

-- 5) 게이트 — 파일 하나 판정을 앞에 둔다(총량과 다른 이유라 다른 이름). 오류는 중립(결제 유도 없음 — 봇 원문이 방에 실린다).
--    파일 초과는 PT413(HTTP 413을 본뜬 SQLSTATE) — storage-api가 원문을 감춰 'database error, code: …'로 돌려줘도 코드로 구분된다.
create or replace function public._msgr_upload_gate(p_uid uuid, p_size bigint, p_except text default null) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_uid is not null and greatest(coalesce(p_size, 0), 1) > public._msgr_file_max(p_uid) then
    raise exception 'msgr_file_too_large' using errcode = 'PT413',
      detail = 'file exceeds the per-file limit for this plan', hint = 'file_max_bytes';
  end if;
  if public._msgr_upload_allowed(p_uid, p_size, p_except) then return true; end if;
  raise exception 'msgr_storage_limit' using errcode = 'PT402',
    detail = 'attachment storage is full for this plan; existing files are kept', hint = 'storage_limit_bytes';
end $$;
revoke all on function public._msgr_upload_gate(uuid, bigint, text) from public, anon, authenticated;

-- 6) 봇 준비(20261011150000 정의) — 파일 상한을 플랜별로(오류 이름은 msgr_bot_file_too_large 그대로 — 연결 도구 어댑터의 413 계약). 총량은 아래 게이트 호출이 본다
create or replace function public.msgr_bot_attach_prepare(token text, p_message bigint, p_name text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; raw text := btrim(coalesce(p_name, '')); dot int; stem text; ext text; purge jsonb; space text; tw uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if raw = '' or length(raw) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'msgr_bot_bad_file_size'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if p_bytes > public._msgr_file_max(public._msgr_attachment_uploader(m.id)) then raise exception 'msgr_bot_file_too_large'; end if; -- 플랜별 상한(20261012120000, 주인 기준)
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(m.id), p_bytes); -- 총량 한도(20261011150000) — 에이전트 주인 몫, 봇이 신고한 크기(최소 1바이트)
  space := coalesce(m.org_id::text, 'p');
  tw := public._msgr_bot_twin(b.id);
  if (select count(*) from storage.objects o where o.bucket_id = 'msgr' and o.name like space || '/' || m.channel_id::text || '/' || m.id::text || '/bot-%') >= 10
    then raise exception 'msgr_bot_too_many_files'; end if; -- 올린 객체 기준(등록 안 한 것 포함) — 등록 없이 올리기만 반복해도 글당 10개
  dot := length(raw) - strpos(reverse(raw), '.') + 1;
  if strpos(raw, '.') = 0 or dot <= 1 then stem := raw; ext := '';
  else stem := left(raw, dot - 1); ext := left(regexp_replace(substr(raw, dot + 1), '[^A-Za-z0-9]', '', 'g'), 12); end if;
  stem := left(regexp_replace(regexp_replace(stem, '[^A-Za-z0-9._-]+', '_', 'g'), '^[_.]+|[_.]+$', '', 'g'), 60);
  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into purge from (
    select o.name from storage.objects o join public.msgr_messages x on x.id = (substring(o.name from '^(?:[0-9a-f-]{36}|p)/[0-9a-f-]{36}/([0-9]{1,18})/bot-'))::bigint
     where o.bucket_id = 'msgr' and o.name ~ '^([0-9a-f-]{36}|p)/[0-9a-f-]{36}/[0-9]{1,18}/bot-[0-9a-f]{8}-' and o.created_at < now() - interval '2 hours'
       and x.author_kind = 'crew' and ((x.crew_id = b.crew_id and x.org_id = b.org_id) or (tw is not null and x.crew_id = tw and x.org_id is null))
       and split_part(o.name, '/', 1) = coalesce(x.org_id::text, 'p') and split_part(o.name, '/', 2) = x.channel_id::text -- 폴더의 공간·방이 그 글과 같을 때만(재검수 LOW)
       and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name)
     order by o.created_at limit 20) o;
  return jsonb_build_object('purge', purge, 'storage_path', space || '/' || m.channel_id::text || '/' || m.id::text || '/bot-'
    || left(replace(gen_random_uuid()::text, '-', ''), 8) || '-' || coalesce(nullif(stem, ''), 'file') || case when ext <> '' then '.' || ext else '' end);
end $$;
revoke all on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) from public;
grant execute on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) to anon, authenticated;

-- 7) 봇 등록(20261002140000 정의) — 실제 크기 상한을 플랜별로
create or replace function public.msgr_bot_attach_commit(token text, p_message bigint, p_path text, p_name text, p_mime text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; obj record; got uuid; nm text := btrim(coalesce(p_name, ''));
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if nm = '' or length(nm) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if coalesce(p_path, '') !~ ('^' || coalesce(m.org_id::text, 'p') || '/' || m.channel_id::text || '/' || m.id::text || '/bot-[0-9a-f]{8}-[A-Za-z0-9._-]{1,80}$') then
    raise exception 'msgr_bot_bad_attach_path';
  end if;
  perform 1 from public.msgr_messages where id = m.id for update; -- 같은 글의 등록을 한 줄로 세운다(개수 상한·같은 경로 중복 등록)
  select id into got from public.msgr_attachments where message_id = m.id and storage_path = p_path;
  if got is not null then return got; end if;
  select (o.metadata->>'size')::bigint as bytes, (o.metadata->>'mimetype') as mime into obj from storage.objects o where o.bucket_id = 'msgr' and o.name = p_path;
  if not found then raise exception 'msgr_bot_upload_missing'; end if;
  if coalesce(obj.bytes, 0) > public._msgr_file_max(public._msgr_attachment_uploader(m.id)) then raise exception 'msgr_bot_file_too_large'; end if; -- 플랜별 상한(20261012120000)
  if (select count(*) from public.msgr_attachments where message_id = m.id) >= 10 then raise exception 'msgr_bot_too_many_files'; end if;
  insert into public.msgr_attachments(message_id, org_id, storage_path, name, mime, bytes)
    values (m.id, m.org_id, p_path, nm, left(coalesce(nullif(btrim(p_mime), ''), obj.mime), 200), coalesce(obj.bytes, 0))
    returning id into got;
  return got;
end $$;
revoke all on function public.msgr_bot_attach_commit(text, bigint, text, text, text) from public;

-- 8) 개인 방 첨부 판정(20261002100000 정의) — 크기 상한을 플랜별로(넣는 사람 기준)
create or replace function public.msgr_personal_attachment_ok(p_path text, p_message bigint) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if coalesce(p_path, '') not like 'p/%' or split_part(p_path, '/', 3) <> p_message::text or not public.msgr_personal_file_ok(p_path) then return false; end if;
  return exists (select 1 from storage.objects o where o.bucket_id = 'msgr' and o.name = p_path
                  and coalesce((o.metadata->>'size')::bigint, 0) <= public._msgr_file_max(auth.uid()));
end $$;
revoke all on function public.msgr_personal_attachment_ok(text, bigint) from public, anon, authenticated;
grant execute on function public.msgr_personal_attachment_ok(text, bigint) to authenticated;

-- 9) 첨부 행 트리거(20261011150000 정의) — 조기 반환이 무료 키만 보던 것을 두 키 모두로(분리 검수 M1: 무료 꺼짐 + Pro 켜짐이면
--    신고 크기만으로 Pro 총량을 우회했다). 파일 하나 상한은 한도 키와 무관하게 실제 크기로 항상 본다 — 버킷은 전역 천장만 알고,
--    신고 크기를 속인 업로드는 여기서 걸린다(개인 방은 msgr_personal_attachment_ok가 같은 판정을 한다)
create or replace function public.msgr_attachment_storage_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare real_size bigint; found_obj boolean := false;
begin
  select true, o.size into found_obj, real_size from public._msgr_live_objects() o where o.name = new.storage_path limit 1; -- 지금 버전(보관본·삭제 표시 제외)
  if real_size is not null then new.bytes := real_size; end if;
  if new.bytes > public._msgr_file_max(public._msgr_attachment_uploader(new.message_id)) then
    raise exception 'msgr_file_too_large' using errcode = 'PT413',
      detail = 'file exceeds the per-file limit for this plan', hint = 'file_max_bytes';
  end if;
  if public._msgr_storage_limit() is null and public._msgr_pro_storage_limit() is null then return new; end if; -- 총량 두 키 모두 꺼짐 — 거절 없음
  if exists (select 1 from public.msgr_attachments a where a.storage_path = new.storage_path) then return new; end if; -- 같은 객체 재사용 — 새 저장 아님
  if not coalesce(found_obj, false) then raise exception 'msgr_attach_upload_missing' using detail = 'upload the file before adding its attachment row'; end if;
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(new.message_id), new.bytes, new.storage_path);
  return new;
end $$;
revoke all on function public.msgr_attachment_storage_gate() from public, anon, authenticated;

-- 10) 버킷 전역 상한을 큰 쪽(500MB)으로 — 플랜별 상한은 5)·9)가 한다. 열이 없는 환경(시험 흉내 표)에서는 건너뛴다
do $$
begin
  if to_regclass('storage.buckets') is not null
     and exists (select 1 from pg_attribute where attrelid = 'storage.buckets'::regclass and attname = 'file_size_limit' and not attisdropped) then
    update storage.buckets set file_size_limit = 524288000 where id = 'msgr';
  end if;
end $$;

notify pgrst, 'reload schema';
