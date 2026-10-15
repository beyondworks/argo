-- 러너 없는 기기가 메신저 글을 넘겨받을 다른 기기가 있는지 묻는 읽기 함수 — 앱↔메신저 연결 감사 D5(2026-10-15, 총괄 배정).
-- 재현(artifacts/msgr-link-audit/audit.md 1-8): 러너가 없는 앱은 메신저 글을 160초(YIELD_GRACE_MS) 양보한다(러너 있는 다른 기기가 실행권을 먼저 잡게 — 10/7 사고).
--   기기가 하나뿐이어도 같아서 첫 멘션의 실패 안내까지 2분 40초가 걸렸다.
-- 앱은 양보하려는 그 글에서만 한 번 부른다(src/gateway/msgr.mjs peerVerdict — 글당 1회, 주기 호출 0). false면 양보하지 않고 바로 처리(실패 안내),
--   true·오류·이 함수가 없는 서버(적용 전)면 종전 160초 양보.
-- 판정:
--   · 무료 판정이 아닌 모든 경우(Pro·운영자 부여·좌석·체험, 관문 꺼짐 msgr.pro_gate=off, 요금제 함수 없는 DB)는 늘 true — 종전 160초 그대로.
--     기기 심박(msgr_device_beats)을 쓰지 않는 옛 앱(≤0.1.99)은 에이전트 행 last_seen_at만 고쳐 서버가 그 기기를 셀 수 없다. 무료 계정은 그 옛 앱의 에이전트가
--     이미 멈춰 있어(20261011120000 — 무료는 최신 앱 기기 심박이 있어야 active) 답할 수 없지만, Pro는 답한다 → Pro는 판정하지 않는다(총괄 결정 10/15).
--     무료 판정은 msgr_my_agent_pause와 같은 식(pro_gate·is_pro_for) — 두 곳이 갈라지지 않게.
--   · 무료: 이 기기(p_device)가 아닌 내 기기의 기기 심박이 창(_msgr_free_agent_policy().window_s = 30분) 안이면 true. 창은 무료 정책이 '새 앱이 켜져 있다'고
--     보는 기준과 같다(재시작·업데이트 설치·짧은 잠자기로 끊기지 않는 길이 — 20261011120000 머리말). 부재 기준 90초를 쓰면 다른 기기가 업데이트·재시작으로 90초 넘게
--     심박이 없다가 양보 기한(160초) 안에 돌아오는 경우 배포본(그 기기가 답함)보다 나빠졌다(게이트 B). 30분 넘게 심박이 없던 기기가 160초 안에 돌아오는 경우만 남는다.
--     회사(ws)는 가리지 않는다 — 다른 회사의 기기도 '있음'(덜 줄이는 쪽).
-- 쓰기 0(시험 txid none). 로그인 본인 행만(auth.uid()), 익명은 부를 수 없다.
-- 적용: bash scripts/msgr-live-apply.sh 20261015200000_msgr_runner_peer_alive
-- 되돌리기: drop function public.msgr_runner_peer_alive(text); — 앱은 함수가 없으면 종전 160초 양보로 돌아간다(데이터 변경 없음).

create or replace function public.msgr_runner_peer_alive(p_device text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then return true; end if;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' or to_regprocedure('public.is_pro_for(uuid)') is null or public.is_pro_for(me) then return true; end if;
  return exists (select 1 from public.msgr_device_beats d, public._msgr_free_agent_policy() p
                  where d.owner_user_id = me and d.device_id is distinct from p_device and d.seen_at > now() - make_interval(secs => p.window_s));
end $$;
revoke all on function public.msgr_runner_peer_alive(text) from public, anon;
grant execute on function public.msgr_runner_peer_alive(text) to authenticated;

notify pgrst, 'reload schema';
