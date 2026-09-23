-- pg_cron 실행 기록 보존 기간 7일 — 매분 도는 msgr_automation_dispatch_cloud가 하루 1,440행씩 cron.job_run_details에 쌓는데
-- pg_cron은 기록을 지우지 않는다(2026-09-23 라이브: 9/13 이후 15,259행). 실행 기록은 진단용 로그일 뿐 기억 데이터가 아니다.
-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-cron-run-details', '17 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
  end if;
end $$;
