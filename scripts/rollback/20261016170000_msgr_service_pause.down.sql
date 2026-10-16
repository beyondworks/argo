-- 되돌림: supabase/migrations/20261016170000_msgr_service_pause.sql 전체를 적용 전 상태로(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 스위치(msgr_settings 'msgr_paused')를 끄는 것은 이 파일이 아니라 행 삭제다. 이 파일은 마이그레이션이 만든 함수·트리거·감싸개를 걷어 낸다.
-- 먼저 되돌릴 것: 20261016171000_msgr_pause_push.down.sql(공지 푸시 함수 — 이 파일과 독립이지만 같은 PR).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261016170000_msgr_service_pause.down.sql   (한 트랜잭션은 파일 안의 begin/commit — -1을 같이 주지 않는다)
-- 시험: test/msgr-service-pause-rollback-pg.test.mjs — 적용 → 되돌림 뒤 pg_proc(본문·권한·설정)·트리거가 적용 전과 같다.
-- 공지 글(kind='system', meta.msgr_pause)과 스위치 행은 지우지 않는다(기억 데이터·운영 기록).
begin;
set local lock_timeout = '5s';

-- 1) 감싸개 4개 drop → core를 원래 이름으로
drop function if exists public.msgr_crew_inbox(text, uuid, bigint, integer);
drop function if exists public.msgr_crew_inbox_many(text, jsonb, integer);
drop function if exists public.msgr_bot_updates(text, bigint, integer);
drop function if exists public.msgr_device_beat(text, text, uuid[], text);
alter function public._msgr_crew_inbox_core(text, uuid, bigint, integer) rename to msgr_crew_inbox;
alter function public._msgr_crew_inbox_many_core(text, jsonb, integer) rename to msgr_crew_inbox_many;
alter function public._msgr_bot_updates_core(text, bigint, integer) rename to msgr_bot_updates;
alter function public._msgr_device_beat_core(text, text, uuid[], text) rename to msgr_device_beat;

-- 2) 원래 권한 — 마이그레이션이 core에서 거둔 public·anon·authenticated 중 원래 있던 것만 돌려준다(service_role은 마이그레이션이 건드리지 않았다)
revoke all on function public.msgr_crew_inbox(text, uuid, bigint, integer) from public, anon;            -- 20260913122421
grant execute on function public.msgr_crew_inbox(text, uuid, bigint, integer) to authenticated;
revoke all on function public.msgr_crew_inbox_many(text, jsonb, integer) from public, anon;              -- 20261009140000
grant execute on function public.msgr_crew_inbox_many(text, jsonb, integer) to authenticated;
revoke all on function public.msgr_bot_updates(text, bigint, integer) from public;                       -- 20261001140000
grant execute on function public.msgr_bot_updates(text, bigint, integer) to anon, authenticated;
revoke all on function public.msgr_device_beat(text, text, uuid[], text) from public, anon;              -- 20261011120000
grant execute on function public.msgr_device_beat(text, text, uuid[], text) to authenticated;

-- 3) 쓰기 거부 트리거 15개(있는 표만) → 가드·판정·상태·공지 함수
do $$
declare t text;
begin
  foreach t in array array['msgr_messages', 'msgr_channels', 'msgr_channel_members', 'msgr_invites', 'msgr_invite_uses', 'msgr_org_members', 'msgr_orgs',
                           'msgr_friends', 'msgr_channel_crew_requests', 'msgr_crew_requests', 'msgr_executions', 'msgr_automations', 'msgr_automation_runs',
                           'msgr_crew_routine_edits', 'msgr_org_announcements', 'msgr_attachments'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists a0_msgr_pause_guard on public.%I', t);
  end loop;
end $$;
drop function if exists public.msgr_pause_guard();
drop function if exists public.msgr_service_pause();
drop function if exists public.msgr_pause_announce(text, text);

-- 4) 자동화 디스패치 — base(20260913110000) 본문 그대로(create or replace라 권한은 바뀌지 않는다)
create or replace function public.msgr_automation_dispatch_due(p_ws text) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select public.msgr_automation_dispatch_internal(p_ws,false)
$$;
create or replace function public.msgr_automation_dispatch_cloud() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  result := public.msgr_automation_dispatch_internal(null,true);
  insert into public.msgr_automation_scheduler(id,last_tick_at) values(true,now()) on conflict(id) do update set last_tick_at = excluded.last_tick_at;
  return result;
end $$;

-- 판정 함수는 마지막에(위 함수들이 더는 부르지 않는다)
drop function if exists public._msgr_paused();

notify pgrst, 'reload schema';
commit;
