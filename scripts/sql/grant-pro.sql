-- 운영자 수동 Pro 부여(R2, 2026-09-29) — 결제 없이 Pro를 주는 유일한 경로. 공개 저장소라 이메일을
-- 파일에 적지 않는다 — psql 변수(:'email')로 그때그때 받는다. entitlements.granted=true 행은
-- 결제 웹훅(apply_ls_event·supabase/functions/ls-webhook)이 plan을 못 내린다(20260929110000).
--
-- 사용법(값은 셸 히스토리에 남으니 -v보다 대화형 \prompt를 권장):
--   psql "$DATABASE_URL" -f scripts/sql/grant-pro.sql          -- 이메일을 그 자리에서 입력받는다
--   psql "$DATABASE_URL" -v email='user@example.com' -f scripts/sql/grant-pro.sql
--
-- 되돌리기(부여 회수) — revoke=1:
--   psql "$DATABASE_URL" -v email='user@example.com' -v revoke=1 -f scripts/sql/grant-pro.sql
--
-- 주의: psql 변수(:'email' 등)는 이 파일의 top-level SQL에서만 치환된다 — DO 블록의 $$...$$ 안은
-- psql이 건드리지 않으므로, 값은 미리 임시표(_grant_target)에 담아 DO 블록에는 그 표만 넘긴다.

\if :{?email}
\else
  \prompt 'Pro를 부여할 계정 이메일: ' email
\endif

\if :{?revoke}
\else
  \set revoke 0
\endif

select id as uid, (:'revoke' = '1') as is_revoke into temporary table _grant_target
  from auth.users where email = :'email';

select count(*) as n from _grant_target \gset

\if :n
  do $$
  declare uid uuid; is_revoke boolean;
  begin
    select t.uid, t.is_revoke into uid, is_revoke from _grant_target t;
    if is_revoke then
      update public.entitlements set granted = false, updated_at = now() where user_id = uid;
      raise notice '부여 회수 완료(user_id=%). plan·ends_at은 그대로 — 결제 자격은 별도 판단.', uid;
    else
      insert into public.entitlements (user_id, plan, granted, updated_at)
        values (uid, 'pro', true, now())
      on conflict (user_id) do update set granted = true, updated_at = now();
      raise notice 'Pro 부여 완료(user_id=%). 결제 웹훅이 이 행의 plan을 내리지 않습니다(granted=true).', uid;
    end if;
  end $$;
\else
  \echo '이메일에 해당하는 계정이 없습니다 — auth.users에서 못 찾음'
\endif

drop table _grant_target;

-- 확인: select user_id, plan, granted, ends_at from public.entitlements where user_id = (select id from auth.users where email = :'email');
