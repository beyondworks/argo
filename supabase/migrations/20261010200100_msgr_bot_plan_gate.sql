-- 무료 계정 외부 봇(Hermes·OpenClaw) 수신 중지(2026-10-10 유건 지시: "Pro 결제 안 하면 클라우드 사용 못하게").
-- 엣지 msgr-bot getUpdates가 요청당 1회 부른다. 읽기만(쓰기 0).
-- 판정: 봇 크루 주인의 public.is_pro_for — 사람 에이전트 중지(20261010200000)와 같은 기준.
--   'plan_required' = 엣지가 롱폴 시간(최대 25초)만큼 DB 조회 없이 기다렸다가 403. 연결 도구는 403을 1→30초 사다리로 다시 온다
--   (401은 연결 도구가 '영구 중지·토큰 회전'으로 읽으므로 쓰지 않는다).
--   열린 중지 기록(msgr_crew_pauses, resumed_at null)이 있으면 Pro가 된 뒤라도 sweep이 재개(커서를 지금 끝으로)할 때까지 막는다 —
--   재개 전에 받게 하면 멈춘 동안 쌓인 글을 한꺼번에 받는다. 결제는 entitlements 트리거가 바로 재개하고, 조직 좌석은 10분 크론 안.
-- 스위치: msgr_settings bot_plan_gate = 'off'면 항상 'ok'(행이 없으면 켜짐).
-- 되돌리기: insert into public.msgr_settings(key,value) values('bot_plan_gate','off') on conflict (key) do update set value='off';
--           또는 drop function public.msgr_bot_gate(text) (엣지는 판정 실패를 '막지 않음'으로 본다).
create or replace function public.msgr_bot_gate(token text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; uid uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if coalesce((select value from public.msgr_settings where key = 'bot_plan_gate'), 'on') = 'off' then return 'ok'; end if;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' then return 'ok'; end if; -- 전체 끄기(20261010200000 머리 주석)
  select c.owner_user_id into uid from public.msgr_crews c where c.id = b.crew_id;
  if uid is null then return 'ok'; end if; -- 주인을 모르면 막지 않는다
  if exists (select 1 from public.msgr_crew_pauses k where k.crew_id = b.crew_id and k.resumed_at is null) then return 'plan_required'; end if;
  if public.is_pro_for(uid) then return 'ok'; end if;
  return 'plan_required';
end $$;
revoke all on function public.msgr_bot_gate(text) from public;
grant execute on function public.msgr_bot_gate(text) to anon, authenticated;
notify pgrst, 'reload schema';
