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
-- 반환은 위 주석 참조 — discoverRemote(점 접두 폴더 제외·최상위 파일 제외)와
-- syncTombstones 2단계(uid/.tombstones/<wsId>.json 직계 파일만)와 같은 판정이다. uid 없음(anon·서비스롤) = null.
-- 적용 역할 게이트(분리 검수 HIGH-1): definer 함수의 소유자가 storage.objects의 RLS를 우회하지 못하면 오류 없이 0행 —
-- 사고와 같은 무음 실패가 된다. 우회 못 하는 역할로 적용되면 여기서 큰 소리로 멈춘다(실 Supabase: postgres=bypassrls, 실측 2026-09-10).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = current_user and (rolbypassrls or rolsuper))
     and (select pg_get_userbyid(relowner) from pg_class where oid = 'storage.objects'::regclass) <> current_user then
    raise exception 'argo_sync_index: 적용 역할 %는 storage.objects의 RLS를 우회하지 못한다 — 색인이 조용히 비게 되므로 중단', current_user;
  end if;
end $$;
-- 반환 { owner: uid, companies: [slug…], tombstones: [wsId…] } — owner는 클라이언트가 세션 uid와 대조한다(라벨 오염 방지, 검수 MEDIUM-1).
create or replace function public.argo_sync_index() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  with me as (select auth.uid()::text as uid),
  mine as (
    select o.name from storage.objects o, me
    where me.uid is not null
      and o.bucket_id = 'companies'
      and o.name collate "C" >= me.uid || '/'
      and o.name collate "C" < me.uid || '0'
      -- 버전 관리 열(archived_at·is_delete_marker)이 있는 스토리지에서는 옛 버전·삭제 마커를 제외한다(검수 MEDIUM-4).
      -- to_jsonb 경유라 열이 없는 셀프호스트에서도 NULL로 무해 통과.
      and (to_jsonb(o) ->> 'archived_at') is null
      and coalesce((to_jsonb(o) ->> 'is_delete_marker')::boolean, false) = false
  )
  select case when (select uid from me) is null then null else jsonb_build_object(
    'owner', (select uid from me),
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
