-- 되돌림: supabase/migrations/20261018020000_msgr2_push.sql(U7 — v2 휴대폰 알림 트리거·받는 사람·장부·정리)를 걷어 낸다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). U2b·U2·U3·U1보다 먼저 되돌린다(이 파일이 그 단위의 표·함수를 부른다).
-- 알림 장부(msgr2_push_sent)는 실행 기록이다(기억 데이터 아님). 그래도 행이 있으면 지우지 않고 멈춘다 — 확인한 뒤 다시 실행한다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018020000_msgr2_push.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop trigger if exists msgr2_push_after_insert on public.msgr2_messages;
drop function if exists public.msgr2_push_enqueue();
drop function if exists public.msgr2_push_recipients(bigint);
drop function if exists public._msgr2_push_target(text, jsonb);
drop function if exists public.msgr2_push_prune();
do $$ begin
  -- pg_cron이 없는 DB에서는 cron.job을 참조하는 식 자체가 실패한다 — 확장이 있을 때만 동적으로 본다
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'msgr2-push-prune'$q$;
  end if;
  if to_regclass('public.msgr2_push_sent') is not null then
    if exists (select 1 from public.msgr2_push_sent) then raise exception 'msgr2_push_sent에 행이 있다 — 확인한 뒤 비우고 다시 실행한다'; end if;
    drop table public.msgr2_push_sent;
  end if;
end $$;
commit;
