-- Optional server scheduler installation, run by the deployment owner after migrations.
-- Does not enable/install extensions or assume a hosted provider. On a host without
-- pg_cron, configure its trusted scheduler to call msgr_automation_dispatch_cloud()
-- every minute using the service role. Never expose that role to Messenger clients.
do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron unavailable: configure the host scheduler; resident fallback remains available';
    return;
  end if;
  execute $q$select cron.schedule('argo-msgr-automations','* * * * *','select public.msgr_automation_dispatch_cloud()')$q$;
end $$;
