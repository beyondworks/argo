-- 알림 소리 선택(유건 2026-09-12) — 기기 토큰마다 고른 소리 이름을 두고, 엣지가 APNs sound(<이름>.caf)로 보낸다. 앱 번들에 같은 이름의 .caf가 있어야 한다.
alter table public.msgr_push_tokens add column if not exists sound text not null default 'seatbelt-single';

drop function if exists public.msgr_push_register(text, text, text); -- PostgREST 오버로드 모호성 방지 — 4인자 하나로
create or replace function public.msgr_push_register(platform text, token text, device text default '', sound text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'msgr_unauthorized'; end if;
  if msgr_push_register.platform not in ('ios', 'android') or msgr_push_register.token is null
     or length(msgr_push_register.token) < 16 or length(msgr_push_register.token) > 4096 then raise exception 'msgr_bad_push_token'; end if;
  insert into public.msgr_push_tokens(token, user_id, platform, device, sound)
    values (msgr_push_register.token, auth.uid(), msgr_push_register.platform, coalesce(left(msgr_push_register.device, 80), ''),
            coalesce(nullif(regexp_replace(msgr_push_register.sound, '[^a-z0-9-]', '', 'g'), ''), 'seatbelt-single'))
  on conflict on constraint msgr_push_tokens_pkey do update
    set user_id = excluded.user_id, platform = excluded.platform, device = excluded.device, sound = excluded.sound, updated_at = now();
end $$;
revoke all on function public.msgr_push_register(text, text, text, text) from public;
grant execute on function public.msgr_push_register(text, text, text, text) to authenticated;
