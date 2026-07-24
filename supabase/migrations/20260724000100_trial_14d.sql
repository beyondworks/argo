-- 멀티디바이스 동기화 요금제 확정(2026-07-24 유건): 첫 2주 무료 체험 + Pro $16/월.
-- is_pro() = "클라우드 쓰기 자격"으로 의미 확장 — 유료(pro) 또는 가입 14일 이내(무료 체험).
-- 체험 판정은 서버가 auth.users.created_at으로 직접 계산 — 클라이언트가 위조할 수 없다(집행 권위 서버 원칙 유지).
-- entitlements에 free 행이 명시로 있어도(결제 취소 등) 가입 14일 이내면 체험 잔여기간은 유지된다(OR).
-- 기존 그랜드파더링 pro 계정은 앞 조건으로 계속 통과. 멱등.
create or replace function public.is_pro() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' from public.entitlements where user_id = auth.uid()), false)
        or coalesce((select created_at > now() - interval '14 days' from auth.users where id = auth.uid()), false)
$$;
-- 권한 재고정(멱등) — create or replace는 기존 ACL을 보존하지만, 신규 환경 단독 적용 대비 명시.
revoke all on function public.is_pro() from public;
revoke execute on function public.is_pro() from anon; -- Supabase default privileges 갭(20260723 실측) 방어
grant execute on function public.is_pro() to authenticated;
