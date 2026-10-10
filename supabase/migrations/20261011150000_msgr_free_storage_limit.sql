-- 무료 계정 메신저 첨부 저장 한도(유건 2026-10-11 확정): 무료 = 저장 용량 1GB, 파일 하나 25MB(msgr 버킷 file_size_limit 26214400 — 이미 운영에 있다).
-- Pro는 이번 변경으로 용량 제한을 새로 걸지 않는다. 판정은 public.is_pro_for(uid)(결제·운영자 부여·유료 조직 좌석·남은 체험) — 새 판정을 만들지 않는다
-- (msgr_free_grace 유예는 방 인원 한도용이라 쓰지 않는다 — 20261010200000과 같다).
--
-- 켜고 끄기: msgr_settings 'free_storage_limit_bytes' = 한도 바이트(1GB = 1073741824). 행이 없거나 숫자가 아니거나 0 이하면 꺼짐(기본).
--   결제 경로(PR #944)가 열리는 발행 날 값을 넣어 켠다.
--   스위치와 무관하게 동작하는 것(꺼도 남는다): ① 첨부 행 bytes를 저장소 실제 크기로 채우기(데이터 정정만, 거절 없음)
--   ② 지운 방·등록 안 된 파일 정리(5절 — 개인 방 SQL 행 삭제 트리거를 떼고, 정리 엣지가 Storage API로 바이트까지 지운다). 나머지(판정·거절)는 꺼지면 모두 통과다.
--
-- 사용량 = 저장소에 지금 있는 내 msgr 객체 크기 합(storage.objects metadata.size — 실제 바이트). 첨부 행 크기(앱이 보낸 값)는 세지 않는다.
--   지금 있는 객체 = 버전 관리 보관본(archived_at)·삭제 표시(is_delete_marker)를 뺀 것(1-b — 열이 있을 때만).
--   누구 몫인가: owner(storage-api가 JWT로 채운다 — 앱·게이트웨이 업로드한 사람, owner가 비면 owner_id 문자열), owner가 빈 객체(외부 봇 서명 업로드)는 경로 3번째 칸 글의 올린 사람
--   (사람 글 = 글쓴이, 에이전트 글 = 에이전트 주인). 둘 다 본인이 아닌 사람이 만들 수 없다 — 남이 내 사용량을 부풀릴 수 없다(quota-griefing):
--   남이 내 글 폴더에 올린 파일은 owner가 그 사람이라 그 사람 몫, 봇 서명 경로는 봇 자기 글에만 나온다(msgr_bot_attach_prepare).
--   같은 파일을 가리키는 첨부 행이 여럿이어도(게이트웨이 재사용) 객체는 하나라 한 번만 센다. 지우고 같은 경로에 더 큰 파일을 올려도(관리자·봇 서명 주소 재사용)
--   지금 있는 객체 크기로 센다. 10/2 결정의 조직 풀 계산은 범위 밖 — 지금은 조직 공간 파일도 올린 사람 몫이고, 유료 좌석 조직 멤버는 is_pro_for가 참이다.
--   비용: owner 색인을 붙일 수 없어(storage.objects는 supabase_storage_admin 소유) msgr 버킷 범위((bucket_id, name) 색인)를 훑는다 — 운영 실측(2026-10-11, 객체 484개)
--   약 0.6ms(데운 상태). 버킷 객체 수에 비례하므로 수만 개 전에 다시 잰다. 켜져 있을 때만, 업로드·첨부 등록마다 1회.
--
-- 판정 규칙(하나): 쓴 양 + 이번 크기 ≤ 한도이면 받는다(Pro면 언제나). 이번 크기: 앱 업로드는 storage-api가 정책 판정용 행에 싣는 신고 크기
--   metadata.contentLength(supabase/storage #825, 2026-03 — 운영 Storage는 마이그레이션 0072(2026-09)까지 적용된 버전). 신고 크기는 클라이언트 값이라
--   최소 1바이트로 보고(0 신고로 한도에서 통과 금지), 속인 만큼은 올린 뒤 실제 크기로 사용량에 들어가 다음 업로드가 막힌다(넘을 수 있는 양 = 파일 하나).
--   첨부 행은 저장소 객체의 실제 크기, 봇 준비는 봇이 신고한 크기. 신고 크기가 없는 옛 storage-api면 1바이트로 보고 받는다.
-- 판정 자리(모두 public._msgr_upload_gate):
--   1) 앱·게이트웨이 업로드 — storage.objects 제한(RESTRICTIVE) 정책 msgr_files_storage_limit(msgr 버킷 insert 전부, 다른 버킷은 CASE로 건너뜀).
--   2) 첨부 행 — msgr_attachments BEFORE INSERT. 켜져 있으면 객체가 없는 새 경로는 거절(msgr_attach_upload_missing — 정상 흐름은 업로드가 먼저).
--      같은 객체를 이미 가리키는 행이 있으면 새 저장이 아니라 판정하지 않는다.
--   3) 외부 봇 준비(msgr_bot_attach_prepare) — 서명 업로드 주소를 주기 전에. 등록은 2)가 막는다.
--   아바타(msgr-avatars)는 프로필 사진 한 장이라 제외.
-- 오류: 'msgr_storage_limit' (SQLSTATE PT402). PostgREST는 402와 이 문구를, storage-api는 'database error, code: PT402'를 돌려준다 — 앱은 둘 다 본다.
--   엣지 msgr-bot ERR(403)에 같은 이름이 있다. 문구에 결제 유도는 넣지 않는다(봇 원문이 방에 실린다).
--
-- 방을 지워도 한도는 초기화되지 않는다: 방을 지우면 첨부 행은 cascade로 사라지지만 객체는 남아 owner 몫으로 계속 센다. 정리 엣지(5절)가 Storage API로
--   바이트까지 지운 뒤에야 준다(그때는 파일이 실제로 없어진 것). 방이 남아 있는 동안 파일 삭제 권한은 종전 그대로(msgr_files_delete = 조직 관리자).
--   이를 위해 개인 방의 SQL 행 삭제 트리거(msgr_personal_files_purge, 20261002100000)를 뗀다 — SQL로 행만 지우면 바이트는 저장소에 남는데 사용량은 0이 됐다.
-- 남는 우회(PR '남은 것'): 조직 영구 삭제(msgr_purge_orgs, 보관 30일 뒤)와 계정 삭제(msgr_delete_me)는 지금처럼 객체 행을 SQL로 지운다(바이트는 남는 알려진 한계).
--   보관 중 30일은 사용량에 그대로 들어 있어 계정당 30일에 한도만큼까지. 외부 봇 객체(owner 없음)는 방이 지워지면 글이 없어 정리 전(최대 1시간)까지 세지 않는다.
--
-- 기존 파일: 지우지 않는다. 이미 한도를 넘은 무료 사용자는 새로 올릴 때만 막힌다(읽기·내려받기 그대로).
-- 운영 분포(2026-10-11 읽기): 첨부가 있는 사용자 16명(무료 13·Pro 3), 무료 합계 270MB·최대 127MB — 1GB를 넘은 사람 0명. 미등록·방 없는 객체 0개.
--
-- 부하(DB 위생): 판정은 읽기만(쓰기 0). 업로드 1회 = 설정 PK 1회(꺼져 있으면 끝) + 켜져 있으면 버킷 범위 합계 1회 + 한도에 닿은 사람만 is_pro_for.
--   첨부 행 1줄 = 객체 (bucket_id, name) 색인 1회 + 같은 경로 존재 1회 + 설정 PK + (켜짐) 합계. 추가 쓰기 0.
--   정리(5절): pg_cron 1시간에 1번 후보가 있는지 읽기 1회(유휴 시 엣지 호출 0). 후보가 있을 때만 엣지 1회(최대 10번 × 200개 삭제).
--
-- 적용: bash scripts/msgr-live-apply.sh 20261011150000_msgr_free_storage_limit — storage.objects 정책 생성·msgr_channels 트리거 제거가 있다(#872 선잠금 대상).
-- 정리 켜기(엣지 msgr-storage-sweep 배포 뒤): msgr_settings storage_sweep_url·storage_sweep_secret(엣지 시크릿 MSGR_STORAGE_SWEEP_SECRET와 같은 값) — 없으면 정리는 아무것도 안 한다.
-- 켜기(발행 날, 엣지 msgr-bot 재배포 뒤): insert into public.msgr_settings(key, value) values ('free_storage_limit_bytes', '1073741824') on conflict (key) do update set value = excluded.value;
-- 끄기: delete from public.msgr_settings where key = 'free_storage_limit_bytes';  — 판정·거절이 모두 꺼진다(위 "스위치와 무관" 두 가지는 남는다).
-- 되돌리기(전부): 끄기 → drop policy msgr_files_storage_limit on storage.objects; drop trigger msgr_attachment_storage_gate on public.msgr_attachments;
--   select cron.unschedule('msgr-storage-sweep'); 정리 설정 두 행 삭제; 개인 방 행 삭제를 되살리려면 create trigger msgr_personal_files_purge after delete on public.msgr_channels
--   for each row when (old.org_id is null) execute function public.msgr_personal_files_purge();(함수는 지우지 않았다). 봇 준비의 판정 한 줄은 꺼져 있으면 항상 통과라 둔다.
--   (함수를 옛 파일 정의로 다시 적용하지 않는다 — 나중 정의를 덮어쓰는 2026-09-23 사고 모양.)

-- 1) 누구 몫인가
create or replace function public._msgr_attachment_uploader(p_message bigint) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when m.author_kind = 'user' then m.author_user_id
              when m.author_kind = 'crew' then (select c.owner_user_id from public.msgr_crews c where c.id = m.crew_id) end
    from public.msgr_messages m where m.id = p_message
$$;
revoke all on function public._msgr_attachment_uploader(bigint) from public, anon, authenticated;

create or replace function public._msgr_path_uploader(p_name text) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when split_part(p_name, '/', 3) ~ '^[0-9]{1,18}$' then public._msgr_attachment_uploader(split_part(p_name, '/', 3)::bigint) end
$$;
revoke all on function public._msgr_path_uploader(text) from public, anon, authenticated;

-- 1-b) 지금 있는 msgr 객체(버전 관리 보관본·삭제 표시 제외)와 그 크기·주인 — 사용량·첨부 크기·정리 후보가 같이 쓴다.
--      storage.objects 열은 storage-api 버전마다 다르다(운영 1.80.x = owner uuid·owner_id text·archived_at·is_delete_marker, 옛 버전·pg 시험 흉내 표는 일부 없음).
--      적용할 때 있는 열만으로 함수 본문을 만든다 — 열이 없는 환경에서도 깨지지 않는다. 열이 나중에 생기면 이 파일을 다시 적용한다.
--      (본문 끝의 두 따옴표 표시 사이는 띄어 쓴다 — 붙이면 바깥 DO 블록의 끝 표시로 읽힌다.)
--      SQL 함수에 SET·security definer를 두지 않아 부르는 쪽 질의에 펼쳐진다((bucket_id, name) 색인을 그대로 쓴다). 부르는 쪽은 모두 정의자 함수다.
do $$
declare has text[]; sz text; own text; live text := ''; body text;
begin
  if to_regclass('storage.objects') is null then
    body := 'select null::text, null::timestamptz, null::bigint, null::uuid where false';
  else
    select coalesce(array_agg(attname::text), '{}') into has from pg_attribute
     where attrelid = 'storage.objects'::regclass and attnum > 0 and not attisdropped
       and attname in ('metadata', 'owner', 'owner_id', 'archived_at', 'is_delete_marker', 'created_at');
    sz := case when 'metadata' = any (has) then $s$(o.metadata->>'size')::bigint$s$ else 'null::bigint' end;
    own := case when 'owner' = any (has) and 'owner_id' = any (has)
                  then $s$coalesce(o.owner, case when o.owner_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then o.owner_id::uuid end)$s$
                when 'owner' = any (has) then 'o.owner'
                when 'owner_id' = any (has) then $s$case when o.owner_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then o.owner_id::uuid end$s$
                else 'null::uuid' end;
    if 'archived_at' = any (has) then live := live || ' and o.archived_at is null'; end if;
    if 'is_delete_marker' = any (has) then live := live || ' and not coalesce(o.is_delete_marker, false)'; end if;
    body := format($f$select o.name, %s, %s, %s from storage.objects o where o.bucket_id = 'msgr'%s$f$,
                   case when 'created_at' = any (has) then 'o.created_at' else 'null::timestamptz' end, sz, own, live);
  end if;
  execute format($f$create or replace function public._msgr_live_objects() returns table (name text, created_at timestamptz, size bigint, owner_id uuid)
    language sql stable as $b$ %s $b$ $f$, body);
  execute 'revoke all on function public._msgr_live_objects() from public, anon, authenticated';
end $$;

-- 2) 사용량 — 지금 저장소에 있는 내 msgr 객체 크기 합. p_except = 지금 등록 중인 경로(트리거가 그 크기를 따로 더한다).
--    plpgsql: storage.objects 열은 실행할 때 찾는다(켜져 있을 때만 부른다).
create or replace function public._msgr_storage_used(p_uid uuid, p_except text default null) returns bigint
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n bigint := 0;
begin
  if p_uid is null then return 0; end if;
  select coalesce(sum(o.size), 0) into n from public._msgr_live_objects() o
   where o.name is distinct from p_except
     and case when o.owner_id is not null then o.owner_id = p_uid else coalesce(public._msgr_path_uploader(o.name) = p_uid, false) end;
  return n;
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

-- Storage 정책용 — 호출한 사람 자신만 판정한다(uid를 받지 않는다 — 남의 사용량·플랜을 묻는 통로가 되지 않게).
-- p_row = 넣으려는 행 전체(to_jsonb) — metadata 열 이름을 정책 정의에 박지 않아 metadata 열이 없는 Storage 흉내 표에서도 정책이 만들어진다.
create or replace function public.msgr_upload_check(p_row jsonb) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare n text := p_row->'metadata'->>'contentLength';
begin
  return public._msgr_upload_gate(auth.uid(), case when n ~ '^[0-9]{1,18}$' then n::bigint else 0 end);
end $$;
revoke all on function public.msgr_upload_check(jsonb) from public, anon;
grant execute on function public.msgr_upload_check(jsonb) to authenticated;

-- 4) 앱·게이트웨이 업로드 — msgr 버킷 insert 전부에 거는 제한 정책. CASE로 다른 버킷은 판정 함수를 부르지 않는다(OR은 평가 순서를 보장하지 않는다).
drop policy if exists msgr_files_storage_limit on storage.objects;
create policy msgr_files_storage_limit on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'msgr' then public.msgr_upload_check(to_jsonb(objects)) else true end);

-- 4-b) 첨부 행 — bytes를 실제 크기로 채우고, 켜져 있으면 새 저장을 판정한다.
create or replace function public.msgr_attachment_storage_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare real_size bigint; found_obj boolean := false;
begin
  select true, o.size into found_obj, real_size from public._msgr_live_objects() o where o.name = new.storage_path limit 1; -- 지금 버전(보관본·삭제 표시 제외)
  if real_size is not null then new.bytes := real_size; end if;
  if public._msgr_storage_limit() is null then return new; end if; -- 꺼짐 — 거절 없음
  if exists (select 1 from public.msgr_attachments a where a.storage_path = new.storage_path) then return new; end if; -- 같은 객체 재사용 — 새 저장 아님
  if not coalesce(found_obj, false) then raise exception 'msgr_attach_upload_missing' using detail = 'upload the file before adding its attachment row'; end if;
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(new.message_id), new.bytes, new.storage_path);
  return new;
end $$;
revoke all on function public.msgr_attachment_storage_gate() from public, anon, authenticated;
drop trigger if exists msgr_attachment_storage_gate on public.msgr_attachments;
create trigger msgr_attachment_storage_gate before insert on public.msgr_attachments for each row execute function public.msgr_attachment_storage_gate();

-- 5) 정리 — 방이 없는 msgr 객체(방이 지워짐)와 24시간 넘게 첨부 행이 없는 객체(등록 실패·거절)를 정리 엣지(msgr-storage-sweep)가 Storage API로 지운다
--    (SQL로 행만 지우면 저장소 바이트가 남는다 — storage.allow_delete_query 경로를 쓰지 않는다). 첨부 행이 있는 파일·방이 있는 파일은 건드리지 않는다.
--    게이트웨이 재사용 기억(src/gateway/msgr.mjs uploadedOnce)의 "방이 있으면 객체도 있다" 전제는 그대로다(재사용 경로는 등록된 파일).
--    개인 방 SQL 행 삭제 트리거는 뗀다(함수는 둔다 — 되돌리기는 머리 주석).
drop trigger if exists msgr_personal_files_purge on public.msgr_channels;

-- 정리 후보 — 서비스 역할(엣지)만. 오래된 것부터 p_limit개.
create or replace function public.msgr_storage_sweep_list(p_limit int default 200) returns setof text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    select o.name from public._msgr_live_objects() o
     where (not exists (select 1 from public.msgr_channels c where c.id = public.msgr_uuid_or_null(split_part(o.name, '/', 2)))
            or (o.created_at < now() - interval '24 hours'
                and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name)))
     order by o.created_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000));
end $$;
revoke all on function public.msgr_storage_sweep_list(int) from public, anon, authenticated;
grant execute on function public.msgr_storage_sweep_list(int) to service_role;

-- 1시간마다 — 후보가 있고 주소·비밀이 둘 다 있을 때만 엣지를 부른다(유휴 시 호출 0). 응답은 기다리지 않는다(pg_net 비동기).
create or replace function public.msgr_storage_sweep_kick() returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; sec text;
begin
  select value into url from public.msgr_settings where key = 'storage_sweep_url';
  select value into sec from public.msgr_settings where key = 'storage_sweep_secret';
  if coalesce(url, '') = '' or coalesce(sec, '') = '' then return false; end if;
  if not exists (select 1 from public.msgr_storage_sweep_list(1)) then return false; end if;
  perform net.http_post(url := url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || sec),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
  return true;
end $$;
revoke all on function public.msgr_storage_sweep_kick() from public, anon, authenticated;

-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 등록하지 않는다. 같은 이름이면 갱신이라 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr-storage-sweep', '17 * * * *', $c$select public.msgr_storage_sweep_kick()$c$);
  end if;
end $$;

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
  perform public._msgr_upload_gate(public._msgr_attachment_uploader(m.id), p_bytes); -- 무료 첨부 한도(20261011150000) — 에이전트 주인 몫, 봇이 신고한 크기(최소 1바이트)
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
