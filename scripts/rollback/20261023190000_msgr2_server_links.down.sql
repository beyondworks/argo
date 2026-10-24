-- 되돌림: supabase/migrations/20261023190000_msgr2_server_links.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: ① 이 기능으로 만든 VPS 봇 에이전트를 먼저 연결 해제와 같은 방법으로 닫는다(retired·방 멤버·자리·열린 일) — 표를 지운 뒤 active로 남으면
--   이름만 남은 고아 에이전트가 된다(2026-10-23 고아 45개와 같은 모양). ② 함수·표 msgr2_server_links·msgr2_bots를 지운다(링크 흔적·토큰 해시뿐, 기억 데이터 없음).
--   ③ _msgr2_runner_has를 20261020201400 본문으로 되돌린다(VPS 봇 일은 다시 만들어지지 않는다).
-- 남기는 것: 봇이 쓴 글(msgr2_messages)·일 기록(msgr2_works)·retired 에이전트 행(글의 글쓴이). 서버 쪽 Hermes는 다음 폴링에서 401을 받고 멈춘다
--   (엣지 함수도 되돌리면 중단 응답 — 401).
-- 순서: 엣지 함수 msgr-bot을 먼저 되돌린 뒤(중단판 — v2 토큰도 401) 이 파일을 실행한다. 반대로 하면 v2 엣지가 없는 함수를 불러 500이 되고 Hermes가 계속 재시도한다
--   (v2.js는 함수 없음(PGRST202)을 401로 바꿔 이 경우도 멈추게 하지만 순서를 지킨다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261023190000_msgr2_server_links.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $$ declare x uuid; begin
  if to_regclass('public.msgr2_bots') is not null and to_regprocedure('public._msgr2_bot_retire(uuid)') is not null then
    for x in select distinct agent_id from public.msgr2_bots loop perform public._msgr2_bot_retire(x); end loop;
  end if;
end $$;
drop function if exists public.msgr2_bot_send(text, uuid, text);
drop function if exists public.msgr2_bot_finish(text, uuid, text);
drop function if exists public.msgr2_bot_updates(text, bigint, int);
drop function if exists public.msgr2_bot_me(text);
drop function if exists public._msgr2_bot_auth(text);
drop function if exists public.msgr2_bot_revoke(uuid);
drop function if exists public.msgr2_bots_mine();
drop function if exists public.msgr2_server_link_done(text, jsonb);
drop function if exists public.msgr2_server_link_status(text);
drop function if exists public.msgr2_server_link_approve(uuid, jsonb, uuid[]);
drop function if exists public.msgr2_server_link_get(uuid);
drop function if exists public.msgr2_server_link_report(text, text, jsonb);
drop function if exists public._msgr2_server_link_by_code(text);
drop function if exists public.msgr2_server_link_create();
drop function if exists public._msgr2_bot_retire(uuid);
-- 20261020201400 본문
create or replace function public._msgr2_runner_has(p_owner uuid, p_feature text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr2_devices d
                  where d.user_id = p_owner and d.kind in ('runner', 'resident') and d.revoked_at is null and d.expires_at > now()
                    and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0)
                    and p_feature = any (d.features)) $$;
revoke all on function public._msgr2_runner_has(uuid, text) from public, anon, authenticated;
drop index if exists public.msgr2_works_bot_open;
drop table if exists public.msgr2_bots;
drop table if exists public.msgr2_server_links;
drop function if exists public._msgr2_hash(text);
commit;
