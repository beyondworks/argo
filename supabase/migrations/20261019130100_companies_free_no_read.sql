-- 무료 계정은 클라우드 사본을 읽지 않는다(유건 2026-10-19 "무료 계정은 … DB 이용 못하게", 13:4x KST 무료 사본 즉시 정리 결정).
-- 20261019130000(쓰기 차단·Pro 5GiB)과 따로 둔 파일 — 같은 PR로 함께 적용한다. 적용 순서: 무료 사본 정리(Storage API, M1)가 끝난 뒤 130000·130100·130200.
-- 알려진 결과: 이 차단은 무료 계정의 클라우드 내보내기·새 PC 무료 복원·자기 사본 삭제(delete의 where가 행을 읽고 storage-api remove도 먼저 읽는다)를 함께 없앤다.
--   무료 사본이 먼저 정리되므로 지킬 것이 남지 않는다. Pro가 되면 모두 되살아난다.
--   1) companies 버킷 select = 오너 범위 + is_pro(). (select public.is_pro())로 감싸 문장마다 한 번만 평가한다(행마다 부르지 않게).
--      delete 정책은 그대로(플랜 무관)지만 위 이유로 무료 계정에는 실제로 지울 행이 보이지 않는다. update의 using(오너 범위)은 그대로 — with check가 is_pro를 본다(130000).
--   2) argo_sync_index(): definer라 RLS를 거치지 않는다 — 무료면 회사·tombstone 빈 목록({owner, companies: [], tombstones: []}).
--      null이 아니라 빈 목록인 이유: 클라이언트 형태 검증을 통과해야 storage.list 폴백을 타지 않는다(sync-index-pg 시험의 '회사 0개' 계약).
--      본문은 20261008210000 그대로이고 두 곳(최상위 항목 첫 줄·tombstone)에 is_pro 조건만 더했다. 적용 전 운영 prosrc와 20261008210000 정의를 대조한다.
-- 부하: 읽기 판정에 is_pro 1회(문장당). 쓰기 0.
-- 적용: bash scripts/msgr-live-apply.sh 20261019130100_companies_free_no_read
-- 되돌리기: 20260912010000_storage_companies_policy_sargable.sql의 companies_owner_select를 다시 적용하고, 20261008210000_sync_index_skip_scan.sql을 다시 적용한다.
set local lock_timeout = '5s';

alter policy companies_owner_select on storage.objects
  using (bucket_id = 'companies'
         and (name collate "C") >= ((select auth.uid())::text || '/')
         and (name collate "C") <  ((select auth.uid())::text || '0')
         and (select public.is_pro()));

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
    where me.uid is not null and (select public.is_pro()) -- 무료면 빈 목록(20261019130100)
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
        and (select public.is_pro())                      -- 무료면 빈 목록(20261019130100)
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
