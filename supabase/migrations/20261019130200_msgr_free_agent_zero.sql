-- 무료 계정 메신저 에이전트 0명(유건 2026-10-19 12:56 KST "무료 사용자는 … 사용은 전적으로 로컬에서 하도록 해야해. 텔레그램을 연결하든 뭘 하든.").
-- 20261011120000(무료도 새 앱이면 4명)의 숫자 4를 설정 키 free_agent_limit(0~4, 없거나 형식이 틀리면 0)로 바꾼다. 최소 버전·창은 그대로.
-- 결과: 기존 관문 msgr_crews_pro_gate가 무료 계정의 새 연결을 거절하고(msgr_free_agent_limit msgr_pro_required — 이미 앱이 아는 코드),
--   10분 sweep msgr_crews_plan_sweep이 연결된 무료 에이전트를 멈춘다(status paused — 채널·기억·데이터 보존, #941 경로). msgr_free_keep은 고를 수 있는 수가 0이라 거절한다.
--   봇(hosting='bot')은 이미 Pro 전용(msgr_bot_gate). 사람이 메신저 앱에서 쓰는 경로는 지금 전체 중단(msgr_paused, 20261016170000)이라 손대지 않는다 —
--   메신저 재설계(messenger-v2)에서 Pro 전용으로 만든다.
-- 함께: 20261019130000(companies 무료 쓰기 차단·Pro 5GB). 본체 앱은 무료면 메신저 연결을 시작하지 않는다(앱 PR).
-- 부하: 판정 함수가 설정 PK를 한 번 더 읽는다(이미 free_agent_min_app을 읽는 같은 표). 쓰기 변화 없음. sweep이 무료 에이전트를 멈추는 첫 10분에만 바뀐 행 쓰기.
-- 적용: bash scripts/msgr-live-apply.sh 20261019130200_msgr_free_agent_zero
-- 되돌리기(데이터 무관): insert into public.msgr_settings(key, value) values ('free_agent_limit', '4') on conflict (key) do update set value = excluded.value;
--   (다음 sweep에서 #945 규칙대로 최근 대화 순 4명이 재개된다)
-- 메신저 표가 없는 DB(셀프호스트·메신저 마이그레이션을 안 태운 시험)는 건너뛴다.
do $do$
begin
  if to_regclass('public.msgr_settings') is null or to_regprocedure('public._msgr_app_ver(text)') is null then return; end if;
  execute $sql$
create or replace function public._msgr_free_agent_policy(out min_app text, out agent_limit int, out window_s int)
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.value from public.msgr_settings s where s.key = 'free_agent_min_app' and public._msgr_app_ver(s.value) is not null), '0.1.102'),
         coalesce((select s.value::int from public.msgr_settings s where s.key = 'free_agent_limit' and s.value ~ '^[0-4]$'), 0), -- 무료 = 0명(2026-10-19)
         1800   -- 새 앱 심박 창 30분(20261011120000 머리말)
$$
  $sql$;
  execute 'revoke all on function public._msgr_free_agent_policy() from public, anon, authenticated';
end $do$;
