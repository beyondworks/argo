-- companies 버킷 — 소유자(auth.uid) 폴더만 CRUD. 서비스 롤은 RLS를 우회한다(Fly 워커·셀프호스트 전용).
-- 경로 규약: companies/<ownerId>/<wsId>/... (src/sync.mjs skey) — 1세그먼트가 곧 테넌트 경계.
-- 멱등: drop if exists 후 create.
drop policy if exists companies_owner_select on storage.objects;
create policy companies_owner_select on storage.objects
  for select to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_insert on storage.objects;
create policy companies_owner_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_update on storage.objects;
create policy companies_owner_update on storage.objects
  for update to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));

drop policy if exists companies_owner_delete on storage.objects;
create policy companies_owner_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'companies' and (storage.foldername(name))[1] = (select auth.uid()::text));
