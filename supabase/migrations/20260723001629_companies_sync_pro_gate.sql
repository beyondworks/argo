-- 클라우드 동기화(companies 버킷 쓰기)를 Pro 전용으로 — 페이월을 클라이언트에서 서버(Storage RLS)로 이전(Phase1 B, 2026-07-23).
-- 무료 계정은 클라우드에 쓰기 금지(로컬 전부 무제한은 불변). 읽기(select)·삭제(delete)는 소유자 경계만 유지 =
-- 다운그레이드·내보내기 데이터 소유권 존중. 서비스롤(자가호스트·워커)은 RLS 우회라 무영향. 멱등.
--
-- 집행 권위는 이 정책이다: 클라이언트(src/entitlement.mjs)는 우아한 페이월 안내용 pre-flight일 뿐,
-- 수정된 클라이언트가 검사를 건너뛰어도 이 정책이 무료 계정의 쓰기를 거부한다.
-- ⚠ 활성화는 **원자적으로**(검수 2026-07-23 HIGH): 이 마이그레이션 적용과 `ARGO_ENFORCE_PLAN=1`을
--    반드시 함께 켠다. 마이그레이션만 먼저 적용되면 무료 계정에서 비대칭이 생긴다 —
--    클라이언트 페이월 게이트가 통과해 동기화가 진입하는데, delete 정책은 그대로라 **삭제는 전파되고**
--    insert/update는 RLS가 거부해 **push만 실패** → 클라우드 사본이 줄어들기만 한다.
--    리더 선출은 이 게이트의 영향을 받지 않는다: 리스 키(_device-lease.json)를 아래 정책에서 Pro 예외로 두고,
--    src/sync.mjs가 리스 중재를 요금제 게이트보다 **먼저** 수행한다 → 무료 계정도 정확히 한 대만 리더가 되어
--    루틴·메신저가 정상 동작한다(PRODUCT-SPEC의 "Free=로컬 전부 무제한·단일 기기"와 일치). 쓰기 거부 시
--    리더십은 확인된 보유자·TTL 내에서만 유지되므로(그 외 강등) 이중 리더도 나지 않는다.
--    적용 전엔 기존 동작 불변.

-- 계정이 Pro인가 — entitlements를 안전 조회(무행=false=무료). RLS 정책에서 호출.
-- security definer + 고정 search_path: 정책 평가 컨텍스트와 무관하게 조회 보장 + search_path 주입 방지.
-- ⚠ 파라미터를 두지 않는다(보안 검수 2026-07-23): uid를 받으면 security definer가 entitlements RLS를
-- 우회하므로, Supabase가 public 스키마 함수를 /rest/v1/rpc로 자동 노출하는 특성과 결합해
-- "임의 사용자의 결제 상태 조회 오라클"이 된다. 내부에서 auth.uid()만 보면 호출자 본인 상태만 반환된다.
-- (구 시그니처 is_pro(uuid) 정리는 **정책 재생성 이후** 맨 아래에서 한다 — 먼저 drop하면 기존 정책이
--  그 함수에 의존해 "cannot drop … because other objects depend on it"으로 중단되고 이 파일 전체가 미적용된다.)
create or replace function public.is_pro() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' from public.entitlements where user_id = auth.uid()), false)
$$;
-- Postgres는 함수 생성 시 PUBLIC에 EXECUTE를 기본 부여한다 — 익명(anon) RPC 호출을 막으려면 명시 회수 필수.
revoke all on function public.is_pro() from public;
grant execute on function public.is_pro() to authenticated;

-- 쓰기(insert)에 Pro 게이트 추가 — 소유자 경계(foldername[1]=auth.uid())는 유지.
drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    -- 리스 파일(_device-lease.json)은 Pro 게이트 예외 — 리더 선출은 과금 대상이 아니라 이중 실행 방지용
    -- 조정이고, 무료 계정도 단일 기기에서 루틴·메신저가 돌아야 한다(PRODUCT-SPEC: Free=로컬 전부 무제한).
    -- 오너 경계는 바로 위 조건이 그대로 유지하므로 남의 리스는 건드릴 수 없다.
    and (public.is_pro() or name = (select auth.uid()::text) || '/_device-lease.json')
  );

-- 쓰기(update)에 Pro 게이트 추가 — using(대상 행 선택)은 소유자 경계, with check(새 값)에 Pro 결합.
drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    -- 리스 파일(_device-lease.json)은 Pro 게이트 예외 — 리더 선출은 과금 대상이 아니라 이중 실행 방지용
    -- 조정이고, 무료 계정도 단일 기기에서 루틴·메신저가 돌아야 한다(PRODUCT-SPEC: Free=로컬 전부 무제한).
    -- 오너 경계는 바로 위 조건이 그대로 유지하므로 남의 리스는 건드릴 수 없다.
    and (public.is_pro() or name = (select auth.uid()::text) || '/_device-lease.json')
  );

-- companies_owner_select / companies_owner_delete 는 변경하지 않는다(소유자 경계만):
-- 무료·다운그레이드 계정도 기존 클라우드 데이터를 pull(내보내기)·삭제(정리)할 수 있어야 한다(데이터 소유권).

-- 마지막에 구 시그니처 제거 — 위 정책들이 이제 무파라미터 is_pro()를 참조하므로 의존성이 없다(멱등).
drop function if exists public.is_pro(uuid);
