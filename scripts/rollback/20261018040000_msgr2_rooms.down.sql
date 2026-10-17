-- 되돌림: supabase/migrations/20261018040000_msgr2_rooms.sql(U6d — 방·공간·초대·안 읽음·검색·1:1 목록·방 설정·신고, 옛 표 접점)을 걷어 낸다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U6d → U2b → U2 → U3 → U1.
-- 멈추는 조건(아무것도 바꾸지 않는다): 초대 행이 있다 · 옛 표(신고·일지)에 v2 글·방을 가리키는 행(옛 표에는 없고 v2 표에 있는 값)이 있다 —
--   그 행은 기억 데이터라 지우지 않는다(CLAUDE.md DB 위생 1). 처리 방법을 정한 뒤 다시 돌린다.
-- 옛 FK는 원래 이름·규칙에 NOT VALID로 복원한다 — 옛 앱이 채널·글을 지워 생긴 고아 행(어느 표에도 없는 값)이 있어도 멈추지 않고, 기존 행은 검사·수정하지 않는다.
-- 남는 것: v2 RPC로 만든 공간·방·멤버 행(U1 표)과 같은 id의 옛 조직 행(msgr_orgs·주인 멤버·요금 행) — 정상 행이라 지우지 않는다. storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018040000_msgr2_rooms.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $g$ declare n bigint; t record; begin
  if to_regclass('public.msgr2_space_invites') is not null then
    select count(*) into n from public.msgr2_space_invites;
    if n > 0 then raise exception 'msgr2_rollback_not_empty: msgr2_space_invites has % rows', n; end if;
  end if;
  for t in select * from (values
      ('msgr_reports', 'message_id', 'msgr_messages'), ('msgr_reports', 'channel_id', 'msgr_channels'),
      ('msgr_journal_entries', 'source_msg_id', 'msgr_messages'), ('msgr_journal_entries', 'channel_id', 'msgr_channels')) v(tbl, col, old_t) loop
    if to_regclass('public.' || t.tbl) is null or to_regclass('public.' || t.old_t) is null then continue; end if;
    execute format('select count(*) from public.%I x where x.%I is not null and not exists (select 1 from public.%I o where o.id = x.%I) and exists (select 1 from public.%I v where v.id = x.%I)',
                   t.tbl, t.col, t.old_t, t.col, case t.old_t when 'msgr_messages' then 'msgr2_messages' else 'msgr2_rooms' end, t.col) into n;
    if n > 0 then raise exception 'msgr2_rollback_not_empty: %.% has % rows pointing at v2', t.tbl, t.col, n; end if;
  end loop;
end $g$;

-- 읽음 행: U1의 사람 직접 쓰기로 되돌림
drop trigger if exists msgr2_reads_stamp on public.msgr2_reads;
drop function if exists public.msgr2_reads_stamp();
drop policy if exists msgr2_reads_select on public.msgr2_reads;
drop policy if exists msgr2_reads_own on public.msgr2_reads;
create policy msgr2_reads_own on public.msgr2_reads for all to authenticated
  using (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read))
  with check (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read));
grant insert, update on public.msgr2_reads to authenticated;

-- 옛 FK 복원(원래 이름·규칙: 20260921090000·20260927150000·20260903120000)
do $f$ begin
  if to_regclass('public.msgr_messages') is not null then drop trigger if exists msgr2_ref_old_deleted on public.msgr_messages; end if;
  if to_regclass('public.msgr_channels') is not null then drop trigger if exists msgr2_ref_old_deleted on public.msgr_channels; end if;
  if to_regclass('public.msgr_reports') is not null then
    drop trigger if exists msgr2_ref_message_id on public.msgr_reports;
    drop trigger if exists msgr2_ref_channel_id on public.msgr_reports;
    if not exists (select 1 from pg_constraint where conname = 'msgr_reports_message_id_fkey') then
      alter table public.msgr_reports add constraint msgr_reports_message_id_fkey foreign key (message_id) references public.msgr_messages(id) on delete set null not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'msgr_reports_channel_id_fkey') then
      alter table public.msgr_reports add constraint msgr_reports_channel_id_fkey foreign key (channel_id) references public.msgr_channels(id) on delete set null not valid;
    end if;
  end if;
  if to_regclass('public.msgr_journal_entries') is not null then
    drop trigger if exists msgr2_ref_source_msg_id on public.msgr_journal_entries;
    drop trigger if exists msgr2_ref_channel_id on public.msgr_journal_entries;
    if not exists (select 1 from pg_constraint where conname = 'msgr_journal_entries_channel_id_fkey') then
      alter table public.msgr_journal_entries add constraint msgr_journal_entries_channel_id_fkey foreign key (channel_id) references public.msgr_channels(id) on delete cascade not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'msgr_journal_entries_source_msg_id_fkey') then
      alter table public.msgr_journal_entries add constraint msgr_journal_entries_source_msg_id_fkey foreign key (source_msg_id) references public.msgr_messages(id) on delete set null not valid;
    end if;
  end if;
  if to_regclass('public.msgr_orgs') is not null then drop trigger if exists msgr2_org_delete_guard on public.msgr_orgs; end if;
end $f$;

-- _msgr2_access_for를 U2 본문으로(20261018000000 그대로)
create or replace function public._msgr2_access_for(p_room uuid, p_uid uuid) returns public.msgr2_access_t
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := p_uid;
  r public.msgr2_rooms;
  s public.msgr2_spaces;
  v_role text;
  in_room boolean;
  rd boolean; adm boolean; t text;
  res public.msgr2_access_t := row(false, false, false, false, false, null)::public.msgr2_access_t;
begin
  if uid is null or p_room is null then return res; end if;
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
revoke all on function public._msgr2_access_for(uuid, uuid) from public, anon, authenticated;

-- 옛 중단 장치 본문 복원(20261016170000 그대로)
do $do$ begin
  if to_regprocedure('public.msgr_pause_guard()') is not null then
    execute $p$
create or replace function public.msgr_pause_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public._msgr_paused() then return new; end if;
  r := to_jsonb(new); -- 표마다 열이 달라 new.<열>을 직접 읽지 않는다(PL/pgSQL은 and 앞이 거짓이어도 뒤 식의 열을 찾는다)
  if tg_table_name = 'msgr_messages' and r->>'kind' = 'system' and coalesce(current_setting('msgr.pause_notice', true), '') = '1' then return new; end if;
  if tg_table_name = 'msgr_friends' and r->>'status' = 'blocked' then return new; end if; -- 차단은 안전 기능(msgr_friend_remove)
  -- 문구·코드는 이미 배포된 쪽이 아는 모양에 맞췄다(PR 표): 42501 = 메신저 글 보내기 카드 "이 방에 보낼 수 없습니다"(다시 시도 없음)·본체 큐 영구 오류(재시도 없음),
  -- 첫 토큰 msgr_forbidden = 엣지 msgr-bot ERR의 403(모르는 이름이면 500 → Hermes outbox 재시도, msgr-bot-err-contract), 'row-level security' = 토스트·초대 창 "권한이 없습니다".
  -- 'messenger service paused'로 새 앱은 가려 읽을 수 있다. 'read-only'는 넣지 않는다("읽기 전용(계정 상태)"로 오해).
  raise exception 'msgr_forbidden (new row violates row-level security policy, messenger service paused)' using errcode = '42501';
end $$;
$p$;
    revoke all on function public.msgr_pause_guard() from public, anon, authenticated;
  end if;
end $do$;

drop function if exists
  public.msgr2_space_create(text, text), public.msgr2_space_leave(uuid), public.msgr2_space_member_remove(uuid, uuid),
  public.msgr2_invite_create(uuid, text, uuid, uuid[], integer, integer, integer), public.msgr2_invite_preview(text), public.msgr2_invite_accept(text),
  public.msgr2_invite_decline(text), public.msgr2_invite_revoke(uuid), public.msgr2_invites_list(uuid), public.msgr2_my_invites(),
  public.msgr2_room_create(uuid, text, text, uuid[], uuid[]), public.msgr2_dm_open(uuid, uuid), public.msgr2_agent_dm_open(uuid),
  public.msgr2_room_members_add(uuid, uuid[], uuid[]), public.msgr2_room_member_remove(uuid, text, uuid), public.msgr2_room_leave(uuid), public.msgr2_room_join(uuid),
  public.msgr2_rooms_browse(uuid, boolean), public.msgr2_unread(uuid), public.msgr2_mark_read(uuid, bigint), public.msgr2_room_pref_set(uuid, boolean, boolean),
  public.msgr2_dm_list(boolean), public.msgr2_search(text, integer), public.msgr2_report_message(bigint, text), public.msgr2_reports_list(), public.msgr2_report_resolve(uuid),
  public._msgr2_invite_state(public.msgr2_space_invites),
  public._msgr2_need_app(), public._msgr2_need_device(), public._msgr2_need_live(), public._msgr2_live(), public._msgr2_team_role(uuid, uuid),
  public._msgr2_blocked(uuid, uuid), public._msgr2_friends(uuid, uuid), public._msgr2_friend_ids(uuid), public._msgr2_my_blocked(uuid), public._msgr2_label(uuid),
  public._msgr2_room_put(uuid, text, uuid, uuid), public._msgr2_room_add_agent(uuid, uuid, uuid), public._msgr2_room_drop_agents_of(uuid, uuid),
  public._msgr2_space_drop(uuid, uuid), public._msgr2_space_close(uuid, uuid), public._msgr2_blocked_among(uuid[], uuid[]),
  public._msgr2_room_put_new(uuid, uuid, uuid), public._msgr2_org_delete_guard(), public._msgr2_pause_pass(text, jsonb), public._msgr2_mirror_org(uuid, text, uuid),
  public._msgr2_ref_check(), public._msgr2_ref_old_deleted(), public._msgr2_report_operator(uuid);
drop table if exists public.msgr2_space_invites;
drop index if exists public.msgr2_rooms_pair_personal;
notify pgrst, 'reload schema';
commit;
