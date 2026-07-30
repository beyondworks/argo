-- 만료 집행: is_pro()가 ends_at을 본다 — 해지·만료 웹훅 1건이 유실돼도 ends_at이 지나면
-- 자격이 저절로 꺼진다(전수리뷰 2026-07-30 #5: "만료 웹훅 유실 = 영구 무료 Pro". 대사는 승격 전용이라
-- 만료를 회수하지 못했다). ends_at 의미(레몬스퀴지 계약, src/lsbilling.mjs): 활성 구독 = null,
-- 해지 예약·만료 = 접근 종료 시각(그때까지 접근 유지가 LS 계약). 따라서
--  - 그랜드파더링 pro(ends_at null) → 그대로 통과
--  - 활성 LS 구독(ends_at null) → 통과 (갱신 시각과 무관 — 갱신 지연으로 유료 사용자를 오차단하지 않는다)
--  - 해지 예약 → ends_at까지 통과, 지나면 웹훅 수신 여부와 무관하게 차단
-- 가입 14일 무료 체험 OR 조건은 유지. 멱등.
create or replace function public.is_pro() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' and (ends_at is null or ends_at > now())
                       from public.entitlements where user_id = auth.uid()), false)
        or coalesce((select created_at > now() - interval '14 days' from auth.users where id = auth.uid()), false)
$$;
-- 권한 재고정(멱등) — create or replace는 기존 ACL을 보존하지만, 신규 환경 단독 적용 대비 명시.
revoke all on function public.is_pro() from public;
revoke execute on function public.is_pro() from anon; -- Supabase default privileges 갭(20260723 실측) 방어
grant execute on function public.is_pro() to authenticated;
