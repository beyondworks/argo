-- 동기화 색인 RPC — 새 기기의 회사 발견·원격 tombstone 목록을 storage.list(= storage.search) 없이 돌려준다.
--
-- 실사고 2026-09-10(제보 "깃허브 계정으로 기기 동기화가 안 된다"): RLS(authenticated) 아래에서 storage.search는
-- lower(name) 범위 조건이 leakproof가 아니라 인덱스 조건으로 못 쓰이고 필터로 밀려나, 버킷 전체(23만 행)를 훑는다
-- (EXPLAIN 실측: Rows Removed by Filter 235,441 · 18.3초. 같은 조회를 RLS 없이 돌리면 0.13초). 클라이언트 fetch
-- 타임아웃(30초)에 걸리면 discoverRemote가 빈 목록으로 삼켜 새 기기가 자기 회사를 영영 못 찾는다. 오너 id가
-- 사전순으로 뒤일수록(예: fd…) 더 오래 훑으므로 사용자마다 증상이 다르다.
--
-- 이 함수는 security definer(RLS 우회)지만 경계는 함수 안에서 auth.uid()로 강제한다 — 호출자 자신의 접두사
-- 밖은 절대 읽지 않는다(is_pro·msgr_* 선례와 같은 계약). 범위 조건은 name COLLATE "C"라 (bucket_id, name COLLATE "C")
-- 인덱스를 그대로 탄다('/'=0x2F, '0'=0x30 — [uid/, uid0) 반개구간이 uid/ 아래 전부).
-- 반환 { companies: [slug…], tombstones: [wsId…] } — discoverRemote(점 접두 폴더 제외·최상위 파일 제외)와
-- syncTombstones 2단계(uid/.tombstones/<wsId>.json 직계 파일만)와 같은 판정이다. uid 없음(anon·서비스롤) = null.
create or replace function public.argo_sync_index() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with me as (select auth.uid()::text as uid),
  mine as (
    select o.name from storage.objects o, me
    where me.uid is not null
      and o.bucket_id = 'companies'
      and o.name collate "C" >= me.uid || '/'
      and o.name collate "C" < me.uid || '0'
  )
  select case when (select uid from me) is null then null else jsonb_build_object(
    'companies', coalesce((
      select jsonb_agg(distinct split_part(name, '/', 2)) from mine
      where split_part(name, '/', 3) <> ''            -- 폴더(아래 세그먼트가 있다) — 최상위 파일(_device-lease.json)은 제외
        and split_part(name, '/', 2) not like '.%'     -- .tombstones·.tg-claims 같은 점 접두 폴더는 회사가 아니다
    ), '[]'::jsonb),
    'tombstones', coalesce((
      select jsonb_agg(distinct left(split_part(name, '/', 3), -5)) from mine
      where split_part(name, '/', 2) = '.tombstones'
        and split_part(name, '/', 4) = ''              -- 직계 파일만
        and split_part(name, '/', 3) like '%.json'
    ), '[]'::jsonb)
  ) end
$$;
-- 권한 재고정(멱등) — is_pro와 같은 관례: public·anon 회수, authenticated만 실행.
revoke all on function public.argo_sync_index() from public;
revoke execute on function public.argo_sync_index() from anon;
grant execute on function public.argo_sync_index() to authenticated;
