-- qbwr 전용: 번호 다시 매기기(scripts/msgr2-migrate-runbook.md "번호 다시 매기기") 뒤, qbwr-apply.sh run 20261020201600 전에 한 번 돈다.
-- qbwr-apply.sh pending()은 버전 번호만 보므로, 옛 번호로 이미 적용된 16개를 새 번호로 다시 적용하지 않게 새 번호를 기록만 한다(정의 적용 없음).
-- 옛 번호가 기록된 것만 새 번호를 기록한다. 옛 번호가 없으면 그 파일은 run이 적용한다. 다시 돌려도 0행. 운영(nvqo)에는 쓰지 않는다.
insert into supabase_migrations.schema_migrations (version, name)
select n.v, n.name from (values
  ('20261020200000','20261017151000','msgr2_space'), ('20261020200100','20261017235000','msgr2_device'),
  ('20261020200200','20261018000000','msgr2_work'), ('20261020200300','20261018010000','msgr2_realtime_storage'),
  ('20261020200400','20261018020000','msgr2_presence_attach'), ('20261020200500','20261018030000','msgr2_push'),
  ('20261020200600','20261018040000','msgr2_rooms'), ('20261020200700','20261018050000','msgr2_backfill'),
  ('20261020200800','20261018051000','msgr2_personal_files'), ('20261020200900','20261018052000','msgr2_migration_window'),
  ('20261020201000','20261018060000','msgr2_work_signal'), ('20261020201100','20261018061100','msgr2_push_viewing'),
  ('20261020201200','20261018061300','msgr2_invite_revoke_signal'), ('20261020201300','20261019155000','msgr2_link_v1_1_check'),
  ('20261020201400','20261019160000','msgr2_aplus'), ('20261020201500','20261020120000','msgr2_people')
) n(v, old, name)
where exists (select 1 from supabase_migrations.schema_migrations m where m.version = n.old)
on conflict (version) do nothing
returning version;
