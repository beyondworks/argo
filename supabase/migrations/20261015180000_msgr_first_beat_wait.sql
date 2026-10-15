-- 첫 연결 직후 최신 앱에 "최신 버전으로 업데이트"를 보이던 이유 판정 — 앱↔메신저 연결 감사 D3(2026-10-15, 총괄 배정).
-- 재현(artifacts/msgr-link-audit/audit.md 1-6): 무료 계정이 0.1.109 데스크톱으로 처음 연결하면 미러가 에이전트 행을 넣지만(관문이 paused로), 첫 기기 심박 전이라
--   msgr_device_beats가 비어 있다. msgr_my_agent_pause(20261011120000)는 새 앱 심박 행이 하나도 없으면 이유를 'app'(옛 버전)으로 정해
--   데스크톱 카드·메신저가 업데이트를 요구했다(첫 심박까지 약 2분 — 브리지 쪽은 src/gateway/msgr.mjs 같은 PR에서 고친다).
-- 바꾼 것: 새 앱 심박 행이 없을 때 'app'과 'off'를 가르는 기준 하나만.
--   · 옛 앱 신호가 있으면 'app' 그대로 — 이 주인의 기기 심박 행이 있다(버전 없음·최소 버전 미만 = 0.1.100~0.1.101 또는 낮은 개발 빌드),
--     또는 이 주인의 사람 에이전트 행이 모두 10분 넘게 전에 생겼다(0.1.99 이하는 기기 심박을 보내지 않는다 — 오래 쓰던 옛 앱).
--   · 그 밖(기기 심박 행이 없고 사람 에이전트 행이 10분 안에 생김) = 앱이 행을 막 만들고 아직 첫 심박 전 → 'off'.
--   'off'를 고른 이유(새 이유 'wait'가 아니라): 설치된 본체(≤0.1.110)·메신저가 'off'를 이미 'app'과 같은 갈래로 읽는다 — 본체 연결 경로는 app/off면
--   이 기기 심박을 바로 한 번 보내고(route.js beatNow), 카드 문구·오류 코드가 같다. 새 이유를 두면 옛 본체가 그 즉시 심박을 건너뛰어 첫 연결이 오히려 늦어진다.
--   10분: 최신 앱은 행을 넣은 틱에 심박한다(이 PR의 브리지 수정 — 옛 서버여도 15초 안). 10분은 그 여유 + 자동 켜기 조회 주기(MSGR_AUTO_ENABLE_PROBE_MS 10분)와 같다.
--   그동안 옛 앱(0.1.99 이하)의 첫 연결은 업데이트 안내 대신 '앱 꺼짐' 안내가 최대 10분 보인다(경우 표 3b — 받아들이는 차이).
-- 부하: 읽기 함수 그대로(주기 호출 없음 — 메신저 로그인·재연결·에이전트 탭, 본체 카드는 멈춘 행이 있을 때만). 새앱 심박 행이 없을 때만 기기 행·에이전트 행 존재 조회 2번
--   (주인당 기기 행 50행 상한, 에이전트 행은 주인 색인). 쓰기 0(시험 [D3 첫 연결] txid none).
-- 적용: bash scripts/msgr-live-apply.sh 20261015180000_msgr_first_beat_wait
-- 되돌리기: 20261011120000_msgr_free_new_app_agents.sql의 6) msgr_my_agent_pause 정의를 다시 적용한다(데이터 변경 없음).

create or replace function public.msgr_my_agent_pause() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); n_act int; n_paused int; pol record; why text;
begin
  if me is null then return null; end if;
  select * into pol from public._msgr_free_agent_policy();
  with ids as (
    select c.ws_id, c.slug, bool_or(c.status = 'active') a, bool_or(c.status = 'paused') p
      from public.msgr_crews c where c.owner_user_id = me and c.hosting <> 'bot' and c.status in ('active', 'paused') group by 1, 2
  ) select count(*) filter (where a), count(*) filter (where p and not a) into n_act, n_paused from ids;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' or to_regprocedure('public.is_pro_for(uuid)') is null or public.is_pro_for(me) then why := null;
  elsif not public._msgr_free_app_ok(me) then
    why := case
      when exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me
                     and public._msgr_app_ver(d.app_version) >= public._msgr_app_ver(pol.min_app)) then 'off'   -- 새 앱이 있었지만 30분 넘게 꺼짐(종전)
      when exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me) then 'app'               -- 옛 앱 심박(버전 없음·최소 미만)(종전)
      when exists (select 1 from public.msgr_crews c where c.owner_user_id = me and c.hosting <> 'bot'
                     and c.created_at > now() - interval '10 minutes') then 'off'                                -- 행을 막 만든 앱의 첫 심박 전(D3)
      else 'app' end;                                                                                              -- 기기 심박 없이 오래된 행 = 0.1.99 이하(종전)
  elsif n_act >= pol.agent_limit then why := 'limit';
  elsif n_paused > 0 then why := 'room';
  end if;
  return jsonb_build_object('paused', n_paused, 'active', n_act, 'limit', pol.agent_limit, 'reason', why, 'min_app', pol.min_app);
end $$;
revoke all on function public.msgr_my_agent_pause() from public, anon;
grant execute on function public.msgr_my_agent_pause() to authenticated;

notify pgrst, 'reload schema';
