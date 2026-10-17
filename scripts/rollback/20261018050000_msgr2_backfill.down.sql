-- 되돌림: supabase/migrations/20261018050000_msgr2_backfill.sql(U8 — 이전 함수·작업 행)을 걷어 낸다. msgr2_on_user_message는 U2 본문으로 되돌린다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 새 표의 데이터는 건드리지 않는다 — 백필 사본을 비우는 것은 scripts/msgr2-migrate-rollback.sql이 먼저 한다.
-- 백필이 한 번이라도 돈 기록(작업 행의 runs > 0)이 있으면 멈춘다(사본 비우기·검증 기록을 먼저 정리하라는 뜻 — 기록 보존).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018050000_msgr2_backfill.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $g$ declare n bigint; begin
  if to_regclass('public.msgr2_backfill_jobs') is not null then
    execute 'select count(*) from public.msgr2_backfill_jobs where runs > 0 or done_at is not null' into n;
    if n > 0 then raise exception 'msgr2_rollback_not_empty: msgr2_backfill_jobs has % started jobs (먼저 bash scripts/msgr2-migrate.sh rollback)', n; end if;
  end if;
end $g$;
drop function if exists public.msgr2_backfill_run(text, int, text), public.msgr2_backfill_restart(), public.msgr2_backfill_verify(int),
  public._msgr2_bf_agents(text, int), public._msgr2_bf_spaces(text, int), public._msgr2_bf_space_members(text, int), public._msgr2_bf_seats(text, int),
  public._msgr2_bf_rooms(text, int), public._msgr2_bf_room_members(text, int), public._msgr2_bf_message_keys(text, int), public._msgr2_bf_messages(text, int), public._msgr2_bf_attachments(text, int),
  public._msgr2_bf_reads(text, int), public._msgr2_bf_reactions(text, int), public._msgr2_bf_prefs(text, int), public._msgr2_bf_target_prefs(text, int),
  public._msgr2_bf_approvals(text, int), public._msgr2_bf_identity(text, int),
  public._msgr2_bf_room_members_src(), public._msgr2_bf_target_pin(uuid, uuid), public._msgr2_bf_room_shape(uuid),
  public._msgr2_bf_uuid(text), public._msgr2_bf_begin();
drop table if exists public.msgr2_backfill_jobs, public.msgr2_backfill_cmid_dups;
-- U2 본문으로 되돌림(20261018000000_msgr2_work.sql에서 그대로 옮김 — 시험이 적용 전 본문과 같은지 본다)
create or replace function public.msgr2_on_user_message() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[];
begin
  if new.author_kind <> 'user' then return null; end if;
  update public.msgr2_room_counters set agent_streak = 0, streak_noted = false where room_id = new.room_id and (agent_streak <> 0 or streak_noted);
  if cardinality(new.mentions) > 0 then
    select array_agg(distinct m.member_id) into targets from public.msgr2_room_members m
      where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id = any (new.mentions);
  elsif (select count(*) from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'user' and m.removed_at is null and m.member_id <> new.author_user_id) = 0
        and (select count(*) from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null) = 1 then
    select array_agg(m.member_id) into targets from public.msgr2_room_members m where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null;
  end if;
  foreach ag in array coalesce(targets, '{}') loop
    perform public._msgr2_make_offer(new.room_id, new.topic_id, ag, 'user', new.author_user_id, new.author_user_id, new.body, new.id, null, 0);
  end loop;
  return null;
end $$;
commit;
