-- 클라우드 동기화(companies 버킷 쓰기)를 Pro 전용으로 — 페이월을 클라이언트에서 서버(Storage RLS)로 이전(Phase1 B, 2026-07-23).
-- 무료 계정은 클라우드에 쓰기 금지(로컬 전부 무제한은 불변). 읽기(select)·삭제(delete)는 소유자 경계만 유지 =
-- 다운그레이드·내보내기 데이터 소유권 존중. 서비스롤(자가호스트·워커)은 RLS 우회라 무영향. 멱등.
--
-- 집행 권위는 이 정책이다: 클라이언트(src/entitlement.mjs)는 우아한 페이월 안내용 pre-flight일 뿐,
-- 수정된 클라이언트가 검사를 건너뛰어도 이 정책이 무료 계정의 쓰기를 거부한다.
-- 활성화 절차(런치): 이 마이그레이션 적용 + ARGO_ENFORCE_PLAN=1(클라 UX). 적용 전엔 기존 동작 불변.

-- 계정이 Pro인가 — entitlements를 안전 조회(무행=false=무료). RLS 정책에서 호출.
-- security definer + 고정 search_path: 정책 평가 컨텍스트와 무관하게 조회 보장 + search_path 주입 방지.
create or replace function public.is_pro(uid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' from public.entitlements where user_id = uid), false)
$$;
grant execute on function public.is_pro(uuid) to authenticated;

-- 쓰기(insert)에 Pro 게이트 추가 — 소유자 경계(foldername[1]=auth.uid())는 유지.
drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.is_pro((select auth.uid()))
  );

-- 쓰기(update)에 Pro 게이트 추가 — using(대상 행 선택)은 소유자 경계, with check(새 값)에 Pro 결합.
drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (
    bucket_id = 'companies'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
    and public.is_pro((select auth.uid()))
  );

-- companies_owner_select / companies_owner_delete 는 변경하지 않는다(소유자 경계만):
-- 무료·다운그레이드 계정도 기존 클라우드 데이터를 pull(내보내기)·삭제(정리)할 수 있어야 한다(데이터 소유권).
