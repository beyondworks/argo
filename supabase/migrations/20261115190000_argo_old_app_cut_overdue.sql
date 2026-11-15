-- 옛 앱 사용 중지 장치가 "의심 표시 → 35분"까지 가 놓고도 끊지 못하던 결함을 고친다(2026-11-15).
-- 유건 원문: "로그인 풀어버리고 안내 뜨게 해줘."(2026-11-04), "해결들해"(2026-11-15 18:22 KST 슬랙, 페퍼 경유).
-- 실측(운영 2026-11-15, 페퍼 읽기 조회): 세션 56336202(옛 서명 'supabase-js/2.110.2; runtime=node', 외부 사용자 fd386447)가 04:11Z에 표시되고
--   due 04:46Z가 지났는데 cut_at이 비어 있었다. 그 세션은 08:18Z까지 토큰을 갱신하며 msgr_messages·msgr_channel_members·_device-lease.json을
--   1시간 2천여 건씩 불렀다(edge 1시간 2.1만 건, 평소 5,304건의 4.1배).
-- 원인: 폐기는 argo_old_app_check(요청 전 함수) 안에서 "기한이 지난 뒤 같은 세션이 POST를 한 번 더 보낼 때"만 일어난다. 그 함수는 POST가 아니면
--   바로 돌아가고, 옛 판의 조회(GET)·Storage 리스·토큰 갱신(GoTrue)은 PostgREST POST가 아니다. 표시 뒤 POST가 끊긴 옛 판은 영원히 남는다.
--   하루 1번 cron(purge-argo-app-sessions)은 기록 정리만 하고 세션을 끊지 않는다.
-- 바꾸는 것: 기한이 지났는데 아직 안 끊긴 표시를 5분마다 끊는 함수와 cron 하나를 더한다. argo_old_app_check·관문 함수·표·등록은 바꾸지 않는다.
-- 끊는 조건(모두 참일 때만):
--   · 스위치가 켜져 있다(msgr_settings 'old_app_cutoff' = 'on'). 꺼져 있으면 아무것도 하지 않는다(스위치 하나로 이 cron까지 멈춘다).
--   · 표시가 있고(argo_old_app_sessions), cut_at이 비어 있고, due_at이 지났다.
--   · 그 세션이 아직 있고, 기한 뒤에 쓰였다(auth.sessions의 updated_at·refreshed_at 중 늦은 쪽 > due_at). 기한 뒤로 아무도 안 쓴 세션은 끊지 않는다
--     — 옛 판이 꺼졌으면 끊을 이유가 없고, 같은 세션을 쓰는 새 판이 잠들어 있을 때 깨우자마자 끊기는 일을 줄인다.
-- 새 판 보호: 표시는 꼬리 없는 옛 서명 POST에만 붙는다(0.1.114부터 본체의 모든 요청에 ' argo/<버전>' 꼬리, src/supabase-client.mjs).
--   새 판은 30분마다(실패 5분 뒤) 꼬리 있는 관문(argo_min_app_version)을 부르고, 그 호출이 cut_at 없는 표시를 지운다 — 기한(35분)이 지난 표시는 그동안
--   꼬리 있는 관문이 한 번도 없었다는 뜻이다. 남는 경우(경우 표, PR 본문): 새 판과 옛 판이 같은 세션을 쓰고 새 판이 35분 넘게 잠들었다 깨어
--   토큰을 갱신한 뒤 관문을 부르기 전 5분 안에 cron이 돌면 새 판도 한 번 로그아웃된다. 이 경우는 종전 함수도 옛 판의 다음 POST에서 똑같이 끊는다.
-- 부하: cron 5분마다 = 분당 0.2회 실행. 쉴 때는 표시 표(수천 행 이하, 아래 부분 색인)만 읽고 쓰기 0. 끊을 때만 표시 1행 갱신 + auth.sessions 1행 삭제.
-- 되돌림: scripts/rollback/20261115190000_argo_old_app_cut_overdue.down.sql(cron 해제 + 함수 삭제). 이미 끊긴 세션은 되살아나지 않는다(다시 로그인하면 된다).

-- 쉴 때 읽기를 작게: 아직 안 끊긴 표시만 담는 부분 색인(관문이 지우거나 cut_at이 차면 빠진다).
create index if not exists argo_old_app_sessions_open_due on public.argo_old_app_sessions (due_at) where cut_at is null;

create or replace function public.argo_old_app_cut_overdue() returns int
  language plpgsql volatile security definer set search_path = public, pg_temp set lock_timeout = '2s' as $$
declare n int := 0; r record;
begin
  if not exists (select 1 from public.msgr_settings where key = 'old_app_cutoff' and value = 'on') then return 0; end if;
  for r in
    select o.session_id
      from public.argo_old_app_sessions o
      join auth.sessions s on s.id = o.session_id
     where o.cut_at is null
       and o.due_at <= now()
       and greatest(s.updated_at, s.refreshed_at at time zone 'UTC') > o.due_at
     order by o.due_at
     limit 200
  loop
    update public.argo_old_app_sessions set cut_at = now() where session_id = r.session_id and cut_at is null;
    delete from auth.sessions where id = r.session_id; -- GoTrue 로그아웃과 같다: refresh가 "Refresh Token Not Found"로 거절된다(refresh_tokens는 FK로 함께)
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.argo_old_app_cut_overdue() from public, anon, authenticated;
grant execute on function public.argo_old_app_cut_overdue() to service_role;

-- 5분마다(같은 이름이면 갱신이라 다시 적용해도 하나다). 실행 기록(cron.job_run_details, 하루 288행)은 기존 purge-cron-run-details(7일, 20260923220000)가 지운다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('argo-old-app-cut-overdue', '*/5 * * * *', $c$ select public.argo_old_app_cut_overdue(); $c$);
  end if;
end $$;
