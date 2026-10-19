-- 동기화 '새 시작' 서버 스위치(2026-10-19, #1110 엄격 검수 H1 — 총괄 결정). 기본 꺼짐.
-- 새 시작 = 클라우드 사본이 정리된 뒤 다시 Pro가 된 계정에서, 옛 기록(.sync-state)을 비우고 로컬 기준으로 다시 올리는 것(src/sync.mjs 새 시작 주석).
-- 옛 앱(epoch를 모르는 0.1.113 이하)이 같은 계정에 남아 있으면, 새로 쓴 매니페스트에 없는 자기 파일을 '다른 기기가 지움'으로 읽어 지울 수 있다.
-- 최소 앱 버전 판정은 기기가 파일로 기억하고 서버 확인은 뒤에서 돌아, 잠들었다 깬 옛 앱의 첫 사이클을 막지 못한다 — 그래서 새 시작 개시를 최소 버전과 떼어
-- 이 스위치 하나로만 연다. 꺼져 있으면(행 없음 — 기본) 앱은 종전처럼 보류한다. 합치기(epoch가 다른 매니페스트를 보면 기록을 비우고 삭제 0)는 스위치와 무관하다.
-- 켜는 순서(PR #1110 본문): 0.1.114 발행 → #1107 폐기 범위를 0.1.113 이하로 넓혀 옛 앱 refresh token 폐기 → access token 수명(1시간) 경과 → 최소 버전 올림
--   → edge_logs X-Client-Info로 0.1.113 이하 접속 0 확인 → 켬.
--   켜기:  insert into public.msgr_settings (key, value) values ('sync_fresh_start', 'on') on conflict (key) do update set value = excluded.value;
--   끄기:  delete from public.msgr_settings where key = 'sync_fresh_start';
-- 부하: 앱은 '매니페스트 없음 + 기록 있음'인 회사를 만났을 때만 묻는다(5분 캐시) — 정상 동기화에서는 호출 0. 읽기만(쓰기 0).
-- msgr_settings는 정책 없는 표(비밀값 행이 함께 있다)라 정해진 키 하나만 돌려주는 정의자 함수로 연다(argo_min_app_version과 같은 방식).
-- 적용: bash scripts/msgr-live-apply.sh 20261019140000_sync_fresh_start_switch   되돌리기: drop function public.argo_sync_fresh_start();(앱은 함수가 없으면 꺼짐으로 본다)
create or replace function public.argo_sync_fresh_start() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select s.value = 'on' from public.msgr_settings s where s.key = 'sync_fresh_start'), false)
$$;
revoke all on function public.argo_sync_fresh_start() from public, anon;
grant execute on function public.argo_sync_fresh_start() to authenticated, service_role;
