-- 무료 조직도 크루에게 일을 맡길 수 있다(2026-10-01 유건 승인 — 9/30 요금 개편 "무료는 조직·개인 구분 없음, 나머지 기능 동일").
-- 경위: 20260926115000이 조직마다 30일 무료 기간(trial_ends_at)을 두고, 끝나면 결제 없는 조직의 크루 턴을 막았다(게이트웨이 1차 +
--   msgr_message_entitlement_gate 트리거 2차 + 봇 경로 msgr_bot_updates_before_work·1b 결재/재개 + 자동화 발송). 9/30 개편으로 무료 기간 개념이
--   없어졌는데 게이트는 남아, 라이브 기준 free 조직 21곳이 2026-10-27 10:26 KST부터 차례로 크루 작업이 멈출 예정이었다(16곳이 그 시각).
-- 처방: 모든 경로가 부르는 단일 관문 msgr_org_entitled만 바꾼다 — 멤버(또는 auth.uid() 없는 서비스·내부 경로)면 항상 true.
--   게이트 장치(트리거·봇 경로·자동화의 unentitled 분기)는 그대로 두되 더 이상 false를 받지 않는다. 결제 한도는 무료 한도(방 인원 등) 쪽 판정이 맡는다.
--   비회원 authenticated는 종전처럼 null(2026-09-27 L3 — 다른 조직의 상태를 엿보지 못하게).
-- trial_ends_at·paid_until 열과 msgr_org_trial_active·msgr_extend_trial·msgr_org_entitlement_marker는 지우지 않는다(옛 앱이 읽는다, 되돌리기 쉽게).
-- DB 위생: 쓰기·주기 호출 없음. 함수 정의 하나만 바뀐다.
create or replace function public.msgr_org_entitled(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when auth.uid() is not null and not public.msgr_is_member(org) then null -- L3: 비회원 authenticated는 값을 못 받는다
      else true
      end
$$;
-- 권한은 create or replace가 기존 그대로 유지한다(원 정의에 별도 grant 없음).
