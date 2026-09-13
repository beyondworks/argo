-- Existing organization members can find one another by exact email, even before profile setup.
-- External accounts retain email opt-in. No email field, wildcard email, self or blocked results.
-- Keep the existing four-column RPC contract and friendship states for older desktop/mobile clients.
create or replace function public.msgr_find_user(q text) returns table (user_id uuid, handle text, display_name text, relation text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); needle text := lower(btrim(coalesce(q, '')));
begin
  if me is null then raise exception 'msgr_auth'; end if;
  if length(needle) < 3 then return; end if;
  return query
    select u.id, p.handle, coalesce(p.display_name, shared.display_name, split_part(u.email, '@', 1)),
           coalesce((select case when f.status = 'accepted' then 'friend' when f.status = 'pending' and f.requested_by = me then 'sent' when f.status = 'pending' then 'received' else f.status end
                       from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id)), 'none')
      from auth.users u left join public.msgr_profiles p on p.user_id = u.id
      left join lateral (
        select theirs.display_name, true as is_member
          from public.msgr_org_members mine
          join public.msgr_org_members theirs on theirs.org_id = mine.org_id and theirs.user_id = u.id
          join public.msgr_orgs org on org.id = mine.org_id and org.deleted_at is null
         where mine.user_id = me
           and mine.removed_at is null and (mine.expires_at is null or mine.expires_at > now())
           and theirs.removed_at is null and (theirs.expires_at is null or theirs.expires_at > now())
         order by theirs.joined_at, theirs.org_id limit 1
      ) shared on true
     where u.id <> me
       and ((needle like '%@%' and lower(u.email) = needle and (coalesce(p.email_search, false) or coalesce(shared.is_member, false)))
            or (needle not like '%@%' and p.handle is not null and p.handle like needle || '%' and coalesce(p.handle_search, true)))
       and not exists (select 1 from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id) and f.status = 'blocked')
     order by p.handle nulls last limit 10;
end $$;
revoke all on function public.msgr_find_user(text) from public, anon;
grant execute on function public.msgr_find_user(text) to authenticated;
