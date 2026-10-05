-- 레몬스퀴지 웹훅 이메일 연결(2026-10-03) — 랜딩 결제 링크에는 custom user_id가 없다.
-- 운영 수신자(supabase/functions/ls-webhook)는 user_id가 없으면 400으로 끝나 실결제 2건(9/27·10/3)이 Pro에 연결되지 않았고
-- billing_unmatched에도 남지 않았다. 그래서 user_id가 없을 때 결제 이메일로 계정을 찾는 함수를 둔다.
--
-- 규칙: 결제 이메일(앞뒤 공백 제거·대소문자 무시)과 같은 이메일로 **인증된**(email_confirmed_at 있음) 계정이
-- 정확히 하나일 때만 그 id를 돌려준다. 0개·2개 이상·빈 이메일이면 null — 웹훅은 연결하지 않고 billing_unmatched에 남긴다.
-- 인증 안 된 계정은 세지 않는다: 남의 결제 이메일로 만들어 두고 인증하지 않은 계정이 그 결제를 가져가지 못하게.
-- 같은 구독이 이미 다른 계정에 붙어 있는지(duplicate-attribution)는 웹훅이 entitlements로 따로 본다 — 이 함수는 계정만 찾는다.
--
-- 서비스 롤 전용 — 이메일로 계정이 있는지 알아내는 통로라 anon·authenticated에 열지 않는다.
-- auth 스키마는 이름으로만 참조한다(search_path에 넣지 않는다).
create or replace function public.ls_user_by_email(p_email text) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select (array_agg(u.id))[1]
      from auth.users u
     where btrim(p_email) <> ''
       and lower(u.email) = lower(btrim(p_email))
       and u.email_confirmed_at is not null
    having count(*) = 1
$$;
revoke all on function public.ls_user_by_email(text) from public;
revoke execute on function public.ls_user_by_email(text) from anon, authenticated;
grant execute on function public.ls_user_by_email(text) to service_role;
