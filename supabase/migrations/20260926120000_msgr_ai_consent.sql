-- App Store 5.1.2(2025-11 신설, 제3자 AI 공개·동의) 대응, 2026-09-26.
-- 사용자의 메시지가 크루(AI 에이전트)에게 가서 크루 주인이 정한 제3자 AI 제공자로 전송되기 전에, 계정당 한 번 명시적
-- 동의를 받는다. 저장은 msgr_profiles에 열 하나(ai_consent_at) — 새 표를 만들지 않는다. 클라이언트는 전송 전에 동의
-- 창을 띄우고(입력한 초안은 유지, 거부해도 사람끼리 대화는 그대로), 게이트웨이(src/gateway/msgr.mjs drain)도 동의 없는
-- 사람의 메시지는 크루 턴으로 넘기지 않는다(클라이언트 창만 믿지 않음) — msgr_instruct_check는 건드리지 않고
-- (수백 개의 기존 pg 테스트가 그 함수의 'ok'를 전제한다) 별도의 msgr_ai_consent_ok를 새로 두어 드레인이 함께 확인한다.
alter table public.msgr_profiles add column if not exists ai_consent_at timestamptz;

create or replace function public.msgr_set_ai_consent(consent boolean) returns timestamptz
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); at timestamptz;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  at := case when consent then now() else null end;
  insert into public.msgr_profiles (user_id, ai_consent_at) values (me, at)
    on conflict (user_id) do update set ai_consent_at = at;
  return at;
end $$;

create or replace function public.msgr_my_ai_consent() returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
    select ai_consent_at from public.msgr_profiles where user_id = auth.uid()
$$;

-- 게이트웨이(호스트 브리지)가 임의 사용자의 동의 여부를 확인한다 — msgr_profiles는 본인만 select할 수 있어(RLS) definer가 필요하다.
-- 존재 여부만 돌려준다(다른 필드 없음 — 동의 시각 자체는 본인만 msgr_my_ai_consent로 본다).
create or replace function public.msgr_ai_consent_ok(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_profiles where user_id = p_user and ai_consent_at is not null)
$$;

revoke all on function public.msgr_set_ai_consent(boolean) from public, anon; grant execute on function public.msgr_set_ai_consent(boolean) to authenticated;
revoke all on function public.msgr_my_ai_consent() from public, anon; grant execute on function public.msgr_my_ai_consent() to authenticated;
revoke all on function public.msgr_ai_consent_ok(uuid) from public, anon; grant execute on function public.msgr_ai_consent_ok(uuid) to authenticated;
