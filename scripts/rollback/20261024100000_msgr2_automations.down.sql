-- 되돌림: supabase/migrations/20261024100000_msgr2_automations.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: ① 크론 두 개(msgr2-automation-dispatch·purge-msgr2-automation-runs)를 먼저 내린다 — 함수를 지운 뒤 크론이 남으면 매분 오류가 쌓인다.
--   ② msgr2_works 트리거·함수·표 msgr2_automations·msgr2_automation_runs를 지운다(일정 설정·실행 기록뿐, 기억 데이터 없음).
-- 남기는 것: 자동화가 넣은 지시 글과 그 답(msgr2_messages)·일 기록(msgr2_works). 글의 meta(automation_id 등)는 그대로 둔다(읽는 곳 없음).
-- 앱: v2 업무 창의 자동화 탭은 표·함수가 없으면 "업데이트 필요" 안내를 띄운다(work-panel.jsx missingSchema) — 빈 동작·오류 화면이 아니다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261024100000_msgr2_automations.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname in ('msgr2-automation-dispatch', 'purge-msgr2-automation-runs');
  end if;
end $$;
drop trigger if exists msgr2_automation_work_state on public.msgr2_works;
drop function if exists public._msgr2_automation_work_state();
drop function if exists public.msgr2_automation_scheduler_status();
drop function if exists public.msgr2_automation_dispatch();
drop function if exists public.msgr2_automation_run_now(uuid, uuid);
drop function if exists public._msgr2_automation_enqueue(public.msgr2_automations, text);
drop function if exists public.msgr2_automation_delete(uuid);
drop function if exists public.msgr2_automation_set_enabled(uuid, boolean);
drop function if exists public.msgr2_automation_save(uuid, uuid, uuid, text, text, jsonb, uuid);
drop function if exists public._msgr2_automation_deny(text);
drop function if exists public._msgr2_automation_gen(uuid);
drop function if exists public._msgr2_automation_device();
drop function if exists public._msgr2_automation_why(uuid, uuid, uuid);
drop function if exists public._msgr2_automation_next(jsonb, timestamptz);
drop table if exists public.msgr2_automation_runs;
drop table if exists public.msgr2_automations;
commit;
