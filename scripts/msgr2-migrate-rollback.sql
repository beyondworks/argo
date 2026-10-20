-- 메신저 v2 이전(U8) 스위치 전 되돌림 — 백필로 생긴 msgr2_* 행을 비우고 작업 행을 처음 상태로 돌린다(설계 6절 2·3단계 "되돌림" 칸).
-- 옛 msgr_* 표는 손대지 않는다(백필이 읽기만 했으므로 되돌릴 것이 없다). 기기 행(msgr2_devices·msgr2_user_gen)은 백필 대상이 아니라 그대로 둔다.
-- 지우는 것은 "옛 데이터의 사본"뿐이다. v2에서 새로 생긴 행(옛 짝이 없는 글·방·일·에이전트·팀 공간)이 하나라도 있거나 스위치 뒤면 아무것도 바꾸지 않고 멈춘다
-- (그때부터 v2 행은 기억 데이터다 — CLAUDE.md DB 위생 1).
-- 실행: bash scripts/msgr2-migrate.sh rollback   (또는 psql "<접속>" -v ON_ERROR_STOP=1 -f scripts/msgr2-migrate-rollback.sql — 파일 안의 begin/commit, -1 없이)
begin;
set local lock_timeout = '5s';
do $g$
declare n bigint;
begin
  if exists (select 1 from public.msgr_settings where key in ('msgr2_switched_at', 'msgr2_enabled')) then
    raise exception 'msgr2_rollback_after_switch: 스위치 뒤에는 비우지 않는다(v2 중단 스위치 + 앞으로 고치기)'; end if;
  select count(*) into n from public.msgr2_messages v where not exists (select 1 from public.msgr_messages o where o.id = v.id);
  if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_messages % rows (옛 글에 없는 id)', n; end if;
  select count(*) into n from public.msgr2_rooms r where not exists (select 1 from public.msgr_channels c where c.id = r.id);
  if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_rooms % rows', n; end if;
  select count(*) into n from public.msgr2_works w where not exists (select 1 from public.msgr_crew_approvals a where a.id = w.id);
  if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_works % rows', n; end if;
  select count(*) into n from public.msgr2_agents v where not exists (select 1 from public.msgr_agents a where a.id = v.id);
  if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_agents % rows', n; end if;
  select count(*) into n from public.msgr2_spaces s where s.kind = 'team' and not exists (select 1 from public.msgr_orgs o where o.id = s.id);
  if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_spaces(team) % rows', n; end if;
  select (select count(*) from public.msgr2_topics) + (select count(*) from public.msgr2_work_events) + (select count(*) from public.msgr2_effects)
       + (select count(*) from public.msgr2_work_files) + (select count(*) from public.msgr2_agent_leases) into n;
  if n > 0 then raise exception 'msgr2_rollback_native_rows: 토픽·일 기록·효과·일 파일·리스 % rows', n; end if;
  if to_regclass('public.msgr2_push_sent') is not null then
    execute 'select count(*) from public.msgr2_push_sent' into n;
    if n > 0 then raise exception 'msgr2_rollback_native_rows: msgr2_push_sent % rows', n; end if;
  end if;
end $g$;
-- 백필 사본만 남은 것을 확인했다 — 자식 표부터
delete from public.msgr2_approvals;
delete from public.msgr2_room_counters;
delete from public.msgr2_works;
delete from public.msgr2_reactions;
delete from public.msgr2_reads;
delete from public.msgr2_prefs;
delete from public.msgr2_attachments;
delete from public.msgr2_messages; -- rule-ok: 스위치 전 백필 사본 비우기(설계 D14·6절 되돌림, 옛 짝 없는 행이 있으면 위에서 멈춘다)
delete from public.msgr2_room_members;
delete from public.msgr2_rooms;
delete from public.msgr2_agent_seats;
delete from public.msgr2_space_members;
delete from public.msgr2_spaces;
delete from public.msgr2_agents;
delete from public.msgr2_backfill_cmid_dups; -- 백필 도우미 표
update public.msgr2_backfill_jobs set generation = generation + 1, checkpoint = null, done_at = null, verified_at = null, runs = 0, rows_written = 0,
       claimed_by = null, claimed_at = null, updated_at = now();
commit;
