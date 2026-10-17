-- 되돌림: supabase/migrations/20261018000000_msgr2_work.sql(U2 — 일·약속 서버)를 걷어 낸다. U1이 정의한 msgr2_access·msgr2_lock_cols는 U1 본문으로 되돌린다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U2b → U2 → U3 → U1. 앞 단위가 남아 있으면 그 단위를 먼저 되돌린다.
-- 빈 표만 지운다 — 행이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(기억 데이터·기록 보존, CLAUDE.md DB 위생 1). storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018000000_msgr2_work.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $g$ declare t text; n bigint; begin
  foreach t in array array['msgr2_work_events', 'msgr2_approvals', 'msgr2_effects', 'msgr2_work_files', 'msgr2_agent_leases', 'msgr2_room_counters', 'msgr2_works'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'msgr2_rollback_not_empty: % has % rows', t, n; end if;
    end if;
  end loop;
end $g$;
do $g$ declare n bigint; begin
  if to_regclass('public.msgr2_messages') is not null and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'msgr2_messages' and column_name = 'work_id') then
    execute 'select count(*) from public.msgr2_messages where work_id is not null or cardinality(mentions) > 0' into n;
    if n > 0 then raise exception 'msgr2_rollback_not_empty: msgr2_messages has % rows using mentions/work_id', n; end if;
  end if;
end $g$;
drop trigger if exists msgr2_on_user_message on public.msgr2_messages;
drop trigger if exists msgr2_pause_guard on public.msgr2_messages;
drop table if exists public.msgr2_work_events, public.msgr2_approvals, public.msgr2_effects, public.msgr2_work_files, public.msgr2_agent_leases, public.msgr2_room_counters, public.msgr2_works;
alter table public.msgr2_messages drop constraint if exists msgr2_messages_mentions_max;
alter table public.msgr2_messages drop column if exists mentions, drop column if exists work_id;
-- U1 본문으로 되돌림(20261017151000_msgr2_space.sql에서 그대로 옮김 — 시험이 적용 전 본문과 같은지 본다)
create or replace function public.msgr2_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if;
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then raise exception 'msgr2_immutable_%', col using errcode = '42501'; end if;
  end loop;
  return new;
end $$;
create or replace function public.msgr2_access(p_room uuid) returns public.msgr2_access_t
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid();
  r public.msgr2_rooms;
  s public.msgr2_spaces;
  v_role text;
  in_room boolean;
  rd boolean; adm boolean; t text;
  res public.msgr2_access_t := row(false, false, false, false, false, null)::public.msgr2_access_t;
begin
  if uid is null or p_room is null or not public._msgr2_device_ok() then return res; end if;
  select * into r from public.msgr2_rooms where id = p_room;
  if not found then return res; end if;
  select * into s from public.msgr2_spaces where id = r.space_id;
  if not found or s.deleted_at is not null then return res; end if;
  in_room := exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id = uid and m.removed_at is null);
  if s.kind = 'team' then
    select m.role into v_role from public.msgr2_space_members m
      where m.space_id = s.id and m.user_id = uid and m.removed_at is null and (m.expires_at is null or m.expires_at > now());
    if v_role is null then return res; end if;
    rd := (r.kind = 'open' and v_role in ('owner', 'admin', 'member')) or in_room;
    adm := v_role in ('owner', 'admin');
  else
    rd := in_room;
    adm := s.owner_user_id = uid;
  end if;
  if not rd then return res; end if;
  -- 방의 사람: 활동 중인 사람 방 멤버(팀은 활동 중인 공간 멤버인 사람만) + 팀 open 방이면 owner·admin·member 전원
  with humans as (
    select m.member_id as u from public.msgr2_room_members m
      where m.room_id = r.id and m.member_kind = 'user' and m.removed_at is null
        and (s.kind = 'personal' or exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = m.member_id and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())))
    union
    select sm.user_id from public.msgr2_space_members sm
      where s.kind = 'team' and r.kind = 'open' and sm.space_id = s.id and sm.role in ('owner', 'admin', 'member') and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())
  )
  select case
    when not exists (select 1 from humans h where h.u <> s.owner_user_id) then 'owner'
    when s.kind = 'team' and not exists (select 1 from humans h join public.msgr2_space_members sm on sm.space_id = s.id and sm.user_id = h.u where sm.role = 'guest') then 'team'
    else 'guest' end into t;
  res.read := true;
  res.write := r.archived_at is null;
  res.invite := r.kind <> 'direct' and r.archived_at is null and (case when s.kind = 'team' then v_role in ('owner', 'admin', 'member') else adm end);
  res.manage := r.kind <> 'direct' and adm;
  res.decide := adm;
  res.tier := t;
  return res;
end $$;
do $d$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array['_msgr2_access_for', '_msgr2_attachments_of', '_msgr2_bump_streak', '_msgr2_effective_state', '_msgr2_env_check', '_msgr2_j_code', '_msgr2_j_int', '_msgr2_j_num', '_msgr2_j_opt', '_msgr2_j_str', '_msgr2_j_ts', '_msgr2_j_uuid', '_msgr2_make_offer', '_msgr2_my_device', '_msgr2_next_state', '_msgr2_norm_error', '_msgr2_paused', '_msgr2_peers', '_msgr2_rej', '_msgr2_send_w', '_msgr2_server_event', '_msgr2_setting', '_msgr2_setting_int', '_msgr2_system_msg', '_msgr2_tier_allows', 'msgr2_approval_decide', 'msgr2_attachment_add', 'msgr2_catch_up', 'msgr2_link_pending', 'msgr2_link_send', 'msgr2_link_upload_slot', 'msgr2_on_user_message', 'msgr2_pause_guard', 'msgr2_service_pause', 'msgr2_topic_resolve', 'msgr2_work_cancel', 'msgr2_work_status', '_msgr2_next_state']) loop
    execute format('drop function %s', f);
  end loop;
end $d$;
notify pgrst, 'reload schema';
commit;
