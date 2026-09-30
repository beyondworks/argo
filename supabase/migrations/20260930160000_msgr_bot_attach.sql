-- 봇(외부 에이전트)이 파일을 올린다 — 유건 2026-09-30: "헤르메스 포함 외부 에이전트랑 내부 에이전트 모두 파일 송수신 등이 가능해야해".
-- 받기는 20260912001000(getUpdates attachments + getFile)에 있다. 이 파일은 보내기와, 글보다 늦게 붙는 첨부의 방송을 더한다.
-- 유건 승인 기준(2026-09-30): ① 대화 중이면 봇의 답글에, 원문이 없으면(예약 작업) 결과 방의 봇 새 글에 붙는다 ② 파일당 25MB(버킷 한도와 같다)
--   ③ 봇이 글을 쓸 수 있는 방만 ④ 첨부는 지우지 않는다(사람 첨부와 같은 기억 데이터).
-- 흐름: 준비(msgr_bot_attach_prepare, 쓰기 없음) → 엣지가 서명 업로드 주소를 발급 → 봇이 저장소에 직접 PUT → 등록(msgr_bot_attach_commit).
-- 파일 바이트가 엣지 함수를 거치지 않는다(요청 크기 제한·메모리). 등록은 저장소에 실제로 있는 객체의 크기로 한다(봇이 말한 크기를 믿지 않는다).
-- 올리기만 하고 등록하지 않은 객체(등록 실패·중단)는 쌓이지 않게: 글 폴더당 올린 객체 10개가 상한이고(등록 여부 무관), 준비할 때마다
-- 이 봇이 2시간 넘게 등록하지 않은 객체 목록(purge)을 돌려줘 엣지가 Storage API로 지운다(storage.objects는 SQL 삭제가 막혀 있다 — protect_objects_delete).

-- 봇이 첨부를 붙일 수 있는 글 — 자기 크루가 1시간 안에 쓴 지우지 않은 글이고, 크루가 아직 그 방에 있다.
create or replace function public._msgr_bot_attach_target(b public.msgr_bots, p_message bigint) returns public.msgr_messages
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m public.msgr_messages;
begin
  select * into m from public.msgr_messages where id = p_message and org_id = b.org_id and author_kind = 'crew' and crew_id = b.crew_id and deleted_at is null;
  if m.id is null then raise exception 'msgr_bot_bad_attach_target'; end if;
  if public.msgr_org_locked(b.org_id) or not exists (select 1 from public.msgr_crews c join public.msgr_org_members om on om.org_id = c.org_id and om.user_id = c.owner_user_id and om.removed_at is null
    where c.id = b.crew_id and c.status = 'active') then raise exception 'msgr_not_allowed'; end if; -- msgr_bot_send와 같은 조건
  if m.created_at < now() - interval '1 hour' then raise exception 'msgr_bot_attach_expired'; end if;
  if not public.msgr_crew_in_channel(m.channel_id, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  return m;
end $$;
revoke all on function public._msgr_bot_attach_target(public.msgr_bots, bigint) from public, anon, authenticated;

-- 준비: 저장 경로만 정한다(DB 쓰기 없음). 경로 = <org>/<channel>/<message>/bot-<8자>-<ASCII 이름> — 앱의 storageKey와 같은 이유로 ASCII만
-- (Supabase Storage가 한글·공백 키를 거절한다). 표시 이름은 등록 때 원문 그대로 남긴다.
create or replace function public.msgr_bot_attach_prepare(token text, p_message bigint, p_name text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; raw text := btrim(coalesce(p_name, '')); dot int; stem text; ext text; purge jsonb;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if raw = '' or length(raw) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'msgr_bot_bad_file_size'; end if;
  if p_bytes > 26214400 then raise exception 'msgr_bot_file_too_large'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if (select count(*) from storage.objects o where o.bucket_id = 'msgr' and o.name like m.org_id::text || '/' || m.channel_id::text || '/' || m.id::text || '/bot-%') >= 10
    then raise exception 'msgr_bot_too_many_files'; end if; -- 올린 객체 기준(등록 안 한 것 포함) — 등록 없이 올리기만 반복해도 글당 10개
  dot := length(raw) - strpos(reverse(raw), '.') + 1;
  if strpos(raw, '.') = 0 or dot <= 1 then stem := raw; ext := '';
  else stem := left(raw, dot - 1); ext := left(regexp_replace(substr(raw, dot + 1), '[^A-Za-z0-9]', '', 'g'), 12); end if;
  stem := left(regexp_replace(regexp_replace(stem, '[^A-Za-z0-9._-]+', '_', 'g'), '^[_.]+|[_.]+$', '', 'g'), 60);
  -- ponytail: msgr 버킷의 bot- 객체를 훑는다(2026-09-30 버킷 전체 37개). 커지면 (bucket_id, name) 앞부분 조건으로 좁힌다.
  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into purge from (
    select o.name from storage.objects o join public.msgr_messages x on x.id = (substring(o.name from '^[0-9a-f-]{36}/[0-9a-f-]{36}/([0-9]{1,18})/bot-'))::bigint
     where o.bucket_id = 'msgr' and o.name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9]{1,18}/bot-[0-9a-f]{8}-' and o.created_at < now() - interval '2 hours'
       and x.author_kind = 'crew' and x.crew_id = b.crew_id and x.org_id = b.org_id
       and split_part(o.name, '/', 1) = x.org_id::text and split_part(o.name, '/', 2) = x.channel_id::text -- 폴더의 조직·방이 그 글과 같을 때만(재검수 LOW)
       and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name)
     order by o.created_at limit 20) o;
  return jsonb_build_object('purge', purge, 'storage_path', m.org_id::text || '/' || m.channel_id::text || '/' || m.id::text || '/bot-'
    || left(replace(gen_random_uuid()::text, '-', ''), 8) || '-' || coalesce(nullif(stem, ''), 'file') || case when ext <> '' then '.' || ext else '' end);
end $$;
revoke all on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) from public;
grant execute on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) to anon, authenticated;

-- 등록: 저장소에 올라온 객체를 확인하고 첨부 행을 만든다. 같은 경로를 다시 등록하면 같은 id(재시도 안전).
create or replace function public.msgr_bot_attach_commit(token text, p_message bigint, p_path text, p_name text, p_mime text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; obj record; got uuid; nm text := btrim(coalesce(p_name, ''));
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if nm = '' or length(nm) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if coalesce(p_path, '') !~ ('^' || m.org_id::text || '/' || m.channel_id::text || '/' || m.id::text || '/bot-[0-9a-f]{8}-[A-Za-z0-9._-]{1,80}$') then
    raise exception 'msgr_bot_bad_attach_path';
  end if;
  perform 1 from public.msgr_messages where id = m.id for update; -- 같은 글의 등록을 한 줄로 세운다(개수 상한·같은 경로 중복 등록)
  select id into got from public.msgr_attachments where message_id = m.id and storage_path = p_path;
  if got is not null then return got; end if;
  select (o.metadata->>'size')::bigint as bytes, o.metadata->>'mimetype' as mime into obj from storage.objects o where o.bucket_id = 'msgr' and o.name = p_path;
  if not found then raise exception 'msgr_bot_upload_missing'; end if;
  if coalesce(obj.bytes, 0) > 26214400 then raise exception 'msgr_bot_file_too_large'; end if;
  if (select count(*) from public.msgr_attachments where message_id = m.id) >= 10 then raise exception 'msgr_bot_too_many_files'; end if;
  insert into public.msgr_attachments(message_id, org_id, storage_path, name, mime, bytes)
    values (m.id, m.org_id, p_path, nm, left(coalesce(nullif(btrim(p_mime), ''), obj.mime), 200), coalesce(obj.bytes, 0))
    returning id into got;
  return got;
end $$;
revoke all on function public.msgr_bot_attach_commit(text, bigint, text, text, text) from public;
grant execute on function public.msgr_bot_attach_commit(text, bigint, text, text, text) to anon, authenticated;

-- 첨부 방송 — 첨부는 글보다 0.2~3.6초 늦게 등록된다(운영 실측 2026-09-30, 크루 21건·사람 15건). 앱은 글 방송을 받자마자 첨부를 읽으므로
-- 그 사이에 붙은 첨부는 채널을 다시 열 때까지 안 보였다. 첨부가 등록되면 같은 방 수신자에게 'attach'(글 id)를 보내 앱이 그 글의 첨부를 다시 읽는다.
-- 사람·Argo 크루·봇 첨부 모두 이 한 곳을 지난다. 수신자 규칙은 글 방송(msgr_message_broadcast)과 같다.
create or replace function public.msgr_attachment_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.msgr_messages; p jsonb;
begin
  select * into m from public.msgr_messages where id = new.message_id;
  if m.id is null then return new; end if;
  p := jsonb_build_object('id', m.id, 'message_id', m.id, 'channel_id', m.channel_id, 'crew_id', m.crew_id);
  if m.org_id is null then perform realtime.send(p, 'attach', 'dm:' || m.channel_id::text, true); end if;
  perform public.msgr_room_send(p, 'attach', m.org_id, m.channel_id);
  return new;
end $$;
revoke all on function public.msgr_attachment_broadcast() from public, anon, authenticated;
drop trigger if exists msgr_attachments_broadcast on public.msgr_attachments;
create trigger msgr_attachments_broadcast after insert on public.msgr_attachments for each row execute function public.msgr_attachment_broadcast();

notify pgrst, 'reload schema';
