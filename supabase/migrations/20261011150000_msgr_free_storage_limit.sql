-- 무료 계정 메신저 첨부 저장 한도(유건 2026-10-11 확정): 무료 = 저장 용량 1GB, 파일 하나 25MB(msgr 버킷 file_size_limit 26214400 — 이미 운영에 있다).
-- Pro는 이번 변경으로 용량 제한을 새로 걸지 않는다. 판정은 public.is_pro_for(uid)(결제·운영자 부여·유료 조직 좌석·남은 체험) — 새 판정을 만들지 않는다
-- (msgr_free_grace 유예는 방 인원 한도용이라 쓰지 않는다 — 20261010200000과 같다).
--
-- 켜고 끄기: msgr_settings 'free_storage_limit_bytes' = 한도 바이트(1GB = 1073741824). 행이 없거나 숫자가 아니거나 0 이하면 꺼짐(기본).
--   결제 경로(PR #944)가 열리는 발행 날 값을 넣어 켠다. 이 마이그레이션만으로는 아무것도 막지 않는다(꺼져 있으면 판정·M1 검사가 모두 통과).
--
-- 누구 몫인가: 첨부를 올린 사람 = 사람 글이면 글쓴이, 에이전트 글(앱·게이트웨이·외부 봇)이면 에이전트 주인. 첨부 행에 uploader_id로 남긴다(트리거가 채운다 —
--   앱이 보낸 값은 믿지 않는다). 크기도 앱이 보낸 bytes가 아니라 저장소 객체의 실제 크기로 채운다(조직 첨부 행 정책은 객체·크기를 보지 않는다).
--   10/2 결정(개인 공간·개인 대화 = 올린 사람, 조직 공간 = 조직 풀) 중 조직 풀 계산은 이번 범위 밖이다 — 지금은 조직 공간 파일도 올린 사람 몫이고,
--   유료 좌석 조직의 멤버는 is_pro_for가 참이라 걸리지 않는다(좌석이 아닌 손님은 무료와 같다).
--
-- 사용량 = ① 내가 올린 첨부 행의 경로별 크기(같은 경로는 한 번 — 게이트웨이 재사용 행) + ② 첨부 행이 없는 내 소유 msgr 객체(storage.objects owner = 나)의 크기.
--   ②가 없으면 첨부 행 없이 업로드만 반복해 한도를 피할 수 있다(분리 검수 M2). 정리 경로(2시간 지난 미등록 객체를 Storage API로 지우기)를 앱 업로드에 새로 붙이는
--   대신 ②를 고른 이유: 정리는 주기 실행(크론 + 엣지 + 서비스 키)이 새로 필요하고 실패하면 다시 새는데, ②는 판정 한 곳에서 끝난다. 미등록 객체는 지워질 때까지 내 몫이다.
--   ②의 비용: storage.objects에 owner 색인을 붙일 수 없어(supabase_storage_admin 소유) msgr 버킷 범위((bucket_id, name) 색인)를 훑는다 — 운영 실측(2026-10-11,
--   msgr 객체 484개) 0.6ms + 첨부 경로 확인 219회 1ms. 버킷 크기에 비례하므로 객체가 수만 개가 되면 다시 잰다(켜져 있을 때 업로드마다 1회, 하루 평균 17건).
--   봇이 서명 주소로 올린 객체는 owner가 비어 있어 ②에 들지 않는다 — 그쪽은 기존 정리(msgr_bot_attach_prepare purge, 2시간)가 지운다.
--
-- 판정 규칙(하나): 쓴 양 + 이번 크기 ≤ 한도이면 받는다(Pro면 언제나).
--   이번 크기: 앱 업로드는 storage-api가 정책 판정용 행에 싣는 신고 크기 metadata.contentLength(supabase/storage #825, 2026-03 — 운영은 Storage 마이그레이션
--   0072(2026-09)까지 적용된 버전이라 들어 있다. 실제 크기는 올린 뒤 슈퍼유저로 채우므로 정책은 볼 수 없다), 첨부 행은 저장소 객체의 실제 크기,
--   봇 준비는 봇이 신고한 크기. 신고 크기가 없으면(옛 storage-api) 0으로 보고 "쓴 양 ≤ 한도"로 받는다 — 그때 첨부 행이 실제 크기로 막으면 그 객체는 ②로 내 몫에 남는다.
-- 판정 자리(모두 public._msgr_upload_gate 하나를 지난다):
--   1) 앱·게이트웨이 업로드 — storage.objects 제한(RESTRICTIVE) 정책 msgr_files_storage_limit. msgr 버킷의 세 허용 정책(msgr_files_insert·
--      msgr_personal_files_insert·msgr_dm_output_insert)과 앞으로 생길 허용 정책에 모두 걸린다. 다른 버킷(아바타·companies)은 CASE로 건너뛴다.
--   2) 첨부 행 — msgr_attachments BEFORE INSERT 트리거(올린 사람·크기 채우기 + 판정). 켜져 있으면 객체가 없는 새 경로는 거절한다(먼저 행 bytes=0, 나중 업로드로
--      사용량 0을 만드는 길 — 분리 검수 M1. 앱·게이트웨이·봇 모두 업로드가 먼저라 정상 흐름은 영향 없음). 같은 객체를 다시 가리키는 행은 새 저장이 아니라 판정하지 않는다.
--   3) 외부 봇 준비(msgr_bot_attach_prepare) — 서명 업로드 주소를 주기 전에. 등록(msgr_bot_attach_commit)은 2)가 막는다.
--   아바타(msgr-avatars)는 사람마다 한 장을 덮어쓰는 프로필 사진이라 첨부 저장 공간이 아니다 — 제외.
-- 오류: 'msgr_storage_limit' (SQLSTATE PT402). PostgREST는 402와 이 문구를, storage-api는 'database error, code: PT402'를 돌려준다(원문을 숨긴다) —
--   앱은 둘 다 본다. 엣지 msgr-bot ERR 표에 같은 이름(403)이 있다. 문구에는 결제 유도를 넣지 않는다(봇 원문이 방에 실린다 — iOS 규정).
--
-- 조직 채널 삭제(분리 검수 M3): 관리자가 아닌 채널 만든 사람이 지우면 앱의 Storage 삭제는 0건(msgr_files_delete는 관리자만)인데 첨부 행은 cascade로 사라져
--   객체가 주인 없이 남았다. 개인 방(msgr_personal_files_purge, 20261002100000)과 같은 방법으로 그 채널 폴더 <org>/<channel>/의 객체 행을 같이 지운다.
--   (Storage 백엔드 바이트는 개인 방·계정 삭제와 같은 알려진 한계 — 행이 없으면 서명 URL을 만들 수 없다.) 운영에 다른 방 폴더를 가리키는 첨부 0건(2026-10-11).
--
-- 보안 점검 quota-bypass(#946 2차) 반영: 신고 크기는 클라이언트 값이라 최소 1바이트로 보고(넘을 수 있는 양 = 파일 하나), 첨부로 등록된 경로에는 다시 올리지 못하며,
--   파일을 두고 방만 지우면 남은 크기를 msgr_storage_purged에 올린 사람 몫으로 남긴다(6-b). 방을 지울 수 있는 사람은 그 방 파일을 Storage로 지울 수 있다(6-c).
-- 기존 파일: 지우지 않는다. 이미 한도를 넘은 무료 사용자는 새로 올릴 때만 막힌다(읽기·내려받기 그대로).
-- 운영 분포(2026-10-11 읽기): 첨부가 있는 사용자 16명(무료 13·Pro 3), 무료 합계 270MB·최대 127MB — 1GB를 넘은 사람 0명, 100MB 넘은 무료 1명. 미등록 객체 0개.
--
-- 부하(DB 위생): 주기 작업·폴링·캐시 표 없음. 판정은 읽기만 한다(쓰기 0).
--   업로드 한 번 = Storage 정책 1회: 설정 PK 1회(꺼져 있으면 여기서 끝) + 켜져 있으면 ① 색인 합계 + ② msgr 버킷 범위 1회 + 한도에 닿은 사람만 is_pro_for 1회.
--   첨부 행 한 줄 = 트리거 1회: 글 PK + (에이전트 글) 크루 PK + 저장소 객체 (bucket_id, name) 색인 + 설정 PK. 켜져 있으면 + 같은 경로 존재(색인) + 판정. 추가 쓰기 0.
--   ①은 msgr_attachments(uploader_id, storage_path) INCLUDE (bytes) 색인 — 그 사람 행 수에만 비례(로컬 20.5만 행 중 5,000행 사용자 1.4ms).
--   캐시 표(사용자별 합계를 트리거로 갱신)를 쓰지 않은 이유: 첨부마다 한 행을 다시 쓰고(죽은 행), 삭제·재사용·cascade마다 어긋날 수 있다.
--
-- 적용: bash scripts/msgr-live-apply.sh 20261011150000_msgr_free_storage_limit — storage.objects 정책 생성이 있다(#872 선잠금 대상).
--   msgr_attachments에 열 추가(메타데이터만) + 기존 행 채우기(운영 521행) + 색인 + msgr_channels 삭제 트리거.
-- 켜기(발행 날, 엣지 msgr-bot 재배포 뒤): insert into public.msgr_settings(key, value) values ('free_storage_limit_bytes', '1073741824') on conflict (key) do update set value = excluded.value;
-- 끄기: delete from public.msgr_settings where key = 'free_storage_limit_bytes';
-- 되돌리기: 끄기만으로 충분하다 — 꺼져 있으면 판정 함수는 항상 참이고 M1 검사도 하지 않아, 정책·트리거·봇 준비가 남아 있어도 종전과 같게 동작한다.
--   (함수를 옛 파일 정의로 다시 적용하지 않는다 — 나중 정의를 덮어쓰는 2026-09-23 사고 모양.) 채널 삭제 정리 트리거는 스위치와 무관하게 남는다
--   (지우려면 drop trigger msgr_org_channel_files_purge on public.msgr_channels). uploader_id 열·색인은 남겨도 무해.

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

-- 2) 사용량 — ① 내가 올린 첨부 행(경로당 한 번) + ② 첨부 행이 없는 내 msgr 객체 + ③ 파일을 두고 지운 방에서 정리된 크기(msgr_storage_purged).
--    ② 누구 객체인가: owner(앱·게이트웨이 = 업로드한 사람), owner가 빈 객체(봇 서명 업로드)는 경로 3번째 칸 글의 올린 사람(에이전트 주인).
--    p_except = 지금 등록 중인 경로(②에서 뺀다 — 트리거가 그 크기를 따로 더한다). plpgsql: storage.objects 열은 실행할 때 찾는다.
create table if not exists public.msgr_storage_purged (
  user_id uuid primary key references auth.users (id) on delete cascade,
  bytes bigint not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.msgr_storage_purged enable row level security; -- 정책 없음 = 서버 함수만(security definer)
revoke all on public.msgr_storage_purged from anon, authenticated;

create or replace function public._msgr_path_uploader(p_name text) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when split_part(p_name, '/', 3) ~ '^[0-9]{1,18}$' then public._msgr_attachment_uploader(split_part(p_name, '/', 3)::bigint) end
$$;
revoke all on function public._msgr_path_uploader(text) from public, anon, authenticated;

create or replace function public._msgr_storage_used(p_uid uuid, p_except text default null) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare reg bigint; unreg bigint := 0; purged bigint;
begin
  select coalesce(sum(b), 0) into reg from (select max(a.bytes) b from public.msgr_attachments a where a.uploader_id = p_uid group by a.storage_path) x;
  if p_uid is not null and to_regclass('storage.objects') is not null then
    select coalesce(sum((o.metadata->>'size')::bigint), 0) into unreg from storage.objects o
     where o.bucket_id = 'msgr' and o.name is distinct from p_except
       and case when o.owner is not null then o.owner = p_uid else coalesce(public._msgr_path_uploader(o.name) = p_uid, false) end
       and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name);
  end if;
  select coalesce((select k.bytes from public.msgr_storage_purged k where k.user_id = p_uid), 0) into purged;
  return reg + unreg + purged;
end $$;
revoke all on function public._msgr_storage_used(uuid, text) from public, anon, authenticated;

-- 한도(바이트) — 꺼져 있으면 NULL
create or replace function public._msgr_storage_limit() returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  select value into v from public.msgr_settings where key = 'free_storage_limit_bytes';
  if coalesce(v, '') !~ '^[0-9]{1,18}$' or v::bigint <= 0 then return null; end if;
  return v::bigint;
end $$;
revoke all on function public._msgr_storage_limit() from public, anon, authenticated;

-- 3) 판정 — 꺼짐·올린 사람 모름이면 참, 쓴 양 + 이번 크기 ≤ 한도면 참, Pro면 참.
create or replace function public._msgr_upload_allowed(p_uid uuid, p_size bigint, p_except text default null) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare lim bigint := public._msgr_storage_limit();
begin
  if lim is null or p_uid is null then return true; end if;
  if public._msgr_storage_used(p_uid, p_except) + greatest(coalesce(p_size, 0), 1) <= lim then return true; end if; -- 신고 크기는 클라이언트 값 — 0을 신고해도 1바이트로 본다
  return public.is_pro_for(p_uid);
end $$;
revoke all on function public._msgr_upload_allowed(uuid, bigint, text) from public, anon, authenticated;

-- 판정 + 오류 한 곳. 참이면 true, 아니면 msgr_storage_limit. 문구는 중립(결제 유도 없음).
create or replace function public._msgr_upload_gate(p_uid uuid, p_size bigint, p_except text default null) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr_upload_allowed(p_uid, p_size, p_except) then return true; end if;
  raise exception 'msgr_storage_limit' using errcode = 'PT402',
    detail = 'free plan attachment storage is full; existing files are kept', hint = 'free_storage_limit_bytes';
end $$;
revoke all on function public._msgr_upload_gate(uuid, bigint, text) from public, anon, authenticated;

-- Storage 정책용 — 호출한 사람 자신만 판정한다(남의 사용량·플랜을 묻는 통로가 되지 않게 uid를 받지 않는다).
-- p_row = 넣으려는 행 전체(to_jsonb) — metadata 열 이름을 정책 정의에 박지 않아 metadata 열이 없는 Storage 흉내 표에서도 정책이 만들어진다.
create or replace function public.msgr_upload_check(p_row jsonb) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n text := p_row->'metadata'->>'contentLength';
begin
  -- 이미 첨부로 등록된 경로에 다시 올리기 — 첨부 행 크기는 처음 값이라 지우고 더 큰 파일을 올리면 덜 센다(보안 점검 #946). 정상 흐름은 파일마다 새 경로라 없다
  if public._msgr_storage_limit() is not null and exists (select 1 from public.msgr_attachments a where a.storage_path = p_row->>'name') then
    raise exception 'msgr_storage_limit' using errcode = 'PT402', detail = 'this path already belongs to an attachment', hint = 'free_storage_limit_bytes';
  end if;
  return public._msgr_upload_gate(auth.uid(), case when n ~ '^[0-9]{1,18}$' then n::bigint else 0 end);
end $$;
revoke all on function public.msgr_upload_check(jsonb) from public, anon;
grant execute on function public.msgr_upload_check(jsonb) to authenticated;

-- 4) 앱·게이트웨이 업로드 — msgr 버킷 insert 전부에 거는 제한 정책. CASE로 다른 버킷은 판정 함수를 부르지 않는다(OR은 평가 순서를 보장하지 않는다).
drop policy if exists msgr_files_storage_limit on storage.objects;
create policy msgr_files_storage_limit on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'msgr' then public.msgr_upload_check(to_jsonb(objects)) else true end);

-- 5) 첨부 행 — 올린 사람·실제 크기를 채우고, 새 저장이면 판정한다.
create or replace function public.msgr_attachments_fill_uploader() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare real_size bigint; found_obj boolean := false;
begin
  new.uploader_id := public._msgr_attachment_uploader(new.message_id);
  if to_regclass('storage.objects') is not null then
    -- to_jsonb: 열 이름을 실행할 때 찾는다(metadata 열이 없는 Storage 흉내 표에서도 트리거가 깨지지 않게 — 운영 표에는 있다)
    select true, (to_jsonb(o)->'metadata'->>'size')::bigint into found_obj, real_size from storage.objects o where o.bucket_id = 'msgr' and o.name = new.storage_path limit 1;
    if real_size is not null then new.bytes := real_size; end if;
  end if;
  -- 같은 객체를 이미 가리키는 행이 있으면 새 저장이 아니다(재사용) — 판정하지 않는다
  if exists (select 1 from public.msgr_attachments a where a.storage_path = new.storage_path) then return new; end if;
  if public._msgr_storage_limit() is null then return new; end if; -- 꺼짐 — 종전 동작 그대로
  if not coalesce(found_obj, false) then raise exception 'msgr_attach_upload_missing' using detail = 'upload the file before adding its attachment row'; end if; -- M1
  perform public._msgr_upload_gate(new.uploader_id, new.bytes, new.storage_path);
  return new;
end $$;
revoke all on function public.msgr_attachments_fill_uploader() from public, anon, authenticated;
drop trigger if exists msgr_attachments_fill_uploader on public.msgr_attachments;
create trigger msgr_attachments_fill_uploader before insert on public.msgr_attachments for each row execute function public.msgr_attachments_fill_uploader();

-- 6) 조직 채널 삭제 — 그 채널 폴더 <org>/<channel>/의 객체 행을 같이 지운다(개인 방 msgr_personal_files_purge와 같은 방법). 다른 채널·조직·개인 방 폴더는 건드리지 않는다.
create or replace function public.msgr_org_channel_files_purge() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.org_id is not null and to_regclass('storage.objects') is not null then
    perform set_config('storage.allow_delete_query', 'true', true); -- storage-api 직접 삭제 가드 통과(트랜잭션 지역) — msgr_personal_files_purge와 같다
    delete from storage.objects where bucket_id = 'msgr' and name like old.org_id::text || '/' || old.id::text || '/%';
  end if;
  return old;
end $$;
revoke all on function public.msgr_org_channel_files_purge() from public, anon, authenticated;
drop trigger if exists msgr_org_channel_files_purge on public.msgr_channels;
create trigger msgr_org_channel_files_purge after delete on public.msgr_channels
  for each row when (old.org_id is not null) execute function public.msgr_org_channel_files_purge();

-- 6-b) 지운 방에 남은 파일 크기는 올린 사람 몫으로 남긴다 — 파일을 Storage로 지우지 않고 방만 지우면 객체 행은 정리되지만(6, 개인 방은 20261002100000)
--      저장소 바이트는 남는다. 기록 없이 두면 "올리고 방 지우기"를 되풀이해 한도를 피한다(보안 점검 quota-bypass). 방 행이 지워지기 전(BEFORE)에 센다 —
--      그때는 글·첨부 행이 아직 있어 봇 객체(owner 없음)의 주인도 찾는다. 앱은 방을 지우기 전에 첨부를 Storage로 지우므로(아래 6-c 정책) 보통 남는 것이 없다.
--      쓰기: 남은 파일이 있을 때만 사람당 한 행 upsert(방 삭제는 드물다). 보존: 계정 삭제 때 cascade. 저장소를 따로 비운 뒤에는 운영자가 행을 지운다.
create or replace function public.msgr_channel_files_charge() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if to_regclass('storage.objects') is null then return old; end if;
  insert into public.msgr_storage_purged as k (user_id, bytes)
  select u, sum(sz) from (
    select coalesce(nullif(j->>'owner', '')::uuid, public._msgr_path_uploader(j->>'name')) u, coalesce((j->'metadata'->>'size')::bigint, 0) sz
      from (select to_jsonb(o) j from storage.objects o where o.bucket_id = 'msgr' and o.name like coalesce(old.org_id::text, 'p') || '/' || old.id::text || '/%') r
  ) x where u is not null and exists (select 1 from auth.users au where au.id = x.u)
  group by u having sum(sz) > 0
  on conflict (user_id) do update set bytes = k.bytes + excluded.bytes, updated_at = now();
  return old;
end $$;
revoke all on function public.msgr_channel_files_charge() from public, anon, authenticated;
drop trigger if exists msgr_channel_files_charge on public.msgr_channels;
create trigger msgr_channel_files_charge before delete on public.msgr_channels for each row execute function public.msgr_channel_files_charge();

-- 6-c) 방을 지울 수 있는 사람은 그 방 파일도 Storage로 지울 수 있다 — 앱 deleteChannel은 방을 지우기 전에 첨부를 Storage API로 지우는데(바이트까지 삭제),
--      종전 정책(msgr_files_delete)은 조직 관리자만이라 채널 만든 사람·개인 방에서는 0건이었다. 판정은 방 삭제 정책과 같은 msgr_can_delete_channel,
--      경로 1번째 칸이 그 방의 공간(조직 id 또는 p)과 같을 때만. 방을 지우면 어차피 모두가 파일을 못 보므로 권한이 넓어지지 않는다.
create or replace function public.msgr_can_delete_channel_file(p_name text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_channels c where c.id = public.msgr_uuid_or_null(split_part(p_name, '/', 2))
                   and split_part(p_name, '/', 1) = coalesce(c.org_id::text, 'p'))
     and public.msgr_can_delete_channel(public.msgr_uuid_or_null(split_part(p_name, '/', 2)))
$$;
revoke all on function public.msgr_can_delete_channel_file(text) from public, anon;
grant execute on function public.msgr_can_delete_channel_file(text) to authenticated;
drop policy if exists msgr_files_delete_channel on storage.objects;
create policy msgr_files_delete_channel on storage.objects for delete to authenticated
  using (bucket_id = 'msgr' and public.msgr_can_delete_channel_file(name));

-- 7) 외부 봇 준비 — 20261002140000 본문 그대로 + 대상 글을 찾은 뒤 에이전트 주인 판정 한 줄(서명 업로드 주소를 주기 전에 거절).
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
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(m.id), p_bytes); -- 무료 첨부 한도(20261011150000) — 에이전트 주인 몫, 봇이 신고한 크기
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
