-- 되돌림: supabase/migrations/20261017151000_msgr2_space.sql(U1 — 공간·방·에이전트·판정)를 걷어 낸다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U2b → U2 → U3 → U1. 앞 단위가 남아 있으면 그 단위를 먼저 되돌린다.
-- 빈 표만 지운다 — 행이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(기억 데이터·기록 보존, CLAUDE.md DB 위생 1). storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261017151000_msgr2_space.down.sql   (파일 안의 begin/commit — -1 없이)
-- pgcrypto 확장은 남긴다(다른 기능도 쓴다).
begin;
set local lock_timeout = '5s';
do $g$ declare t text; n bigint; begin
  foreach t in array array['msgr2_reactions', 'msgr2_reads', 'msgr2_prefs', 'msgr2_attachments', 'msgr2_messages', 'msgr2_topics', 'msgr2_agent_seats', 'msgr2_room_members', 'msgr2_agents', 'msgr2_rooms', 'msgr2_space_members', 'msgr2_spaces'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'msgr2_rollback_not_empty: % has % rows', t, n; end if;
    end if;
  end loop;
end $g$;
drop table if exists public.msgr2_reactions, public.msgr2_reads, public.msgr2_prefs, public.msgr2_attachments, public.msgr2_messages, public.msgr2_topics, public.msgr2_agent_seats, public.msgr2_room_members, public.msgr2_agents, public.msgr2_rooms, public.msgr2_space_members, public.msgr2_spaces; -- 위 검사로 빈 표만(기억 데이터 없음)
do $d$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array['_msgr2_agent_visible', '_msgr2_device_app', '_msgr2_device_ok', '_msgr2_msg_in_room', '_msgr2_space_visible', 'msgr2_access', 'msgr2_agent_sync', 'msgr2_insert_stamp', 'msgr2_lock_cols', 'msgr2_my_personal_space', 'msgr2_same_room', 'msgr2_seat_team_only', 'msgr2_set_member_role', 'msgr2_set_room_agent_policy', 'msgr2_set_seat']) loop
    execute format('drop function %s', f);
  end loop;
end $d$;
drop type if exists public.msgr2_access_t;
notify pgrst, 'reload schema';
commit;
