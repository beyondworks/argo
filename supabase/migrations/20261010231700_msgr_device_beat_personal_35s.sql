-- 기기 심박(20261010120000)의 옛 읽기 호환에서 개인 행(org NULL) 기한 50초 → 35초(조직 행과 같게). 이 한 줄만 바꾼다 — 나머지는 운영 정의(2026-10-10 pg_get_functiondef로 읽어 저장소와 같음을 확인) 그대로.
-- 이유(#943 검수 LOW-1): 게이트웨이가 쉬는 동안 심박을 15초마다가 아니라 약 45초마다(40~55초) 보낸다(src/gateway/msgr.mjs BEAT_EVERY_MS).
--   50초 기한이면 45초 심박의 절반이 기한 안이라 개인 행이 약 90초마다 써지고, 개인 행을 표에서 직접 읽는 메신저(0.1.48 이상, 받아 온 때의 나이로 판정)의 부재중 90초와 여유가 0이 된다.
--   35초 기한이면 심박마다 써져 최대 나이 약 55초(조직 행과 같다).
-- 부하: 개인 행 쓰기는 심박 한 번당 최대 1번 — 종전(15초 틱·50초 기한, 약 60초마다)보다 조금 잦다(약 45초마다). 기기 행·조직 행은 그대로.
-- 적용: scripts/msgr-live-apply.sh 20261010231700_msgr_device_beat_personal_35s (함수 정의만 바꾼다 — 표·데이터 변경 없음)
create or replace function public.msgr_device_beat(p_ws text, p_device text, p_crews uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); s text[];
begin
  if me is null then raise exception 'msgr_device_beat_forbidden' using errcode = '42501'; end if;
  if p_ws is null or p_ws !~ '^[a-z0-9][a-z0-9-]{0,127}$' or p_device is null or length(p_device) not between 1 and 200
     or coalesce(cardinality(p_crews), 0) > 2000 then raise exception 'msgr_device_beat_invalid' using errcode = '22023'; end if; -- 회사 id 규칙 = workspace.mjs WS_ID_RE
  -- 이 기기가 맡은 에이전트 = 받은 행 중 내 행·이 회사 행의 slug(남의 에이전트·다른 회사를 '접속'으로 만들 수 없다)
  select coalesce(array_agg(distinct c.slug order by c.slug), '{}') into s
    from public.msgr_crews c where c.id = any(coalesce(p_crews, '{}')) and c.owner_user_id = me and c.ws_id = p_ws;
  update public.msgr_device_beats d set slugs = s, seen_at = now()
   where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device
     and (d.slugs is distinct from s or d.seen_at < now() - interval '35 seconds');
  if not found and s <> '{}' and not exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device) then
    -- 새 (회사, 기기) — 주인당 50행 상한: 가장 오래 안 뛴 것부터 비운다(넣을 때만 — 쉬는 틱은 여기 오지 않는다)
    delete from public.msgr_device_beats d where d.owner_user_id = me and (d.ws_id, d.device_id) in (
      select o.ws_id, o.device_id from public.msgr_device_beats o where o.owner_user_id = me order by o.seen_at desc offset 49);
    insert into public.msgr_device_beats (owner_user_id, ws_id, device_id, slugs) values (me, p_ws, p_device, s) on conflict do nothing;
  end if;
  -- 옛 읽기 호환(머리말) — 기한이 지난 행만
  update public.msgr_crews c set last_seen_at = now()
   where c.id = any(p_crews) and c.owner_user_id = me and c.ws_id = p_ws
     and (c.last_seen_at is null or c.last_seen_at < now() - case when c.org_id is null then interval '35 seconds' else interval '35 seconds' end);
  -- 업무 기능 표시 — msgr_work_heartbeat와 같은 일(조직 행만, 같은 값은 쓰지 않는다). 따로 보내던 요청을 여기로 합쳤다.
  update public.msgr_crews set work_protocol = 1
   where id = any(p_crews) and owner_user_id = me and ws_id = p_ws and org_id is not null and status = 'active' and work_protocol is distinct from 1;
end $$;
revoke all on function public.msgr_device_beat(text, text, uuid[]) from public, anon;
grant execute on function public.msgr_device_beat(text, text, uuid[]) to authenticated;
