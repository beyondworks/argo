-- msgr_push_register 결함 수정 — 라이브 실측 2026-09-12 15:49: iPhone이 토큰을 받아 RPC를 불렀지만 400.
-- 가장 호출로 재현: PL/pgSQL 매개변수 `token`이 표의 열 `token`과 겹쳐 "column reference token is ambiguous"(42702).
-- 매개변수 이름은 PostgREST 호출 계약(platform·token·device)이라 그대로 두고, 함수 안에서 함수명으로 한정하고 충돌 대상은 제약 이름으로 쓴다.
create or replace function public.msgr_push_register(platform text, token text, device text default '') returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'msgr_unauthorized'; end if;
  if msgr_push_register.platform not in ('ios', 'android') or msgr_push_register.token is null
     or length(msgr_push_register.token) < 16 or length(msgr_push_register.token) > 4096 then raise exception 'msgr_bad_push_token'; end if;
  insert into public.msgr_push_tokens(token, user_id, platform, device)
    values (msgr_push_register.token, auth.uid(), msgr_push_register.platform, coalesce(left(msgr_push_register.device, 80), ''))
  on conflict on constraint msgr_push_tokens_pkey do update
    set user_id = excluded.user_id, platform = excluded.platform, device = excluded.device, updated_at = now();
end $$;
