create or replace function public.msgr_bot_set_role(bot_crew uuid, new_role_text text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; rt text := btrim(coalesce(new_role_text, ''));
begin
  select * into b from public.msgr_bots where crew_id = bot_crew and revoked_at is null;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then
    raise exception 'msgr_admin_only';
  end if;
  if public.msgr_org_locked(b.org_id) then raise exception 'msgr_org_locked'; end if;
  if rt = '' or rt ~ '[\n\r]' or char_length(rt) > 60 then
    raise exception 'msgr_bot_role' using detail = 'bot role must be a single line of at most 60 characters';
  end if;

  perform set_config('msgr.bot_role', '1', true);
  update public.msgr_crews set role_text = rt where id = b.crew_id;
  perform public.msgr_audit(b.org_id, 'bot.role', 'bot', b.id::text, jsonb_build_object('role_text', rt, 'crew', b.crew_id));
end $$;

revoke all on function public.msgr_bot_set_role(uuid, text) from public;
grant execute on function public.msgr_bot_set_role(uuid, text) to authenticated;

create or replace function public.msgr_bot_role_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role_text is distinct from old.role_text
    and exists (select 1 from public.msgr_bots where crew_id = new.id and revoked_at is null) then
    if public.msgr_org_locked(new.org_id) then raise exception 'msgr_org_locked'; end if;
    if current_setting('msgr.bot_role', true) is distinct from '1' then
      raise exception 'msgr_bot_role_managed';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists msgr_bot_role_gate on public.msgr_crews;
create trigger msgr_bot_role_gate
  before update on public.msgr_crews
  for each row execute function public.msgr_bot_role_gate();
