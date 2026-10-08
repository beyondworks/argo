-- 동기화 색인 RPC 속도 개선 — 반환은 20260910120000과 같고, 최상위 항목마다 첫 객체 하나만 읽고 다음 항목으로 건너뛴다.
--
-- 실측(2026-10-08, 운영 읽기 전용 — pg_stat_statements·EXPLAIN): PostgREST 호출 37,730회 평균 444ms·최대 7,972ms. authenticated
-- statement_timeout(8초)을 가끔 넘겨 클라이언트가 storage.list 폴백으로 떨어졌다(상주 오류 로그 2건, 1건은 재시작 직후 첫 동기화).
-- 원인: 오너 접두사 아래 객체를 **전부** 읽었다. 객체 24,864개 오너의 회사 3개를 얻으려고 힙 페이지 24,711개를 읽고(차가운 캐시
-- 12.4초·데운 캐시 1.7초), 행마다 to_jsonb(o)를 두 번 만든 뒤 정렬이 디스크로 넘쳤다(work_mem 3.5MB).
-- 이 판: 최상위 항목(회사 폴더·점 접두 폴더·최상위 파일)마다 살아 있는 첫 객체 하나를 인덱스로 찾고, 폴더면 그 범위
-- [uid/S/, uid/S0)를 통째로 건너뛴다('/'=0x2F, '0'=0x30 — 그 범위에는 uid/S/… 말고는 없다). 같은 오너에서 4.9ms·버퍼 27개
-- (운영 EXPLAIN). 비용은 객체 수가 아니라 최상위 항목 수에 비례한다.
-- 최상위 파일(uid/S, '/' 하나)을 만나면 바로 다음 이름으로만 나아간다 — uid/S와 uid/S/… 사이에 uid/S-x/…처럼 S로 시작하는
-- 다른 항목이 끼어 있을 수 있어서다('-'=0x2D·'.'=0x2E < '/'). 건너뛰면 그 항목을 놓친다.
-- 회사 판정(아래 세그먼트가 비지 않은 객체가 있는 폴더)은 항목마다 인덱스 조회 한 번, tombstone은 uid/.tombstones/ 범위만 읽는다.
-- 그 밖의 계약은 20260910120000 그대로: definer지만 경계는 auth.uid(), 범위·정렬은 collate "C"(운영 기본 정렬은 ICU en-US라
-- collate가 빠지면 [uid/, uid0) 범위가 성립하지 않는다), 버전 관리 열은 to_jsonb 경유(열이 없는 셀프호스트에서도 NULL로 통과).
-- 소유자·권한은 create or replace가 유지한다(아래 재고정은 멱등).
create or replace function public.argo_sync_index() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with recursive me as (select auth.uid()::text as uid),
  heads as (
    select f.name from me, lateral (
      select o.name from storage.objects o
      where o.bucket_id = 'companies'
        and o.name collate "C" >= me.uid || '/'
        and o.name collate "C" < me.uid || '0'
        and (to_jsonb(o) ->> 'archived_at') is null
        and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
      order by o.name collate "C" limit 1
    ) f
    where me.uid is not null
    union all
    select f.name from heads h, me, lateral (
      select o.name from storage.objects o
      where o.bucket_id = 'companies'
        and o.name collate "C" > h.name
        -- 폴더 안의 객체(이름에 '/'가 둘 이상)면 그 폴더 끝으로, 최상위 파일이면 바로 다음 이름으로
        and o.name collate "C" >= case when h.name like '%/%/%' then me.uid || '/' || split_part(h.name, '/', 2) || '0' else h.name end
        and o.name collate "C" < me.uid || '0'
        and (to_jsonb(o) ->> 'archived_at') is null
        and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
      order by o.name collate "C" limit 1
    ) f
  )
  select case when (select uid from me) is null then null else jsonb_build_object(
    'owner', (select uid from me),
    'companies', coalesce((
      select jsonb_agg(distinct split_part(h.name, '/', 2)) from heads h, me
      where split_part(h.name, '/', 2) not like '.%'     -- .tombstones·.tg-claims 같은 점 접두 폴더는 회사가 아니다
        -- 폴더(아래 세그먼트가 있다) — 최상위 파일(_device-lease.json)은 제외. exists로 쓰면 플래너가 세미 조인 + 순차 스캔으로
        -- 풀어, 짝이 없는 최상위 파일 하나에 표 전체를 읽는다(로컬 드릴 실측). 정렬 + limit 1 스칼라 서브쿼리는 조인으로 안 풀린다.
        and (
          select o.name from storage.objects o
          where o.bucket_id = 'companies'
            and o.name collate "C" >= me.uid || '/' || split_part(h.name, '/', 2) || '/'
            and o.name collate "C" < me.uid || '/' || split_part(h.name, '/', 2) || '0'
            and split_part(o.name, '/', 3) <> ''
            and (to_jsonb(o) ->> 'archived_at') is null
            and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
          order by o.name collate "C" limit 1
        ) is not null
    ), '[]'::jsonb),
    'tombstones', coalesce((
      select jsonb_agg(distinct left(split_part(o.name, '/', 3), -5)) from storage.objects o, me
      where o.bucket_id = 'companies'
        and o.name collate "C" >= me.uid || '/.tombstones/'
        and o.name collate "C" < me.uid || '/.tombstones0'
        and split_part(o.name, '/', 4) = ''              -- 직계 파일만
        and split_part(o.name, '/', 3) like '%.json'
        and (to_jsonb(o) ->> 'archived_at') is null
        and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
    ), '[]'::jsonb)
  ) end
$$;
revoke all on function public.argo_sync_index() from public;
revoke execute on function public.argo_sync_index() from anon;
grant execute on function public.argo_sync_index() to authenticated;
