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
--   · 무료 ①: 이 기기(p_device)가 아닌 내 기기의 기기 심박 행이 보존 기간(7일 — 20261010120000 purge-msgr-device-beats 크론) 안에 있으면 true.
--     D5가 노리는 것은 기기가 정말 1대뿐인 사용자다. 지난 7일 안에 다른 기기가 있었던 사용자는 종전 160초 양보(그 기기가 160초 안에 돌아와 답할 수 있다 — 재검수 B1).
--     회사(ws)는 가리지 않는다 — 다른 회사의 기기도 '있음'(덜 줄이는 쪽).
--   · 무료 ②(옛 앱 흔적, 재검수 B2): 기기 심박을 쓰지 않는 옛 앱·CLI(행마다 last_seen_at PATCH)가 러너로 답하고 있으면 기기 행이 없다. 내 사람 에이전트의 연결된 행
--     last_seen_at이 90초(부재 기준) 안인데 이 기기(p_device)의 그 회사 기기 심박 seen_at과 2초 넘게 다르면 다른 쓰는 쪽이 있다 → true.
--     근거: 새 앱의 옛 읽기 호환 쓰기는 msgr_device_beat 한 호출(같은 트랜잭션)에서 기기 행 seen_at = now()와 함께 last_seen_at = now()라 이 기기가 쓴 행은 seen_at과 같다
--     (20261011120000 3). 같은 기기라도 기기 행은 그대로(35초 안)인데 행만 써지는 순간(막 재개된 행 등)은 '있음'으로 보여 종전 양보가 된다(덜 줄이는 쪽 — 다음 심박에서 맞춰진다).
--     남는 경우: 옛 쪽이 쓴 뒤 이 기기가 같은 행을 마지막으로 다시 쓴 몇 초(옛 쪽은 30초 넘으면 15초 틱에 다시 쓴다)는 흔적이 같은 시각으로 덮인다.
-- 쓰기 0(시험 txid none). 로그인 본인 행만(auth.uid()), 익명은 부를 수 없다.
-- 적용: bash scripts/msgr-live-apply.sh 20261015200000_msgr_runner_peer_alive
-- 되돌리기: drop function public.msgr_runner_peer_alive(text); — 앱은 함수가 없으면 종전 160초 양보로 돌아간다(데이터 변경 없음).

create or replace function public.msgr_runner_peer_alive(p_device text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then return true; end if;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' or to_regprocedure('public.is_pro_for(uuid)') is null or public.is_pro_for(me) then return true; end if;
  return exists (select 1 from public.msgr_device_beats d
                  where d.owner_user_id = me and d.device_id is distinct from p_device and d.seen_at > now() - interval '7 days')
      or exists (select 1 from public.msgr_crews c
                  where c.owner_user_id = me and c.hosting <> 'bot' and c.status = 'active' and c.last_seen_at > now() - interval '90 seconds'
                    and not exists (select 1 from public.msgr_device_beats m
                                     where m.owner_user_id = me and m.ws_id = c.ws_id and m.device_id = p_device
                                       and c.last_seen_at between m.seen_at - interval '2 seconds' and m.seen_at + interval '2 seconds'));
end $$;
revoke all on function public.msgr_runner_peer_alive(text) from public, anon;
grant execute on function public.msgr_runner_peer_alive(text) to authenticated;

notify pgrst, 'reload schema';
