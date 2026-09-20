create or replace function public.msgr_bot_rename(bot uuid, new_name text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; nm text := btrim(coalesce(new_name, ''));
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then
    raise exception 'msgr_admin_only';
  end if;
  if public.msgr_org_locked(b.org_id) then raise exception 'msgr_org_locked'; end if;
  if b.revoked_at is not null then raise exception 'msgr_bot_revoked'; end if;
  if nm = '' or nm ~ '[\n\r]' or char_length(nm) > 80 then
    raise exception 'msgr_bot_name' using detail = 'bot name must be a single line of at most 80 characters';
  end if;

  update public.msgr_bots set name = nm where id = b.id;
  update public.msgr_crews set display_name = nm where id = b.crew_id;
  perform public.msgr_audit(b.org_id, 'bot.rename', 'bot', b.id::text, jsonb_build_object('name', nm, 'crew', b.crew_id));
end $$;

revoke all on function public.msgr_bot_rename(uuid, text) from public;
grant execute on function public.msgr_bot_rename(uuid, text) to authenticated;
