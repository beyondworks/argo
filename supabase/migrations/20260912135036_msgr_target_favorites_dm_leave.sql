-- Favorites identify people/crews directly: saving or removing one must never create a DM.
create table public.msgr_target_prefs (
  user_id uuid not null references auth.users (id) on delete cascade,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  target_kind text not null check (target_kind in ('user', 'crew')),
  target_id uuid not null,
  pinned boolean not null default true,
  pin_pos integer,
  primary key (user_id, org_id, target_kind, target_id)
);
create index msgr_target_prefs_org on public.msgr_target_prefs (org_id);
alter table public.msgr_target_prefs enable row level security;
revoke all on public.msgr_target_prefs from anon, authenticated;
grant select, insert, update, delete on public.msgr_target_prefs to authenticated;
grant all on public.msgr_target_prefs to service_role;

-- Owners may read/remove stale favorites after a target leaves. New or changed
-- favorites must refer to a real target in an organization they can still access.
create policy msgr_target_prefs_select on public.msgr_target_prefs for select to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_target_prefs_delete on public.msgr_target_prefs for delete to authenticated
  using (user_id = (select auth.uid()));
create policy msgr_target_prefs_insert on public.msgr_target_prefs for insert to authenticated
  with check (user_id = (select auth.uid()) and public.msgr_is_member(org_id) and (
    (target_kind = 'user' and exists (
      select 1 from public.msgr_org_members m where m.org_id = msgr_target_prefs.org_id and m.user_id = target_id
        and m.removed_at is null and (m.expires_at is null or m.expires_at > now())))
    or (target_kind = 'crew' and exists (
      select 1 from public.msgr_crews c where c.org_id = msgr_target_prefs.org_id and c.id = target_id))
  ));
create policy msgr_target_prefs_update on public.msgr_target_prefs for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.msgr_is_member(org_id) and (
    (target_kind = 'user' and exists (
      select 1 from public.msgr_org_members m where m.org_id = msgr_target_prefs.org_id and m.user_id = target_id
        and m.removed_at is null and (m.expires_at is null or m.expires_at > now())))
    or (target_kind = 'crew' and exists (
      select 1 from public.msgr_crews c where c.org_id = msgr_target_prefs.org_id and c.id = target_id))
  ));

-- Leave only the caller's DM membership. Removing their crew first preserves
-- the owner-membership invariant without weakening the private-channel guard.
-- Existing participant RLS supplies the required rights; no definer bypass.
create function public.msgr_leave_dm(ch uuid) returns boolean
  language plpgsql security invoker set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); channel public.msgr_channels; removed integer;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || ch::text));
  select * into channel from public.msgr_channels where id = ch for update;
  if channel.id is null then return false; end if;
  if channel.kind <> 'dm' then raise exception 'msgr_dm_required' using errcode = '22023'; end if;
  if not coalesce(public.msgr_is_member(channel.org_id), false) then
    raise exception 'msgr_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.msgr_channel_members
      where channel_id = ch and member_kind = 'user' and member_id = me) then return false; end if;
  delete from public.msgr_channel_members m using public.msgr_crews c
    where m.channel_id = ch and m.member_kind = 'crew' and m.member_id = c.id
      and c.org_id = channel.org_id and c.owner_user_id = me;
  delete from public.msgr_channel_members where channel_id = ch and member_kind = 'user' and member_id = me;
  get diagnostics removed = row_count;
  if removed <> 1 then raise exception 'msgr_leave_failed' using errcode = '42501'; end if;
  return true;
end $$;
revoke all on function public.msgr_leave_dm(uuid) from public, anon;
grant execute on function public.msgr_leave_dm(uuid) to authenticated;
