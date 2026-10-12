-- 유료 조직에 좌석 없이 들어온 사람(손님)의 첨부는 그 조직의 용량 할당량에서 쓴다(유건 2026-10-12).
-- 종전(20261011150000·20261012120000): 손님은 올린 사람 기준이라 조직 방에 올려도 본인 무료 1GB·파일 25MB에 걸렸다.
-- 바뀐 것 — 손님이 유료 조직(msgr_org_entitlements.paid_until > now(), 조직 보관 아님)의 공간(경로 첫 칸 = 조직 id)에 올리면:
--   · 총량은 조직 할당량으로 판정한다 = 좌석 수 × 좌석당 용량. 좌석당 용량 = 설정 org_storage_seat_bytes, 없으면 Pro 개인 한도(pro_storage_limit_bytes, 20GB).
--     둘 다 없으면 조직 할당량도 무제한(다른 스위치와 같은 규칙 — 적용만으로는 켜지지 않는다).
--   · 조직 사용량 = 그 조직 폴더(<org>/…)에 지금 있는 객체 전부(멤버·손님·에이전트 파일) — 조직이 낸 좌석만큼의 묶음을 함께 쓴다.
--   · 그 파일은 손님 본인 사용량(무료 1GB)에서 뺀다. 파일 하나 상한은 조직 플랜(Pro)과 같은 500MB.
--   좌석 멤버(is_pro_for 참)는 종전대로 본인 Pro 한도로 판정한다. 손님의 개인 공간·무료 조직 공간은 종전대로 본인 한도.
-- 판정 자리(종전과 같다): 앱·게이트웨이 업로드 정책(msgr_upload_check — 경로에서 조직), 첨부 행 트리거(저장 경로 첫 칸), 봇 준비·등록(글의 조직).
-- 함수 모양: 종전 _msgr_upload_gate(uuid, bigint, text)는 그대로 두고 조직 문맥을 받는 _msgr_upload_gate_in을 더한다(인자를 바꾸면 옛 정의와 겹친다).
-- 부하: 손님이 유료 조직 공간에 올릴 때만 조직 폴더 범위 합계 1회(버킷 (bucket_id, name) 색인 앞부분). 그 밖은 종전과 같다. 쓰기 0.
-- 켜기 예: insert into public.msgr_settings(key, value) values ('org_storage_seat_bytes', '21474836480') on conflict (key) do update set value = excluded.value;
-- 적용: bash scripts/msgr-live-apply.sh 20261012140000_msgr_org_guest_storage

-- 1) 유료 조직의 손님인가(좌석 없음)
create or replace function public._msgr_org_guest_pool(p_uid uuid, p_org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_uid is not null and p_org is not null and exists (
    select 1 from public.msgr_org_members m
      join public.msgr_org_entitlements e on e.org_id = m.org_id
      join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
     where m.org_id = p_org and m.user_id = p_uid and m.removed_at is null and m.role = 'guest'
       and (m.expires_at is null or m.expires_at > now()) and e.paid_until > now())
$$;
revoke all on function public._msgr_org_guest_pool(uuid, uuid) from public, anon, authenticated;

-- 2) 좌석당 용량 — org_storage_seat_bytes, 없거나 틀린 값이면 Pro 개인 한도. 둘 다 없으면 NULL(무제한)
create or replace function public._msgr_org_seat_bytes() returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  select value into v from public.msgr_settings where key = 'org_storage_seat_bytes';
  if coalesce(v, '') ~ '^[0-9]{1,18}$' and v::bigint > 0 then return v::bigint; end if;
  return public._msgr_pro_storage_limit();
end $$;
revoke all on function public._msgr_org_seat_bytes() from public, anon, authenticated;

-- 3) 조직 할당량 = 좌석 수(최소 1) × 좌석당 용량
create or replace function public._msgr_org_storage_limit(p_org uuid) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when b.v is null then null else greatest(coalesce((select e.seats from public.msgr_org_entitlements e where e.org_id = p_org), 0), 1)::bigint * b.v end
    from (select public._msgr_org_seat_bytes() v) b
$$;
revoke all on function public._msgr_org_storage_limit(uuid) from public, anon, authenticated;

-- 4) 조직 사용량 = 그 조직 폴더의 지금 객체 합(p_except = 지금 등록 중인 경로 — 트리거가 그 크기를 따로 더한다)
create or replace function public._msgr_org_storage_used(p_org uuid, p_except text default null) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n bigint := 0;
begin
  if p_org is null then return 0; end if;
  select coalesce(sum(o.size), 0) into n from public._msgr_live_objects() o
   where o.name like p_org::text || '/%' and o.name is distinct from p_except;
  return n;
end $$;
revoke all on function public._msgr_org_storage_used(uuid, text) from public, anon, authenticated;

-- 5) 개인 사용량(20261011150000 정의) — 유료 조직 손님으로 그 조직 폴더에 있는 파일은 빼고(조직 할당량에서 센다)
create or replace function public._msgr_storage_used(p_uid uuid, p_except text default null) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n bigint := 0; pools text[];
begin
  if p_uid is null then return 0; end if;
  select coalesce(array_agg(m.org_id::text), '{}') into pools
    from public.msgr_org_members m
    join public.msgr_org_entitlements e on e.org_id = m.org_id
    join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
   where m.user_id = p_uid and m.removed_at is null and m.role = 'guest' and e.paid_until > now(); -- 손님 기한(expires_at)은 보지 않는다: 기한이 지나도 파일은 조직 폴더에 남아 조직 사용량에 잡히므로 본인 사용량으로 되돌리면 두 번 센다
  select coalesce(sum(o.size), 0) into n from public._msgr_live_objects() o
   where o.name is distinct from p_except
     and not (split_part(o.name, '/', 1) = any(pools))
     and case when o.owner_id is not null then o.owner_id = p_uid else coalesce(public._msgr_path_uploader(o.name) = p_uid, false) end;
  return n;
end $$;
revoke all on function public._msgr_storage_used(uuid, text) from public, anon, authenticated;

-- 6) 파일 하나 상한 — 조직 문맥(유료 조직 손님 = 조직 플랜과 같은 500MB)
create or replace function public._msgr_file_max_in(p_uid uuid, p_org uuid) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr_org_guest_pool(p_uid, p_org) then return 524288000; end if;
  return public._msgr_file_max(p_uid);
end $$;
revoke all on function public._msgr_file_max_in(uuid, uuid) from public, anon, authenticated;

-- 7) 판정 — 조직 문맥. 유료 조직 손님이면 조직 할당량, 아니면 종전 판정(_msgr_upload_gate)
create or replace function public._msgr_upload_gate_in(p_uid uuid, p_size bigint, p_except text, p_org uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare lim bigint;
begin
  if not public._msgr_org_guest_pool(p_uid, p_org) then return public._msgr_upload_gate(p_uid, p_size, p_except); end if;
  if greatest(coalesce(p_size, 0), 1) > public._msgr_file_max_in(p_uid, p_org) then
    raise exception 'msgr_file_too_large' using errcode = 'PT413', detail = 'file exceeds the per-file limit for this plan', hint = 'file_max_bytes';
  end if;
  lim := public._msgr_org_storage_limit(p_org);
  if lim is null or public._msgr_org_storage_used(p_org, p_except) + greatest(coalesce(p_size, 0), 1) <= lim then return true; end if;
  raise exception 'msgr_storage_limit' using errcode = 'PT402',
    detail = 'organization attachment storage is full; existing files are kept', hint = 'org_storage_limit_bytes';
end $$;
revoke all on function public._msgr_upload_gate_in(uuid, bigint, text, uuid) from public, anon, authenticated;

-- 8) 업로드 정책 판정 — 경로 첫 칸이 조직 id면 그 조직 문맥(개인 방 'p'는 NULL)
create or replace function public.msgr_upload_check(p_row jsonb) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n text := p_row->'metadata'->>'contentLength';
begin
  return public._msgr_upload_gate_in(auth.uid(), case when n ~ '^[0-9]{1,18}$' then n::bigint else 0 end, null,
                                     public.msgr_uuid_or_null(split_part(coalesce(p_row->>'name', ''), '/', 1)));
end $$;
revoke all on function public.msgr_upload_check(jsonb) from public, anon;
grant execute on function public.msgr_upload_check(jsonb) to authenticated;

-- 9) 첨부 행 트리거(20261012120000 정의) — 조직 문맥(저장 경로 첫 칸 = 업로드 정책과 같은 기준)으로 파일 상한·총량, 조직 할당량 스위치도 조기 반환에 넣는다
create or replace function public.msgr_attachment_storage_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare real_size bigint; found_obj boolean := false; who uuid; ctx uuid := public.msgr_uuid_or_null(split_part(coalesce(new.storage_path, ''), '/', 1));
begin
  select true, o.size into found_obj, real_size from public._msgr_live_objects() o where o.name = new.storage_path limit 1; -- 지금 버전(보관본·삭제 표시 제외)
  if real_size is not null then new.bytes := real_size; end if;
  who := public._msgr_attachment_uploader(new.message_id);
  if new.bytes > public._msgr_file_max_in(who, ctx) then
    raise exception 'msgr_file_too_large' using errcode = 'PT413', detail = 'file exceeds the per-file limit for this plan', hint = 'file_max_bytes';
  end if;
  if public._msgr_storage_limit() is null and public._msgr_org_seat_bytes() is null then return new; end if; -- 총량 키 모두 꺼짐(좌석당 용량은 Pro 키를 따르므로 셋 다 꺼짐) — 거절 없음
  if exists (select 1 from public.msgr_attachments a where a.storage_path = new.storage_path) then return new; end if; -- 같은 객체 재사용 — 새 저장 아님
  if not coalesce(found_obj, false) then raise exception 'msgr_attach_upload_missing' using detail = 'upload the file before adding its attachment row'; end if;
  perform public._msgr_upload_gate_in(who, new.bytes, new.storage_path, ctx);
  return new;
end $$;
revoke all on function public.msgr_attachment_storage_gate() from public, anon, authenticated;

-- 10) 봇 준비·등록(20261012120000 정의) — 글의 조직 문맥으로 파일 상한·총량
create or replace function public.msgr_bot_attach_prepare(token text, p_message bigint, p_name text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; raw text := btrim(coalesce(p_name, '')); dot int; stem text; ext text; purge jsonb; space text; tw uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if raw = '' or length(raw) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'msgr_bot_bad_file_size'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if p_bytes > public._msgr_file_max_in(public._msgr_attachment_uploader(m.id), m.org_id) then raise exception 'msgr_bot_file_too_large'; end if; -- 플랜별 상한(20261012120000, 주인 기준)
  perform public._msgr_upload_gate_in(public._msgr_attachment_uploader(m.id), p_bytes, null, m.org_id); -- 총량 한도(20261011150000) — 에이전트 주인 몫, 봇이 신고한 크기(최소 1바이트)
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
  if coalesce(obj.bytes, 0) > public._msgr_file_max_in(public._msgr_attachment_uploader(m.id), m.org_id) then raise exception 'msgr_bot_file_too_large'; end if; -- 플랜별 상한(20261012120000)
  if (select count(*) from public.msgr_attachments where message_id = m.id) >= 10 then raise exception 'msgr_bot_too_many_files'; end if;
  insert into public.msgr_attachments(message_id, org_id, storage_path, name, mime, bytes)
    values (m.id, m.org_id, p_path, nm, left(coalesce(nullif(btrim(p_mime), ''), obj.mime), 200), coalesce(obj.bytes, 0))
    returning id into got;
  return got;
end $$;
revoke all on function public.msgr_bot_attach_commit(text, bigint, text, text, text) from public;

notify pgrst, 'reload schema';
