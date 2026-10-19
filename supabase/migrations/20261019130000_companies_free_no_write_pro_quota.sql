-- 무료 계정은 클라우드에 쓰지 않는다 + Pro 클라우드 5GB(유건 2026-10-19 11:49·12:56 KST):
--   "무료 계정은 앞으로 로그인 해서 사용을 하더라도 DB 이용 못하게 해줘. 무조건 Pro 플랜부터 DB 이용 가능하고 Pro는 5GB까지 사용 가능하게 열어줘."
--   "무료 사용자는 나중에 pro 전환을 위해 로그인만 하는 개념이고 사용은 전적으로 로컬에서 하도록 해야해. 텔레그램을 연결하든 뭘 하든."
--
-- 이 파일이 하는 것(쓰기·할당량). 무료 계정의 읽기(select) 차단과 argo_sync_index 빈 결과는 20261019130100_companies_free_no_read.sql(같은 PR).
-- 적용 순서: 무료 사본 정리(Storage API, M1) 끝 → 130000·130100·130200.
--   1) companies 버킷 insert·update = is_pro()만. 무료 예외였던 <uid>/_device-lease.json·<uid>/.tg-claims/<지문>.json(20260903122559)을 없앤다.
--      새 앱(무료면 클라우드 호출 0, 이 기기가 실행 담당)은 리스·클레임을 쓰지 않는다. 옛 앱(무료면서 리스를 쓰는 판)은 403을 받아 120초 뒤 실행 담당을 잃는다 —
--      로컬 루틴·텔레그램이 멈춘다(분리 검수 1차 높음). 그래서 이 파일은 새 앱 발행 → 최소 앱 버전을 새 앱으로 올림(#1107 장치 — 옛 앱은 세션 없음으로 멈추고
--      업데이트 화면) → 적용 순서로만 적용한다(PR 본문).
--      delete는 그대로(플랜 무관 — 무료 사용자가 자기 사본을 지울 수 있게, 비용 없음).
--   2) Pro 저장 한도 5GiB(5,368,709,120바이트) — companies 버킷 insert·update에 RESTRICTIVE 정책 argo_companies_quota.
--      판정 = 그 계정의 지금 있는 companies 객체 크기 합(같은 이름 객체 제외 — 덮어쓰기는 옛 크기를 빼고 본다) + 이번 신고 크기 ≤ 한도.
--      초과면 'quota_exceeded'(SQLSTATE PT402 — 메신저 첨부 한도와 같은 코드라 앱이 이미 'code: PT402'를 안다). 기존 파일은 지우지 않는다.
--      예외: 제어 파일 <uid>/_device-lease.json·<uid>/.tg-claims/<지문>.json·<uid>/.tombstones/<회사>.json(신고 64KiB 이하 또는 신고 없음)은 한도를 보지 않는다 —
--      한도가 찬 Pro의 루틴·텔레그램·회사 보관 전파 보존. 한도를 넘은 계정도 합계를 늘리지 않는 덮어쓰기(같은 이름, 같거나 작은 크기)는 받는다 — 매니페스트를 다시 쓰고
--      파일을 지워 한도 아래로 내려갈 수 있게. 삭제는 정책과 무관하게 언제나 된다.
--      왜 사용량 표가 없나: storage-api는 정책 판정을 사용자 권한 트랜잭션에서 시험한 뒤 되돌린다(supabase/storage src/storage/database/pg.ts
--      testPermission — 일부러 오류를 던져 롤백). 판정 중에 쓴 사용량은 남지 않는다. 그래서 업로드마다 그 계정 범위를 색인으로 합산한다(쓰기 0).
--      신고 크기 = storage-api가 판정용 행에 싣는 metadata.contentLength(supabase/storage #825). 없으면(옛 storage-api) 1바이트로 본다.
--      초과 폭: 동시에 판정되는 업로드는 서로를 보지 못한다 — 넘을 수 있는 양 = 동시 업로드 수 × 파일 하나(앱 상한 50MiB). PR 본문에 실제 수.
--   (메신저 무료 에이전트 0명은 20261019130200_msgr_free_agent_zero.sql — 메신저 PG 시험이 msgr 파일을 모아 적용하므로 그 이름으로 둔다.)
--
-- 비용(DB 위생): 정책 판정은 읽기만(쓰기 0, 업로드가 없으면 호출 0). 업로드 1건 = is_pro 1회 + 그 계정 범위 합계 1회(객체 수에 비례 — PR 본문 측정값).
--   무료 계정은 is_pro가 거짓이면 합계를 내지 않는다.
-- 적용 전 확인(M1, 읽기만): 이미 5GiB를 넘은 Pro 계정 — 그 계정은 새 파일 업로드와 커지는 덮어쓰기가 막힌다. 같거나 작아지는 덮어쓰기·삭제·제어 파일은 된다.
--   select split_part(name, '/', 1) uid, sum((metadata->>'size')::bigint) bytes from storage.objects where bucket_id = 'companies'
--    group by 1 having sum((metadata->>'size')::bigint) > 5368709120;
-- 적용: bash scripts/msgr-live-apply.sh 20261019130000_companies_free_no_write_pro_quota (storage.objects 정책 교체 — 선잠금 대상)
-- 되돌리기(데이터를 건드리지 않는다):
--   drop policy argo_companies_quota on storage.objects; drop policy argo_companies_quota_update on storage.objects;  ← 할당량만 끄기
--   무료 쓰기 예외 되살리기: 20260903122559_tg_claims_pro_gate_exception.sql의 insert·update 정책을 다시 적용.
--   메신저 무료 4명 되살리기: 20261019130200_msgr_free_agent_zero.sql 머리말.
set local lock_timeout = '5s';

-- 1) 무료 쓰기 차단 — 예외 없이 is_pro()
drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.is_pro()
  );

drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies'
         and (name collate "C") >= ((select auth.uid())::text || '/')
         and (name collate "C") <  ((select auth.uid())::text || '0'))
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.is_pro()
  );

-- 2) Pro 5GiB 할당량
create or replace function public._argo_quota_bytes() returns bigint
  language sql immutable as $$ select 5368709120::bigint $$; -- 5GiB(머리말)
revoke all on function public._argo_quota_bytes() from public, anon, authenticated;

-- 2-a) 그 계정의 지금 있는 companies 객체 크기 합. storage.objects 열은 storage-api 버전마다 달라(버전 관리 열 archived_at·is_delete_marker)
--      적용할 때 있는 열만으로 본문을 만든다(20261011150000 _msgr_live_objects와 같은 방식). 범위 비교는 collate "C" — (bucket_id, name COLLATE "C") 색인.
--      p_except = 지금 쓰는 이름(덮어쓰기면 옛 크기를 빼고 새 신고 크기를 더한다).
do $$
declare has text[]; sz text; live text := ''; body text;
begin
  if to_regclass('storage.objects') is null then
    body := 'select 0::bigint';
  else
    select coalesce(array_agg(attname::text), '{}') into has from pg_attribute
     where attrelid = 'storage.objects'::regclass and attnum > 0 and not attisdropped
       and attname in ('metadata', 'archived_at', 'is_delete_marker');
    sz := case when 'metadata' = any (has) then $s$(o.metadata->>'size')::bigint$s$ else '0::bigint' end;
    if 'archived_at' = any (has) then live := live || ' and o.archived_at is null'; end if;
    if 'is_delete_marker' = any (has) then live := live || ' and not coalesce(o.is_delete_marker, false)'; end if;
    body := format($f$select coalesce(sum(%s), 0)::bigint from storage.objects o
      where o.bucket_id = 'companies'
        and (o.name collate "C") >= p_uid::text || '/' and (o.name collate "C") < p_uid::text || '0'
        and o.name is distinct from p_except%s$f$, sz, live);
  end if;
  execute format($f$create or replace function public._argo_companies_used(p_uid uuid, p_except text default null) returns bigint
    language sql stable security definer set search_path = public, pg_temp as $b$ %s $b$ $f$, body);
  execute 'revoke all on function public._argo_companies_used(uuid, text) from public, anon, authenticated';
  -- 같은 이름의 지금 있는 객체 크기(덮어쓰기가 합계를 늘리는지 — 2-b) — (bucket_id, name) 색인 한 번
  execute format($f$create or replace function public._argo_companies_size(p_name text) returns bigint
    language sql stable security definer set search_path = public, pg_temp as $b$ %s $b$ $f$,
    case when to_regclass('storage.objects') is null then 'select 0::bigint'
         else format($g$select coalesce(sum(%s), 0)::bigint from storage.objects o where o.bucket_id = 'companies' and o.name = p_name%s$g$, sz, live) end);
  execute 'revoke all on function public._argo_companies_size(text) from public, anon, authenticated';
end $$;

-- 2-b) 정책 판정 — 호출한 사람 자신만(uid를 받지 않는다 — 남의 사용량을 묻는 통로가 되지 않게). p_row = 넣거나 바꾸려는 행(to_jsonb).
--      남의 경로·무료 계정은 여기서 판정하지 않는다(허용 정책 companies_owner_insert·update가 거절한다 — 합계를 낼 필요가 없다).
create or replace function public.argo_companies_quota_check(p_row jsonb) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); nm text := p_row->>'name'; n text := p_row->'metadata'->>'contentLength'; used bigint; sz bigint; prev bigint;
begin
  if me is null or nm is null or left(nm, 37) <> me::text || '/' then return true; end if;
  if not public.is_pro() then return true; end if;
  -- 제어 파일은 한도를 보지 않는다 — 실행 담당(리스·텔레그램 토큰 클레임)과 회사 보관 표지(툼스톤 — 삭제 전파에 필요)(분리 검수 1차 높음·엄격 검수 C1·C2).
  -- 이름이 정확히 그 모양이고 신고 크기가 64KiB 이하이거나 신고 크기가 없을 때만(이 통로로 큰 파일을 쌓지 못하게 — 실제 글은 수백 바이트).
  -- 신고 크기가 없는 storage-api에서도 리스가 막히지 않게 없음을 허용한다(C1).
  if (nm = me::text || '/_device-lease.json' or nm ~ ('^' || me::text || '/\.tg-claims/[0-9a-f]{24}\.json$')
      or nm ~ ('^' || me::text || '/\.tombstones/[^/]{1,200}\.json$'))
     and (coalesce(n, '') = '' or (n ~ '^[0-9]{1,18}$' and n::bigint <= 65536)) then return true; end if;
  sz := greatest(case when n ~ '^[0-9]{1,18}$' then n::bigint else 0 end, 1);
  used := public._argo_companies_used(me, nm);
  if used + sz <= public._argo_quota_bytes() then return true; end if;
  -- 이미 한도를 넘은 계정: 합계를 늘리지 않는 덮어쓰기(같은 이름, 크기가 같거나 작음)는 받는다 — 매니페스트를 다시 쓰고 파일을 줄여
  -- 한도 아래로 내려갈 수 있게(엄격 검수 C2: 기준 "한도를 넘은 Pro가 앱에서 파일을 지우면 클라우드도 한도 아래로 내려간다"). 새 파일·커지는 덮어쓰기는 거절.
  prev := public._argo_companies_size(nm);
  if prev > 0 and sz <= prev then return true; end if;
  raise exception 'quota_exceeded' using errcode = 'PT402',
    detail = 'cloud storage for this plan is full; existing files are kept', hint = 'quota_bytes';
end $$;
revoke all on function public.argo_companies_quota_check(jsonb) from public, anon;
grant execute on function public.argo_companies_quota_check(jsonb) to authenticated;

-- CASE로 다른 버킷은 판정 함수를 부르지 않는다(OR은 평가 순서를 보장하지 않는다 — msgr_files_storage_limit과 같다).
drop policy if exists argo_companies_quota on storage.objects;
create policy argo_companies_quota on storage.objects as restrictive for insert to authenticated
  with check (case when bucket_id = 'companies' then public.argo_companies_quota_check(to_jsonb(objects)) else true end);
drop policy if exists argo_companies_quota_update on storage.objects;
create policy argo_companies_quota_update on storage.objects as restrictive for update to authenticated
  using (true)
  with check (case when bucket_id = 'companies' then public.argo_companies_quota_check(to_jsonb(objects)) else true end);

-- 2-c) 앱의 80% 알림용 — 내 사용량·한도(읽기만). 무료면 used 0·limit 0(쓸 수 없다). 앱은 업로드한 사이클 뒤에만, 최대 1시간에 1번 부른다.
create or replace function public.argo_storage_quota() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  if not public.is_pro() then return jsonb_build_object('used', 0, 'limit', 0, 'pro', false); end if;
  return jsonb_build_object('used', public._argo_companies_used(me), 'limit', public._argo_quota_bytes(), 'pro', true);
end $$;
revoke all on function public.argo_storage_quota() from public, anon;
grant execute on function public.argo_storage_quota() to authenticated;
