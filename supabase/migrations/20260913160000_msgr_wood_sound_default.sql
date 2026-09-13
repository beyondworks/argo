-- New devices default to wood knock; existing preferences are not rewritten.
alter table public.msgr_push_tokens alter column sound set default 'wood-knock';

create or replace function public.msgr_push_register(platform text, token text, device text default '', sound text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'msgr_unauthorized'; end if;
  if msgr_push_register.platform not in ('ios', 'android') or msgr_push_register.token is null
     or length(msgr_push_register.token) < 16 or length(msgr_push_register.token) > 4096 then raise exception 'msgr_bad_push_token'; end if;
  insert into public.msgr_push_tokens(token, user_id, platform, device, sound)
    values (msgr_push_register.token, auth.uid(), msgr_push_register.platform, coalesce(left(msgr_push_register.device, 80), ''),
            coalesce(nullif(regexp_replace(msgr_push_register.sound, '[^a-z0-9-]', '', 'g'), ''), 'wood-knock'))
  on conflict on constraint msgr_push_tokens_pkey do update
    set user_id = excluded.user_id, platform = excluded.platform, device = excluded.device, sound = case
      when public.msgr_push_tokens.user_id = auth.uid()
        and nullif(regexp_replace(msgr_push_register.sound, '[^a-z0-9-]', '', 'g'), '') is null
      then public.msgr_push_tokens.sound else excluded.sound end, updated_at = now();
end $$;
revoke all on function public.msgr_push_register(text, text, text, text) from public;
grant execute on function public.msgr_push_register(text, text, text, text) to authenticated;
