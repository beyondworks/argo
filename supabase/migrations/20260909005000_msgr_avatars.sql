-- 프로필 이미지(사람·에이전트) + 에이전트 소개 — 유건 지시 2026-09-09 "내 계정에서 프로필 이미지 수정, 내가 관리하는 에이전트 프로필도 설정".
-- 저장 = 공개 버킷 msgr-avatars, 경로 avatars/<uid>/<file> — 쓰기는 자기 폴더만(에이전트 이미지도 소유자 폴더에 crew-<id>-…).
alter table public.msgr_profiles add column if not exists avatar_url text check (avatar_url is null or length(avatar_url) <= 600);
alter table public.msgr_crews add column if not exists avatar_url text check (avatar_url is null or length(avatar_url) <= 600);
alter table public.msgr_crews add column if not exists bio text check (bio is null or length(bio) <= 300);

insert into storage.buckets (id, name, public) values ('msgr-avatars', 'msgr-avatars', true) on conflict (id) do nothing;
drop policy if exists msgr_avatars_read on storage.objects;
create policy msgr_avatars_read on storage.objects for select to anon, authenticated using (bucket_id = 'msgr-avatars');
drop policy if exists msgr_avatars_write on storage.objects;
create policy msgr_avatars_write on storage.objects for insert to authenticated
  with check (bucket_id = 'msgr-avatars' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = (select auth.uid())::text);
drop policy if exists msgr_avatars_update on storage.objects;
create policy msgr_avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'msgr-avatars' and (storage.foldername(name))[2] = (select auth.uid())::text);
drop policy if exists msgr_avatars_delete on storage.objects;
create policy msgr_avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'msgr-avatars' and (storage.foldername(name))[2] = (select auth.uid())::text);

-- 같은 조직 사람들의 아바타 — 프로필 표는 본인·친구만 읽으므로 아바타만 따로 내준다(security definer, 조직을 공유하는 상대만).
create or replace function public.msgr_avatars(ids uuid[])
returns table (user_id uuid, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.avatar_url from public.msgr_profiles p
  where p.user_id = any (ids) and p.avatar_url is not null
    and (p.user_id = (select auth.uid()) or exists (
      select 1 from public.msgr_org_members a join public.msgr_org_members b on a.org_id = b.org_id
      where a.user_id = (select auth.uid()) and b.user_id = p.user_id and a.removed_at is null and b.removed_at is null))
$$;
grant execute on function public.msgr_avatars(uuid[]) to authenticated;
