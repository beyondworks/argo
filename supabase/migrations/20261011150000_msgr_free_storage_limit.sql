-- 무료 계정 메신저 첨부 저장 한도(유건 2026-10-11 확정): 무료 = 저장 용량 1GB, 파일 하나 25MB(msgr 버킷 file_size_limit 26214400 — 이미 운영에 있다).
-- Pro는 이번 변경으로 용량 제한을 새로 걸지 않는다. 판정은 public.is_pro_for(uid)(결제·운영자 부여·유료 조직 좌석·남은 체험) — 새 판정을 만들지 않는다
-- (msgr_free_grace 유예는 방 인원 한도용이라 쓰지 않는다 — 20261010200000과 같다).
--
-- 켜고 끄기: msgr_settings 'free_storage_limit_bytes' = 한도 바이트(1GB = 1073741824). 행이 없거나 숫자가 아니거나 0 이하면 꺼짐(기본).
--   결제 경로(PR #944)가 열리는 발행 날 값을 넣어 켠다. 이 마이그레이션만으로는 아무것도 막지 않는다.
--
-- 누구 몫인가: 첨부를 올린 사람 = 사람 글이면 글쓴이, 에이전트 글(앱·게이트웨이·외부 봇)이면 에이전트 주인. 첨부 행에 uploader_id로 남긴다(트리거가 채운다 —
--   앱이 보낸 값은 믿지 않는다). 크기도 앱이 보낸 bytes가 아니라 저장소 객체의 실제 크기로 채운다(조직 첨부 행 정책은 객체·크기를 보지 않는다).
--   10/2 결정(개인 공간·개인 대화 = 올린 사람, 조직 공간 = 조직 풀) 중 조직 풀 계산은 이번 범위 밖이다 — 지금은 조직 공간 파일도 올린 사람 몫이고,
--   유료 좌석 조직의 멤버는 is_pro_for가 참이라 걸리지 않는다(좌석이 아닌 손님은 무료와 같다).
--   같은 객체를 다시 가리키는 행(게이트웨이 재사용 — 같은 방·같은 내용)은 새 저장이 아니라 한도에 걸지 않고, 사용량도 경로당 한 번만 센다.
--
-- 판정 규칙(하나): 지금 쓴 양 < 한도이면 새 파일 하나를 받는다. 그래서 한도를 넘기는 마지막 한 파일(최대 25MB)까지는 들어간다.
--   이유: 앱 업로드의 Storage 정책은 크기를 모른다 — storage-api(v1.41.8 uploader.canUpload)는 크기 없이 사용자 권한으로 행 넣기를 시험하고(정책 판정),
--   올린 뒤에는 슈퍼유저로 크기를 채운다(정책 밖). "쓴 양 + 이 파일 크기"로 막으려면 올린 뒤(첨부 행)에야 막을 수 있는데, 그러면 이미 올라간 객체가
--   주인 없이 남고 앱 업로드에는 그것을 지우는 길이 없다(DB 위생). 업로드 전에 막을 수 있는 규칙으로 통일한다.
-- 판정 자리(모두 public._msgr_upload_gate 하나를 지난다):
--   1) 앱·게이트웨이 업로드 — storage.objects 제한(RESTRICTIVE) 정책 msgr_files_storage_limit. msgr 버킷의 세 허용 정책(msgr_files_insert·
--      msgr_personal_files_insert·msgr_dm_output_insert)과 앞으로 생길 허용 정책에 모두 걸린다. 다른 버킷(아바타·companies)은 CASE로 건너뛴다.
--   2) 첨부 행 — msgr_attachments BEFORE INSERT 트리거(올린 사람·크기 채우기 + 판정). 서명 업로드처럼 Storage 정책 밖에서 올라온 객체의 등록도 여기서 막힌다.
--   3) 외부 봇 준비(msgr_bot_attach_prepare) — 서명 업로드 주소를 주기 전에(쓰기 없는 빠른 거절). 등록(msgr_bot_attach_commit)은 2)가 막는다.
--   아바타(msgr-avatars)는 사람마다 한 장을 덮어쓰는 프로필 사진이라 첨부 저장 공간이 아니다 — 제외.
-- 오류: 'msgr_storage_limit' (SQLSTATE PT402). PostgREST는 402와 이 문구를, storage-api는 'database error, code: PT402'를 돌려준다(원문을 숨긴다) —
--   앱은 둘 다 본다. 엣지 msgr-bot ERR 표에 같은 이름이 있다.
--
-- 기존 파일: 지우지 않는다. 이미 한도를 넘은 무료 사용자는 새로 올릴 때만 막힌다(읽기·내려받기 그대로).
-- 운영 분포(2026-10-11 읽기): 첨부가 있는 사용자 16명(무료 13·Pro 3), 무료 합계 270MB·최대 127MB — 1GB를 넘은 사람 0명, 100MB 넘은 무료 1명.
--
-- 부하(DB 위생): 주기 작업·폴링·캐시 표 없음. 판정은 읽기만 한다(쓰기 0).
--   업로드 한 번 = Storage 정책 1회: 설정 PK 1회(꺼져 있으면 여기서 끝) + 켜져 있으면 사용량 합계 1회(이 사람 첨부 행만 색인으로) + 한도에 닿은 사람만 is_pro_for 1회.
--   첨부 행 한 줄 = 트리거 1회: 글 PK 1회 + (에이전트 글이면) 크루 PK 1회 + 저장소 객체 (bucket_id, name) 색인 1회 + 설정 PK 1회 + 켜져 있으면 같은 경로 존재 확인(색인)·
--   사용량 합계·is_pro_for(닿았을 때만). 추가 쓰기 0(같은 행의 열 두 개를 채울 뿐).
--   사용량 합계는 msgr_attachments(uploader_id, storage_path) INCLUDE (bytes) 색인 — 그 사람 행 수에만 비례한다(storage.objects 전체를 훑지 않는다. #876에서
--   storage.objects 오너 훑기가 444ms였다. storage.objects는 supabase_storage_admin 소유라 색인·트리거를 붙일 수 없다).
--   캐시 표(사용자별 합계를 트리거로 갱신)를 쓰지 않은 이유: 첨부마다 한 행을 다시 쓰고(죽은 행), 삭제·재사용·cascade마다 어긋날 수 있다. 1GB 무료 사용자의 첨부는
--   많아야 수천 행이라 색인 합계로 충분하다.
-- 알려진 한계: 첨부 행 없이 저장소에만 올린 객체(앱을 거치지 않은 직접 업로드)는 사용량에 들지 않는다 — 운영 미등록 객체 0건(2026-10-11). 업로드는 한도 미만일 때만
--   열리므로 정상 앱 흐름에서는 생기지 않는다. 막으려면 업로드 경로를 자기 글 폴더로 묶는 별도 변경이 필요하다.
--
-- 적용: bash scripts/msgr-live-apply.sh 20261011150000_msgr_free_storage_limit — storage.objects 정책 생성이 있다(#872 선잠금 대상).
--   msgr_attachments에 열 추가(메타데이터만) + 기존 행 채우기(운영 521행) + 색인.
-- 켜기(발행 날): insert into public.msgr_settings(key, value) values ('free_storage_limit_bytes', '1073741824') on conflict (key) do update set value = excluded.value;
-- 끄기: delete from public.msgr_settings where key = 'free_storage_limit_bytes';
-- 되돌리기(데이터를 지우지 않는다): 끄기 → drop policy msgr_files_storage_limit on storage.objects; drop trigger msgr_attachments_fill_uploader on public.msgr_attachments;
--   msgr_bot_attach_prepare를 20261002140000 정의로 다시 적용. uploader_id 열·색인은 남겨도 무해(지우려면 drop index·drop column).

-- 1) 올린 사람 열 + 사용량 색인
alter table public.msgr_attachments add column if not exists uploader_id uuid;
create index if not exists msgr_attachments_uploader on public.msgr_attachments (uploader_id, storage_path) include (bytes) where uploader_id is not null;

-- 첨부 행 → 올린 사람(사람 글 = 글쓴이, 에이전트 글 = 에이전트 주인). 알 수 없으면(주인 없는 크루 등) NULL — 세지도 막지도 않는다.
create or replace function public._msgr_attachment_uploader(p_message bigint) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when m.author_kind = 'user' then m.author_user_id
              when m.author_kind = 'crew' then (select c.owner_user_id from public.msgr_crews c where c.id = m.crew_id) end
    from public.msgr_messages m where m.id = p_message
$$;
revoke all on function public._msgr_attachment_uploader(bigint) from public, anon, authenticated;

-- 기존 행 채우기(비어 있는 것만 — 다시 적용해도 같다)
update public.msgr_attachments a set uploader_id = public._msgr_attachment_uploader(a.message_id)
 where a.uploader_id is null and public._msgr_attachment_uploader(a.message_id) is not null;

-- 2) 사용량 — 그 사람이 올린 첨부의 경로별 크기 합(같은 경로는 한 번)
create or replace function public._msgr_storage_used(p_uid uuid) returns bigint
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(b), 0)::bigint from (select max(a.bytes) b from public.msgr_attachments a where a.uploader_id = p_uid group by a.storage_path) x
$$;
revoke all on function public._msgr_storage_used(uuid) from public, anon, authenticated;

-- 3) 판정 — 스위치 꺼짐·올린 사람 모름이면 참, 쓴 양 < 한도면 참, Pro면 참.
create or replace function public._msgr_upload_allowed(p_uid uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text; lim bigint;
begin
  select value into v from public.msgr_settings where key = 'free_storage_limit_bytes';
  if p_uid is null or coalesce(v, '') !~ '^[0-9]{1,18}$' then return true; end if;
  lim := v::bigint;
  if lim <= 0 then return true; end if;
  if public._msgr_storage_used(p_uid) < lim then return true; end if;
  return public.is_pro_for(p_uid);
end $$;
revoke all on function public._msgr_upload_allowed(uuid) from public, anon, authenticated;

-- 판정 + 오류 한 곳. 참이면 true, 아니면 msgr_storage_limit.
create or replace function public._msgr_upload_gate(p_uid uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr_upload_allowed(p_uid) then return true; end if;
  raise exception 'msgr_storage_limit' using errcode = 'PT402',
    detail = 'free plan attachment storage is full — existing files stay; upgrade to Pro to upload more',
    hint = 'free_storage_limit_bytes';
end $$;
revoke all on function public._msgr_upload_gate(uuid) from public, anon, authenticated;

-- Storage 정책용 — 호출한 사람 자신만 판정한다(남의 사용량·플랜을 묻는 통로가 되지 않게 uid를 받지 않는다).
create or replace function public.msgr_upload_check() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public._msgr_upload_gate(auth.uid())
$$;
revoke all on function public.msgr_upload_check() from public, anon;
grant execute on function public.msgr_upload_check() to authenticated;

-- 4) 앱·게이트웨이 업로드 — msgr 버킷 insert 전부에 거는 제한 정책. CASE로 다른 버킷은 판정 함수를 부르지 않는다(OR은 평가 순서를 보장하지 않는다).
drop policy if exists msgr_files_storage_limit on storage.objects;
create policy msgr_files_storage_limit on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'msgr' then public.msgr_upload_check() else true end);

-- 5) 첨부 행 — 올린 사람·실제 크기를 채우고, 새 저장이면 판정한다.
create or replace function public.msgr_attachments_fill_uploader() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare real_size bigint;
begin
  new.uploader_id := public._msgr_attachment_uploader(new.message_id);
  if to_regclass('storage.objects') is not null then
    -- to_jsonb: 열 이름을 실행할 때 찾는다(metadata 열이 없는 Storage 흉내 표에서도 트리거가 깨지지 않게 — 운영 표에는 있다)
    select (to_jsonb(o)->'metadata'->>'size')::bigint into real_size from storage.objects o where o.bucket_id = 'msgr' and o.name = new.storage_path limit 1;
    if real_size is not null then new.bytes := real_size; end if;
  end if;
  -- 같은 객체를 이미 가리키는 행이 있으면 새 저장이 아니다(재사용) — 판정하지 않는다
  if not exists (select 1 from public.msgr_attachments a where a.storage_path = new.storage_path) then
    perform public._msgr_upload_gate(new.uploader_id);
  end if;
  return new;
end $$;
revoke all on function public.msgr_attachments_fill_uploader() from public, anon, authenticated;
drop trigger if exists msgr_attachments_fill_uploader on public.msgr_attachments;
create trigger msgr_attachments_fill_uploader before insert on public.msgr_attachments for each row execute function public.msgr_attachments_fill_uploader();

-- 6) 외부 봇 준비 — 20261002140000 본문 그대로 + 대상 글을 찾은 뒤 에이전트 주인 판정 한 줄(서명 업로드 주소를 주기 전에 거절).
create or replace function public.msgr_bot_attach_prepare(token text, p_message bigint, p_name text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; raw text := btrim(coalesce(p_name, '')); dot int; stem text; ext text; purge jsonb; space text; tw uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if raw = '' or length(raw) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'msgr_bot_bad_file_size'; end if;
  if p_bytes > 26214400 then raise exception 'msgr_bot_file_too_large'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(m.id)); -- 무료 첨부 한도(20261011150000) — 에이전트 주인 몫
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

notify pgrst, 'reload schema';
