-- 개인 방 파일 첨부(2026-10-02 유건 요청) — 친구 1:1·그룹·개인 에이전트 방(org_id 없는 채널)에서도 파일을 보낸다.
-- 막혀 있던 이유: 저장 경로가 <org_id>/<channel_id>/<message_id>/<file>이고 업로드 정책(msgr_files_insert)이 1번째 칸을
--   조직 멤버십으로 판정한다. 개인 방은 조직이 없어 올릴 곳이 없었고, 첨부 표 org_id가 NOT NULL이라 행도 못 넣었다.
-- 변경(조직 경로 정책은 그대로):
--   1) 개인 방 전용 경로 p/<channel_id>/<message_id>/<file>.
--      쓰기 = 그 방에 지금 쓸 수 있는 사람(msgr_can_write_channel: 현재 사람 구성원, 보관 안 됨, 1:1 차단이면 막힘)이
--             자기 글 또는 자기 에이전트 글에만. 글은 그 방의 글이어야 하고 지워지지 않았어야 한다.
--      읽기 = 기존 msgr_files_select(2번째 칸 = 채널 열람, msgr_can_read_channel)로 이미 된다 — 개인 방은 현재 사람 구성원만 통과.
--             그래서 읽기 정책은 새로 만들지 않는다(같은 판정을 두 번 평가하지 않게). PG 테스트가 이 동작을 고정한다.
--      나간 사람: 구성원 행이 지워져 새 파일도 지난 파일도 못 읽는다(글을 못 읽는 것과 같다).
--      차단: 1:1은 차단하면 둘 다 새 파일을 못 올리고 지난 파일은 읽는다(글과 같다). 그룹은 계속 올리고 읽는다(화면이 차단한 사람 글을 가린다).
--   2) msgr_attachments.org_id NULL 허용 — 개인 방 첨부만 NULL. org_id와 경로 모양이 어긋나지 않게 CHECK(기존 행은 전부 조직 경로라 통과).
--      개인 첨부 행은 새 정책 하나로만 들어온다: 경로가 그 글의 p/ 경로이고, 저장소에 그 객체가 있고, 크기가 25MB 이하일 때.
--      기존 조직 정책(msgr_attachments_insert의 m.org_id = org_id, msgr_dm_output_attachment의 org_id::text = 1번째 칸)은
--      org_id가 NULL이면 비교가 NULL이라 개인 행을 통과시키지 않는다 — 손대지 않는다.
-- 크기·형식: 조직 첨부와 같은 규칙(25MB, 형식 제한 없음). 무료 플랜 첨부 한도는 조직에도 없다.
-- 부하: 파일 하나당 Storage 업로드 1 + 첨부 행 1(조직 첨부와 같다). 주기 작업·폴링 없음.

alter table public.msgr_attachments alter column org_id drop not null;
alter table public.msgr_attachments drop constraint if exists msgr_attachments_space_path;
alter table public.msgr_attachments add constraint msgr_attachments_space_path
  check ((org_id is null) = (storage_path like 'p/%')) not valid;
alter table public.msgr_attachments validate constraint msgr_attachments_space_path;

-- 개인 방 경로 판정 — p/<channel uuid>/<message id>/<file key>. 쓰기 판정만 쓴다(읽기는 위 설명대로 기존 정책).
create or replace function public.msgr_personal_file_ok(p_path text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare parts text[] := string_to_array(coalesce(p_path, ''), '/'); ch uuid; mid bigint; me uuid := auth.uid();
begin
  if me is null or cardinality(parts) <> 4 or parts[1] <> 'p' then return false; end if;
  ch := public.msgr_uuid_or_null(parts[2]);
  if ch is null or parts[3] !~ '^[0-9]{1,18}$' or parts[4] in ('', '.', '..') or parts[4] !~ '^[A-Za-z0-9._-]{1,200}$' then return false; end if;
  mid := parts[3]::bigint;
  if not exists (select 1 from public.msgr_channels c where c.id = ch and c.org_id is null) then return false; end if;
  if not public.msgr_can_write_channel(ch) then return false; end if;
  return exists (
    select 1 from public.msgr_messages m
     where m.id = mid and m.channel_id = ch and m.deleted_at is null
       and ((m.author_kind = 'user' and m.author_user_id = me)
         or (m.author_kind = 'crew' and exists (select 1 from public.msgr_crews c where c.id = m.crew_id and c.owner_user_id = me and c.status = 'active'))));
end $$;
revoke all on function public.msgr_personal_file_ok(text) from public, anon;
grant execute on function public.msgr_personal_file_ok(text) to authenticated;

drop policy if exists msgr_personal_files_insert on storage.objects;
create policy msgr_personal_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'msgr' and (storage.foldername(name))[1] = 'p' and public.msgr_personal_file_ok(name));

-- 첨부 행 — 객체가 실제로 올라와 있고 25MB 이하일 때만(업로드 정책은 크기를 모른다: Storage가 행을 먼저 넣고 나중에 크기를 채운다).
create or replace function public.msgr_personal_attachment_ok(p_path text, p_message bigint) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select p_path like 'p/%' and split_part(p_path, '/', 3) = p_message::text and public.msgr_personal_file_ok(p_path)
     and exists (select 1 from storage.objects o where o.bucket_id = 'msgr' and o.name = p_path
                  and coalesce((o.metadata->>'size')::bigint, 0) <= 26214400)
$$;
revoke all on function public.msgr_personal_attachment_ok(text, bigint) from public, anon;
grant execute on function public.msgr_personal_attachment_ok(text, bigint) to authenticated;

drop policy if exists msgr_personal_attachments_insert on public.msgr_attachments;
create policy msgr_personal_attachments_insert on public.msgr_attachments for insert to authenticated
  with check (org_id is null and public.msgr_personal_attachment_ok(storage_path, message_id));

-- 보존: 첨부는 글이 지워져도(삭제 표시) 남는다 — 조직 첨부와 같다. 개인 방 행이 지워지면(혼자 남은 방의 계정 삭제 등)
-- 글·첨부 행은 cascade로 지워지는데 p/<방>/ 객체는 주인 없이 남는다. 방 행이 지워질 때 그 방 경로의 객체 행도 같이 지운다.
-- (Storage 백엔드 바이트는 msgr_delete_me·msgr_purge_orgs와 같은 알려진 한계 — 행이 없으면 서명 URL을 만들 수 없다.)
create or replace function public.msgr_personal_files_purge() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.org_id is null then
    perform set_config('storage.allow_delete_query', 'true', true); -- storage-api 직접 삭제 가드 통과(트랜잭션 지역) — msgr_delete_me와 같은 방법
    delete from storage.objects where bucket_id = 'msgr' and name like 'p/' || old.id::text || '/%';
  end if;
  return old;
end $$;
revoke all on function public.msgr_personal_files_purge() from public, anon, authenticated;
drop trigger if exists msgr_personal_files_purge on public.msgr_channels;
create trigger msgr_personal_files_purge after delete on public.msgr_channels
  for each row when (old.org_id is null) execute function public.msgr_personal_files_purge();

notify pgrst, 'reload schema';
