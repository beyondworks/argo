-- 메신저 v2 U6d — 기존 셸 화면이 쓰는 방·공간·초대·안 읽음·검색·1:1 목록·방 설정·신고의 서버 쪽(화면 없음).
-- 설계 정본: AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md 1절(공간 모델·RLS 원칙 1~7), 4절(부하), 5절, 10절.
-- 의존: U1(*_msgr2_space.sql), U3(*_msgr2_device.sql), U2(*_msgr2_work.sql — _msgr2_setting·_msgr2_paused·_msgr2_access_for),
--       U2b(*_msgr2_realtime_storage.sql — _msgr2_send_u). 병합된 앞 파일은 고치지 않는다(필요한 함수는 여기서 새로 둔다).
-- 원칙
--   · 판정은 msgr2_access(방) 하나(1-5 원칙 1). 방 단위 허락(읽기·쓰기·초대·관리)은 모두 이 함수 결과로 정한다.
--     공간 단위 일(공간 만들기·초대·내보내기)은 방이 없어 역할 하나(_msgr2_team_role)로 본다 — msgr2_set_member_role(U1)과 같은 식이다.
--   · 멤버십·권한 표를 쓰는 RPC(공간 만들기·초대 만들기/받기/거절/취소·공간 나가기/내보내기·방 만들기·방 멤버 넣기/빼기·방 나가기·참여·1:1 열기)는
--     첫 줄에서 _msgr2_need_app()으로 앱 기기를 확인한다(D9 — 에이전트 셸이 쥘 수 있는 runner·resident 세션은 42501).
--     읽기·내 설정(안 읽음·검색·목록·읽음 표시·알림 설정·신고)은 유효한 기기(_msgr2_device_ok)만 본다.
--   · 사람이 표에 직접 넣는 정책은 새로 두지 않는다. 새 초대 표(msgr2_space_invites)는 정책 없음 = RPC로만.
--   · 팀 공간의 private·direct 방은 활동 중인 공간 멤버이면서 방 멤버(1-5 원칙 2) — 넣을 수 있는 사람도 활동 중인 공간 멤버뿐이다.
--     개인 공간 방(친구 방)에는 수락한 친구만 넣고, 차단(어느 쪽이든)이면 넣지 않는다. 1:1(direct)은 두 사람 짝당 하나다.
--     pair_key: 팀 = msgr_pair_key와 같은 '<작은 uuid>:<큰 uuid>'(공간마다 유일, U1 인덱스), 개인 = 'p:' || 같은 모양(모든 개인 공간을 통틀어 유일, 아래 인덱스).
--     U8 이전은 옛 personal_pair 앞에 'p:'를 붙여 넣는다.
--   · 중단 스위치(msgr2_paused)가 켜져 있으면 늘리는 쓰기(만들기·초대·받기·넣기·참여·1:1 열기)는 service_paused, 읽기 목록(안 읽음·검색·1:1 목록)은 빈 결과.
--     줄이는 쓰기(나가기·빼기·취소·거절)와 내 설정·읽음 표시·신고는 중단 중에도 된다(안전 기능).
--   · 유휴 쓰기 0: 같은 값이면 쓰지 않는다(이미 멤버·이미 읽음·같은 설정·이미 있는 1:1). 주기 호출을 새로 만들지 않는다.
--   · 지우는 SQL 없음. 나가기·빼기는 removed_at, 초대 취소는 revoked_at.
-- 옛 표와의 접점(총괄 지시 2026-10-18, PR 본문 "옛 표" 절)
--   ① 친구·차단(msgr_friends·msgr_user_blocks·msgr_profiles)은 그대로 쓰는 옛 표다. 읽기만 한다 — 옛 중단 장치(a0_msgr_pause_guard)는 BEFORE INSERT만 막아 읽기는 된다.
--   ② 옛 중단 장치가 막는 쓰기 중 v2가 필요한 것 두 가지만 통과시킨다(msgr_pause_guard에 한 줄, 판정은 _msgr2_pause_pass 한 곳):
--      · msgr_friends INSERT(친구 요청·친구 링크 수락) — v2 운영 표지(msgr_settings 'msgr2_enabled') 있음 + v2 중단 꺼짐 + 요청한 세션이 v2 앱 기기일 때만. 옛 앱 세션은 기기 행이 없어 계속 막힌다.
--      · msgr_orgs·msgr_org_members INSERT — msgr2_space_create가 같은 id의 옛 조직 행(요금·문서 FK, 설계 1-2)을 만드는 그 트랜잭션 안에서만(트랜잭션 설정 msgr2.org_mirror = 그 id).
--        사용자는 PostgREST로 set_config를 부를 수 없다(옛 msgr.pause_notice와 같은 근거).
--   ③ 옛 표의 FK 네 개(신고 message_id·channel_id, 일지 source_msg_id·channel_id)는 v2 글·방을 넣을 수 없게 한다 → 같은 열을
--      "옛 표나 v2 표 중 하나에 있으면 된다" 트리거 검사(_msgr2_ref_check, 23503)로 바꾼다. 기존 행은 건드리지 않는다.
--      옛 FK의 on delete set null(신고·일지 출처)은 옛 표 삭제 트리거로 그대로 이어 간다(같은 id가 v2에 있으면 끊지 않는다).
--      on delete cascade(일지의 channel_id)는 잇지 않는다 — 옛 채널을 지워도 그 채널의 일지(기억 데이터)는 남는다(지우는 쪽 → 남기는 쪽).
--      조직 문서 channel_id FK는 그대로 둔다 — 옛 본체 문서 미러(src/gateway/msgr.mjs docsByIds)가 이 FK로 msgr_channels를 끼워 읽고, v2 방 문서는
--      옛 문서 트리거(msgr_doc_before_write)·문서 RLS도 함께 바꿔야 해서 문서 단위로 미룬다.
--      되돌림(scripts/rollback/…down.sql)이 원래 FK를 같은 이름·같은 규칙으로 NOT VALID 복원한다(옛 앱이 채널을 지워 생긴 고아 행이 있어도 멈추지 않는다).
--   ④ 옛 조직 행 지우기 막기(_msgr2_org_delete_guard) — 같은 id의 v2 팀에 다른 멤버가 있으면 거부·건너뜀.
-- 시험: test/msgr2-rooms-pg.test.mjs(msgr2만 적용한 판), test/msgr2-rooms-legacy-combo-pg.test.mjs(옛 msgr 전체 + msgr2 운영 순서 판) — bash scripts/billing-pg-drill.sh <파일>.

-- ── 1. 표 ───────────────────────────────────────────────────────────────────────
-- 개인 공간 1:1은 모든 개인 공간을 통틀어 짝당 하나(팀 1:1은 U1 msgr2_rooms_pair가 공간마다 하나로 막는다).
create unique index if not exists msgr2_rooms_pair_personal on public.msgr2_rooms (pair_key) where kind = 'direct' and pair_key like 'p:%';

-- 팀 공간 초대: 링크(아무나 코드로, max_uses번) 또는 사람 하나(target_user_id — 받는 사람 초대함에 보이고 그 사람만 받는다).
create table if not exists public.msgr2_space_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.msgr2_spaces (id),
  code text not null unique default encode(gen_random_bytes(24), 'hex'),
  role text not null check (role in ('admin', 'member', 'guest')),
  target_user_id uuid,
  room_ids uuid[] not null default '{}' check (cardinality(room_ids) <= 50),
  guest_days int check (guest_days is null or guest_days between 1 and 365),
  max_uses int check (max_uses is null or max_uses between 1 and 1000),
  use_count int not null default 0 check (use_count >= 0),
  expires_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  declined_at timestamptz,
  check (max_uses is null or use_count <= max_uses),
  check (target_user_id is null or max_uses = 1),
  check ((role = 'guest') = (guest_days is not null))
);
create index if not exists msgr2_space_invites_space on public.msgr2_space_invites (space_id) where revoked_at is null;
create index if not exists msgr2_space_invites_target on public.msgr2_space_invites (target_user_id) where target_user_id is not null and revoked_at is null and declined_at is null;
alter table public.msgr2_space_invites enable row level security;
revoke all on public.msgr2_space_invites from public, anon, authenticated;
drop trigger if exists msgr2_lock on public.msgr2_space_invites;
create trigger msgr2_lock before update on public.msgr2_space_invites for each row
  execute function public.msgr2_lock_cols('id', 'space_id', 'code', 'role', 'target_user_id', 'room_ids', 'guest_days', 'max_uses', 'created_by', 'created_at');

-- ── 2. 보조 함수(내부 전용) ─────────────────────────────────────────────────────
-- 앱 기기 확인(D9) — 멤버십을 쓰는 RPC 첫 줄. 반환 = 부른 사람.
create or replace function public._msgr2_need_app() returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then
    raise exception 'msgr2_app_device_required' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- 유효한 기기 확인 — 읽기·내 설정 RPC. 반환 = 부른 사람.
create or replace function public._msgr2_need_device() returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  return auth.uid();
end $$;

-- 늘리는 쓰기는 v2 중단 중에 거부(U2 msgr2_attachment_add와 같은 코드)
create or replace function public._msgr2_need_live() returns void
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
end $$;

-- v2가 운영 중인가: 운영 표지(msgr_settings 'msgr2_enabled' 행)가 있고 v2 중단이 꺼져 있다. 스위치(설계 6절 4단계)가 이 행을 넣는다.
create or replace function public._msgr2_live() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select public._msgr2_setting('msgr2_enabled') is not null and not public._msgr2_paused()
$$;

-- 팀 공간에서의 활동 역할(owner·admin·member·guest) 또는 null(팀 아님·삭제됨·멤버 아님·제거·만료)
create or replace function public._msgr2_team_role(p_space uuid, p_uid uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.msgr2_space_members m join public.msgr2_spaces s on s.id = m.space_id
   where m.space_id = p_space and m.user_id = p_uid and s.kind = 'team' and s.deleted_at is null
     and m.removed_at is null and (m.expires_at is null or m.expires_at > now())
$$;

-- 옛 표(그대로 쓰는 사람 관계) — 표가 없는 시험 DB(msgr2만 적용)에서는 친구 없음·차단 없음.
create or replace function public._msgr2_blocked(p_x uuid, p_y uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_x is null or p_y is null then return false; end if;
  -- 표가 없는 DB에서 계획 단계 오류가 나지 않게 표 확인과 질의를 다른 문장으로 둔다
  if to_regclass('public.msgr_user_blocks') is not null then
    if exists (select 1 from public.msgr_user_blocks b where (b.blocker = p_x and b.blocked = p_y) or (b.blocker = p_y and b.blocked = p_x)) then return true; end if;
  end if;
  if to_regclass('public.msgr_friends') is not null then
    if exists (select 1 from public.msgr_friends f where f.a = least(p_x, p_y) and f.b = greatest(p_x, p_y) and f.status = 'blocked') then return true; end if;
  end if;
  return false;
end $$;

create or replace function public._msgr2_friends(p_x uuid, p_y uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_x is null or p_y is null or p_x = p_y or to_regclass('public.msgr_friends') is null then return false; end if;
  return exists (select 1 from public.msgr_friends f where f.a = least(p_x, p_y) and f.b = greatest(p_x, p_y) and f.status = 'accepted');
end $$;

-- 내 친구(수락) id 목록(검색 후보)
create or replace function public._msgr2_friend_ids(p_uid uuid) returns uuid[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid[] := '{}';
begin
  if to_regclass('public.msgr_friends') is not null then
    select coalesce(array_agg(case when f.a = p_uid then f.b else f.a end), '{}') into v from public.msgr_friends f where (f.a = p_uid or f.b = p_uid) and f.status = 'accepted';
  end if;
  return v;
end $$;

-- 내가 차단한 사람(안 읽음·검색에서 그 사람 글을 뺀다 — 옛 msgr_unread와 같은 방향)
create or replace function public._msgr2_my_blocked(p_uid uuid) returns uuid[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v uuid[] := '{}';
begin
  if to_regclass('public.msgr_user_blocks') is not null then
    select coalesce(array_agg(b.blocked), '{}') into v from public.msgr_user_blocks b where b.blocker = p_uid and b.blocked is not null;
  end if;
  return v;
end $$;

-- 사람 이름(옛 msgr_person_label과 같은 규칙: 프로필 표시 이름 → 이메일 앞부분)
create or replace function public._msgr2_label(p_uid uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if to_regclass('public.msgr_profiles') is not null then
    select nullif(btrim(p.display_name), '') into v from public.msgr_profiles p where p.user_id = p_uid;
  end if;
  if v is null then select nullif(split_part(u.email, '@', 1), '') into v from auth.users u where u.id = p_uid; end if;
  return v;
end $$;

-- 방 멤버 넣기·되살리기(값이 바뀔 때만 쓴다). 반환 = 썼는가.
create or replace function public._msgr2_room_put(p_room uuid, p_kind text, p_member uuid, p_by uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into public.msgr2_room_members as t (room_id, member_kind, member_id, added_by) values (p_room, p_kind, p_member, p_by)
  on conflict (room_id, member_kind, member_id) do update set removed_at = null, added_by = excluded.added_by
  where t.removed_at is not null;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 에이전트를 방에 넣는 조건(설계 1-3): 부른 사람이 그 에이전트의 주인이고(활동 중), 그 방에 쓸 수 있고(msgr2_access),
-- 방의 공간이 개인 공간(내 공간·친구 방)이거나 그 에이전트의 파견 행이 살아 있는 팀 공간이다.
create or replace function public._msgr2_room_add_agent(p_room uuid, p_agent uuid, p_uid uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare s public.msgr2_spaces;
begin
  if not exists (select 1 from public.msgr2_agents a where a.id = p_agent and a.owner_user_id = p_uid and a.status = 'active')
     or not coalesce((public.msgr2_access(p_room)).write, false) then
    raise exception 'msgr2_agent_not_allowed' using errcode = '42501';
  end if;
  select s2.* into s from public.msgr2_spaces s2 join public.msgr2_rooms r on r.space_id = s2.id where r.id = p_room;
  if s.kind = 'team' and not exists (select 1 from public.msgr2_agent_seats st where st.agent_id = p_agent and st.space_id = s.id and st.removed_at is null) then
    raise exception 'msgr2_agent_not_allowed' using errcode = '42501';
  end if;
  return public._msgr2_room_put(p_room, 'agent', p_agent, p_uid);
end $$;

-- 사람이 더는 방을 못 읽게 됐을 때 그 사람의 에이전트도 방에서 뺀다(에이전트는 "주인이 방의 멤버"일 때만 있다, 설계 1-3).
create or replace function public._msgr2_room_drop_agents_of(p_room uuid, p_owner uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if coalesce((public._msgr2_access_for(p_room, p_owner)).read, false) then return; end if;
  update public.msgr2_room_members m set removed_at = now()
   where m.room_id = p_room and m.member_kind = 'agent' and m.removed_at is null
     and exists (select 1 from public.msgr2_agents a where a.id = m.member_id and a.owner_user_id = p_owner);
end $$;

-- 그 공간의 방 멤버 행·그 사람 에이전트의 방 멤버 행·파견 행을 닫는다(공간에서 빠질 때, 기한 지난 손님이 다시 들어올 때 — 옛 비공개 방이 저절로 열리지 않게).
create or replace function public._msgr2_space_close(p_space uuid, p_uid uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  update public.msgr2_room_members m set removed_at = now()
    from public.msgr2_rooms r
   where r.id = m.room_id and r.space_id = p_space and m.removed_at is null
     and ((m.member_kind = 'user' and m.member_id = p_uid)
          or (m.member_kind = 'agent' and exists (select 1 from public.msgr2_agents a where a.id = m.member_id and a.owner_user_id = p_uid)));
  update public.msgr2_agent_seats st set removed_at = now()
   where st.space_id = p_space and st.removed_at is null
     and exists (select 1 from public.msgr2_agents a where a.id = st.agent_id and a.owner_user_id = p_uid);
end $$;

-- 공간에서 빠진 사람: 멤버 행을 닫고 위 정리를 함께 한다.
create or replace function public._msgr2_space_drop(p_space uuid, p_uid uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  update public.msgr2_space_members set removed_at = now() where space_id = p_space and user_id = p_uid and removed_at is null;
  perform public._msgr2_space_close(p_space, p_uid);
  perform public._msgr2_send_u(p_uid, 'spaces', jsonb_build_object('space_id', p_space, 'removed', true));
end $$;

-- 차단 관계(어느 쪽이든)가 새로 넣는 사람(p_new)과 함께 있게 될 사람(p_all) 사이에 하나라도 있나 — 옛 msgr_dm_personal_group의 msgr_group_blocked_pair와 같은 뜻.
-- 이미 방에 함께 있는 사람끼리의 차단은 보지 않는다(옛 그룹과 같이 — 방 전체가 잠기지 않게).
create or replace function public._msgr2_blocked_among(p_new uuid[], p_all uuid[]) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if cardinality(p_new) = 0 then return false; end if;
  if to_regclass('public.msgr_user_blocks') is not null then
    if exists (select 1 from public.msgr_user_blocks b
                where (b.blocker = any (p_new) and b.blocked = any (p_all)) or (b.blocked = any (p_new) and b.blocker = any (p_all))) then return true; end if;
  end if;
  if to_regclass('public.msgr_friends') is not null then
    if exists (select 1 from public.msgr_friends f
                where f.status = 'blocked' and ((f.a = any (p_new) and f.b = any (p_all)) or (f.b = any (p_new) and f.a = any (p_all)))) then return true; end if;
  end if;
  return false;
end $$;

-- 링크 초대가 방에 넣을 때: 없는 행만 넣는다(빠진 행은 되살리지 않는다 — 방에서 빼낸 사람이 링크로 돌아오지 못하게). 반환 = 넣었는가.
create or replace function public._msgr2_room_put_new(p_room uuid, p_member uuid, p_by uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  insert into public.msgr2_room_members (room_id, member_kind, member_id, added_by) values (p_room, 'user', p_member, p_by) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 1:1 차단(총괄 지시 2026-10-18 B, 옛 msgr_can_write_channel과 같은 동작): direct 방은 한쪽이 차단하면(어느 쪽이든) 상대에게 쓰기를 주지 않는다. 지난 대화는 읽기로 남는다.
-- U2(20261018000000)의 _msgr2_access_for 본문에 아래 한 줄(U6d 주석이 붙은 줄)만 더한다 — 나머지는 바이트 단위로 같다(test/msgr2-rooms-legacy-combo-pg가 대조한다).
-- 규칙은 여전히 이 한 함수에만 있다(msgr2_access = 기기 확인 + 이 함수). 되돌림은 U2 본문으로 돌린다.
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
  if r.kind = 'direct' and res.write and exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id <> uid and public._msgr2_blocked(uid, m.member_id)) then res.write := false; end if; -- U6d: 1:1은 차단(어느 쪽이든)이면 쓰기 막음
  res.invite := r.kind <> 'direct' and r.archived_at is null and (case when s.kind = 'team' then v_role in ('owner', 'admin', 'member') else adm end);
  res.manage := r.kind <> 'direct' and adm;
  res.decide := adm;
  res.tier := t;
  return res;
end $$;
revoke all on function public._msgr2_access_for(uuid, uuid) from public, anon, authenticated;

-- ── 3. 옛 중단 장치 통과(총괄 지시 2026-10-18 1·2-③) ────────────────────────────
-- msgr_pause_guard가 부른다. 참이면 그 INSERT는 중단 중에도 통과한다. 그 밖은 옛 동작 그대로(거부).
create or replace function public._msgr2_pause_pass(p_table text, r jsonb) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare mirror text := nullif(current_setting('msgr2.org_mirror', true), '');
begin
  if p_table = 'msgr_orgs' then return mirror is not null and mirror = r->>'id'; end if;
  if p_table = 'msgr_org_members' then return mirror is not null and mirror = r->>'org_id'; end if;
  if p_table = 'msgr_friends' then return public._msgr2_live() and public._msgr2_device_app(); end if;
  return false;
end $$;

-- 옛 판(20261016170000)의 본문에 v2 통과 한 줄만 더한다(되돌림이 옛 본문으로 돌린다). 옛 판이 없는 DB(msgr2만)에서는 만들지 않는다.
do $do$ begin
  if to_regprocedure('public.msgr_pause_guard()') is not null then
    execute $f$
create or replace function public.msgr_pause_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public._msgr_paused() then return new; end if;
  r := to_jsonb(new); -- 표마다 열이 달라 new.<열>을 직접 읽지 않는다(PL/pgSQL은 and 앞이 거짓이어도 뒤 식의 열을 찾는다)
  if tg_table_name = 'msgr_messages' and r->>'kind' = 'system' and coalesce(current_setting('msgr.pause_notice', true), '') = '1' then return new; end if;
  if tg_table_name = 'msgr_friends' and r->>'status' = 'blocked' then return new; end if; -- 차단은 안전 기능(msgr_friend_remove)
  if public._msgr2_pause_pass(tg_table_name, r) then return new; end if; -- 메신저 v2(20261018040000): v2 앱 기기의 친구 쓰기·v2 팀 공간의 옛 조직 행
  -- 문구·코드는 이미 배포된 쪽이 아는 모양에 맞췄다(PR 표): 42501 = 메신저 글 보내기 카드 "이 방에 보낼 수 없습니다"(다시 시도 없음)·본체 큐 영구 오류(재시도 없음),
  -- 첫 토큰 msgr_forbidden = 엣지 msgr-bot ERR의 403(모르는 이름이면 500 → Hermes outbox 재시도, msgr-bot-err-contract), 'row-level security' = 토스트·초대 창 "권한이 없습니다".
  -- 'messenger service paused'로 새 앱은 가려 읽을 수 있다. 'read-only'는 넣지 않는다("읽기 전용(계정 상태)"로 오해).
  raise exception 'msgr_forbidden (new row violates row-level security policy, messenger service paused)' using errcode = '42501';
end $$;
$f$;
    revoke all on function public.msgr_pause_guard() from public, anon, authenticated;
  end if;
end $do$;

-- v2 팀 공간의 옛 조직 행(같은 id, 설계 1-2 — 요금 msgr_org_entitlements·문서 msgr_org_docs·일지·신고의 org_id FK). 옛 표가 없거나 이미 있으면 쓰지 않는다.
-- 옛 조직 트리거(msgr_org_after_insert)가 주인 멤버·요금·정책 행을 함께 만든다. slug는 'v2-' + id 32자(옛 slug 규칙 안, 겹치지 않음).
create or replace function public._msgr2_mirror_org(p_space uuid, p_name text, p_owner uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if to_regclass('public.msgr_orgs') is null then return false; end if;
  if exists (select 1 from public.msgr_orgs o where o.id = p_space) then return false; end if;
  perform set_config('msgr2.org_mirror', p_space::text, true);
  insert into public.msgr_orgs (id, name, slug, owner_user_id) values (p_space, left(p_name, 80), 'v2-' || replace(p_space::text, '-', ''), p_owner);
  perform set_config('msgr2.org_mirror', '', true);
  return true;
end $$;

-- 거울 조직 지우기 막기(총괄 지시 2026-10-18 C): 같은 id의 살아 있는 v2 팀(주인 말고 활동 멤버가 있음)이 있으면 옛 조직 행을 지우지 않는다 —
-- 옛 조직을 지우면 요금(msgr_org_entitlements)·조직 문서·일지가 cascade로 사라진다. 옛 판정(msgr_delete_me의 주인 넘기기 확인)은 v2 멤버를 모른다.
--   사람 문맥(계정 삭제 msgr_delete_me 등)은 옛 함수와 같은 msgr_owner_transfer_required로 거부한다(계정 삭제 전체가 되돌려진다).
--   서비스 일괄 정리(msgr_purge_orgs, auth.uid() 없음)는 이 조직 행만 건너뛴다(return null) — 거부하면 한 조직 때문에 다른 조직 정리가 매번 멈춘다.
-- v2 팀이 없거나(옛 조직만) 주인 혼자인 팀이면 옛 동작 그대로.
create or replace function public._msgr2_org_delete_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.msgr2_spaces s where s.id = old.id and s.kind = 'team' and s.deleted_at is null
               and exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id <> s.owner_user_id
                             and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))) then
    if auth.uid() is null and coalesce(current_setting('argo.msgr_account_delete', true), '') <> '1' then return null; end if;
    raise exception 'msgr_owner_transfer_required: %', old.id;
  end if;
  return old;
end $$;
do $do$ begin
  if to_regclass('public.msgr_orgs') is not null then
    drop trigger if exists msgr2_org_delete_guard on public.msgr_orgs;
    create trigger msgr2_org_delete_guard before delete on public.msgr_orgs for each row execute function public._msgr2_org_delete_guard();
  end if;
end $do$;

-- ── 4. 옛 FK → "옛 표나 v2 표 중 하나" 검사(총괄 지시 2026-10-18 2-①②) ─────────────────
-- tg_argv: 열, 옛 표, v2 표, 형(bigint|uuid). 값이 없거나(null) 바뀌지 않았으면 통과. 둘 다 없으면 FK와 같은 23503.
create or replace function public._msgr2_ref_check() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := to_jsonb(new)->>tg_argv[0]; ok boolean;
begin
  if v is null then return new; end if;
  if tg_op = 'UPDATE' and v is not distinct from (to_jsonb(old)->>tg_argv[0]) then return new; end if;
  if tg_argv[3] not in ('bigint', 'uuid') then raise exception 'msgr2_ref_check_type'; end if;
  execute format('select exists (select 1 from public.%I where id = $1::%s) or exists (select 1 from public.%I where id = $1::%s)',
                 tg_argv[1], tg_argv[3], tg_argv[2], tg_argv[3]) into ok using v;
  if not ok then
    raise exception 'insert or update on table "%" violates foreign key constraint "%_%_fkey"', tg_table_name, tg_table_name, tg_argv[0]
      using errcode = '23503', detail = format('Key (%s)=(%s) is not present in table "%s" or "%s".', tg_argv[0], v, tg_argv[1], tg_argv[2]);
  end if;
  return new;
end $$;

-- 옛 FK의 on delete set null을 잇는다: 옛 글·채널이 지워지면 신고·일지 출처를 비운다 — 같은 id의 v2 글·방이 있으면 그것을 가리키므로 두고.
create or replace function public._msgr2_ref_old_deleted() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'msgr_messages' then
    if exists (select 1 from public.msgr2_messages x where x.id = old.id) then return null; end if;
    if to_regclass('public.msgr_reports') is not null then update public.msgr_reports set message_id = null where message_id = old.id; end if;
    if to_regclass('public.msgr_journal_entries') is not null then update public.msgr_journal_entries set source_msg_id = null where source_msg_id = old.id; end if;
  elsif tg_table_name = 'msgr_channels' then
    if exists (select 1 from public.msgr2_rooms x where x.id = old.id) then return null; end if;
    if to_regclass('public.msgr_reports') is not null then update public.msgr_reports set channel_id = null where channel_id = old.id; end if;
  end if;
  return null;
end $$;

do $do$
declare t record; cname text;
begin
  for t in select * from (values
      ('msgr_reports', 'message_id', 'msgr_messages', 'msgr2_messages', 'bigint'),
      ('msgr_reports', 'channel_id', 'msgr_channels', 'msgr2_rooms', 'uuid'),
      ('msgr_journal_entries', 'source_msg_id', 'msgr_messages', 'msgr2_messages', 'bigint'),
      ('msgr_journal_entries', 'channel_id', 'msgr_channels', 'msgr2_rooms', 'uuid')) v(tbl, col, old_t, new_t, typ) loop
    if to_regclass('public.' || t.tbl) is null or to_regclass('public.' || t.old_t) is null then continue; end if;
    for cname in select c.conname from pg_constraint c
                  where c.conrelid = ('public.' || t.tbl)::regclass and c.contype = 'f' and c.confrelid = ('public.' || t.old_t)::regclass
                    and c.conkey = array[(select a.attnum from pg_attribute a where a.attrelid = ('public.' || t.tbl)::regclass and a.attname = t.col)] loop
      execute format('alter table public.%I drop constraint %I', t.tbl, cname);
    end loop;
    execute format('drop trigger if exists %I on public.%I', 'msgr2_ref_' || t.col, t.tbl);
    execute format('create trigger %I before insert or update of %I on public.%I for each row execute function public._msgr2_ref_check(%L, %L, %L, %L)',
                   'msgr2_ref_' || t.col, t.col, t.tbl, t.col, t.old_t, t.new_t, t.typ);
  end loop;
  if to_regclass('public.msgr_messages') is not null then
    drop trigger if exists msgr2_ref_old_deleted on public.msgr_messages;
    create trigger msgr2_ref_old_deleted after delete on public.msgr_messages for each row execute function public._msgr2_ref_old_deleted();
  end if;
  if to_regclass('public.msgr_channels') is not null then
    drop trigger if exists msgr2_ref_old_deleted on public.msgr_channels;
    create trigger msgr2_ref_old_deleted after delete on public.msgr_channels for each row execute function public._msgr2_ref_old_deleted();
  end if;
end $do$;

-- ── 5. 공간 ─────────────────────────────────────────────────────────────────────
-- 팀 공간 만들기: 앱 기기. 이름 1~80자, slug는 선택(옛 조직 slug 규칙). 주인당 활동 팀 공간 상한(msgr2_limit_team_spaces, 기본 20).
-- 같은 id의 옛 조직 행을 함께 만든다(요금·문서). 반환 = 공간 id.
create or replace function public.msgr2_space_create(p_name text, p_slug text default null) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); nm text := btrim(coalesce(p_name, '')); sid uuid := gen_random_uuid();
begin
  perform public._msgr2_need_live();
  if char_length(nm) not between 1 and 80 then raise exception 'msgr2_bad_name' using errcode = '22023'; end if;
  if p_slug is not null and p_slug !~ '^[a-z0-9][a-z0-9-]{1,39}$' then raise exception 'msgr2_bad_slug' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr2_space_create:' || uid::text));
  if (select count(*) from public.msgr2_spaces where owner_user_id = uid and kind = 'team' and deleted_at is null) >= public._msgr2_setting_int('msgr2_limit_team_spaces', 20) then
    raise exception 'msgr2_limit' using errcode = '22023', detail = 'team_spaces';
  end if;
  if p_slug is not null then
    if exists (select 1 from public.msgr2_spaces where slug = p_slug) then raise exception 'msgr2_slug_taken' using errcode = '23505'; end if;
    if to_regclass('public.msgr_orgs') is not null then
      if exists (select 1 from public.msgr_orgs o where o.slug = p_slug) then raise exception 'msgr2_slug_taken' using errcode = '23505'; end if;
    end if;
  end if;
  insert into public.msgr2_spaces (id, kind, name, slug, owner_user_id) values (sid, 'team', nm, p_slug, uid);
  insert into public.msgr2_space_members (space_id, user_id, role) values (sid, uid, 'owner');
  perform public._msgr2_mirror_org(sid, nm, uid);
  perform public._msgr2_send_u(uid, 'spaces', jsonb_build_object('space_id', sid));
  return sid;
end $$;

-- 공간 나가기(팀): 앱 기기. 주인은 나가지 못한다(주인 넘기기는 별도). 이미 나갔으면 쓰기 없이 false.
create or replace function public.msgr2_space_leave(p_space uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); me text;
begin
  select m.role into me from public.msgr2_space_members m join public.msgr2_spaces s on s.id = m.space_id
   where m.space_id = p_space and m.user_id = uid and s.kind = 'team' and m.removed_at is null;
  if me is null then return false; end if;
  if me = 'owner' then raise exception 'msgr2_owner_cannot_leave' using errcode = '42501'; end if;
  perform public._msgr2_space_drop(p_space, uid);
  return true;
end $$;

-- 공간에서 내보내기: 앱 기기, 팀 공간의 owner·admin. 주인은 못 내보내고, admin은 admin을 못 내보낸다(msgr2_set_member_role과 같은 규칙).
create or replace function public.msgr2_space_member_remove(p_space uuid, p_user uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); me text := public._msgr2_team_role(p_space, uid); them text;
begin
  select role into them from public.msgr2_space_members where space_id = p_space and user_id = p_user and removed_at is null;
  if me is null or me not in ('owner', 'admin') or p_user = uid then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  if them is null then return false; end if;
  if them = 'owner' or (me = 'admin' and them = 'admin') then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  perform public._msgr2_space_drop(p_space, p_user);
  return true;
end $$;

-- ── 6. 초대 ─────────────────────────────────────────────────────────────────────
-- 초대 만들기: 앱 기기, 팀 공간의 owner·admin(admin 역할 초대는 owner만). p_user를 주면 그 사람 하나에게(1회용, 차단 관계면 거부),
-- 없으면 링크(max_uses, null = 제한 없음). p_rooms = 받으면 함께 들어갈 방(공간 안·보관 안 됨·open/private·내가 그 방에 초대할 수 있음).
-- 손님 초대는 방 1개 이상 + 머무는 기간(p_guest_days). 같은 사람에게 살아 있는 초대가 있으면 새로 만들지 않고 그것을 돌려준다.
-- 반환 {invite_id, code, expires_at, existing}
create or replace function public.msgr2_invite_create(p_space uuid, p_role text default 'member', p_user uuid default null, p_rooms uuid[] default '{}',
  p_max_uses int default 1, p_expires_in_s int default 604800, p_guest_days int default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); me text := public._msgr2_team_role(p_space, uid); rooms uuid[]; x uuid; inv public.msgr2_space_invites;
begin
  perform public._msgr2_need_live();
  if me is null or me not in ('owner', 'admin') or (p_role = 'admin' and me <> 'owner') then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('admin', 'member', 'guest') then raise exception 'msgr2_bad_role' using errcode = '22023'; end if;
  rooms := coalesce((select array_agg(distinct r) from unnest(coalesce(p_rooms, '{}')) r where r is not null), '{}');
  if cardinality(rooms) > 50 or (p_role = 'guest') <> (p_guest_days is not null) or (p_role = 'guest' and cardinality(rooms) = 0)
     or (p_guest_days is not null and p_guest_days not between 1 and 365)
     or (p_expires_in_s is not null and p_expires_in_s not between 60 and 31536000)
     or (p_max_uses is not null and p_max_uses not between 1 and 1000) then
    raise exception 'msgr2_bad_invite' using errcode = '22023';
  end if;
  foreach x in array rooms loop
    if not exists (select 1 from public.msgr2_rooms r where r.id = x and r.space_id = p_space and r.archived_at is null and r.kind in ('open', 'private'))
       or not coalesce((public.msgr2_access(x)).invite, false) then
      raise exception 'msgr2_invite_room_forbidden' using errcode = '42501';
    end if;
  end loop;
  if p_user is not null then
    if p_user = uid or not exists (select 1 from auth.users u where u.id = p_user) or public._msgr2_blocked(uid, p_user) then
      raise exception 'msgr2_invite_unavailable' using errcode = '42501'; -- 없는 사람·차단(어느 쪽이든)을 같은 오류로(차단 여부를 드러내지 않는다)
    end if;
    if public._msgr2_team_role(p_space, p_user) is not null then
      return jsonb_build_object('invite_id', null, 'code', null, 'expires_at', null, 'existing', false, 'already_member', true);
    end if;
    select * into inv from public.msgr2_space_invites i
     where i.space_id = p_space and i.target_user_id = p_user and i.revoked_at is null and i.declined_at is null and i.use_count = 0
       and (i.expires_at is null or i.expires_at > now()) and i.role = p_role and i.room_ids = rooms
     order by i.created_at desc limit 1;
    if inv.id is not null then
      return jsonb_build_object('invite_id', inv.id, 'code', inv.code, 'expires_at', inv.expires_at, 'existing', true);
    end if;
  end if;
  if (select count(*) from public.msgr2_space_invites i where i.space_id = p_space and i.revoked_at is null and i.declined_at is null
        and (i.expires_at is null or i.expires_at > now()) and (i.max_uses is null or i.use_count < i.max_uses)) >= public._msgr2_setting_int('msgr2_limit_invites_space', 200) then
    raise exception 'msgr2_limit' using errcode = '22023', detail = 'invites';
  end if;
  insert into public.msgr2_space_invites (space_id, role, target_user_id, room_ids, guest_days, max_uses, expires_at, created_by)
  values (p_space, p_role, p_user, rooms, p_guest_days, case when p_user is not null then 1 else p_max_uses end,
          case when p_expires_in_s is null then null else now() + make_interval(secs => p_expires_in_s) end, uid)
  returning * into inv;
  if p_user is not null then perform public._msgr2_send_u(p_user, 'invite', jsonb_build_object('invite_id', inv.id, 'space_id', p_space)); end if;
  return jsonb_build_object('invite_id', inv.id, 'code', inv.code, 'expires_at', inv.expires_at, 'existing', false);
end $$;

-- 초대 상태(읽을 때 계산): revoked·declined·expired·exhausted·valid. 만든 사람이 더는 그 초대를 만들 수 없으면(빠짐·강등) revoked로 본다.
create or replace function public._msgr2_invite_state(i public.msgr2_space_invites) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when i.revoked_at is not null then 'revoked'
    when i.declined_at is not null then 'declined'
    when not exists (select 1 from public.msgr2_spaces s where s.id = i.space_id and s.deleted_at is null) then 'revoked'
    when coalesce(public._msgr2_team_role(i.space_id, i.created_by), '') not in ('owner', 'admin')
      or (i.role = 'admin' and public._msgr2_team_role(i.space_id, i.created_by) <> 'owner') then 'revoked'
    when i.expires_at is not null and i.expires_at <= now() then 'expired'
    when i.max_uses is not null and i.use_count >= i.max_uses then 'exhausted'
    else 'valid' end
$$;

-- 미리보기(받는 쪽 카드): 유효한 기기. 틀린 코드·남에게 온 사람 초대는 같은 msgr2_invite_not_found.
-- 반환 {state, space_id, space_name, role, inviter_id, inviter_name, rooms[{id,name}], expires_at, already_member}
create or replace function public.msgr2_invite_preview(p_code text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); i public.msgr2_space_invites; st text;
begin
  select * into i from public.msgr2_space_invites where code = p_code;
  if i.id is null or (i.target_user_id is not null and i.target_user_id <> uid) then raise exception 'msgr2_invite_not_found' using errcode = '22023'; end if;
  st := public._msgr2_invite_state(i);
  if st <> 'valid' then
    return jsonb_build_object('state', st, 'space_name', (select s.name from public.msgr2_spaces s where s.id = i.space_id));
  end if;
  return jsonb_build_object('state', 'valid', 'space_id', i.space_id, 'space_name', (select s.name from public.msgr2_spaces s where s.id = i.space_id),
    'role', i.role, 'inviter_id', i.created_by, 'inviter_name', public._msgr2_label(i.created_by), 'expires_at', i.expires_at,
    'already_member', public._msgr2_team_role(i.space_id, uid) is not null,
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name) from public.msgr2_rooms r
                        where r.id = any (i.room_ids) and r.space_id = i.space_id and r.archived_at is null), '[]'::jsonb));
end $$;

-- 받기: 앱 기기. 초대가 유효해야 한다(이미 멤버여도 소진·만료·취소는 거부하고, 받으면 사용 횟수를 센다).
-- 처음 들어오면 멤버 행을 넣는다. 빠졌거나 기한이 지난 멤버 행이 있으면 사람 지정 초대만 되살린다(링크로는 msgr2_invite_rejoin_direct_only) —
-- 내보낸 사람이 살아 있는 링크로 혼자 돌아오지 못하게. 되살릴 때는 새로 시작한다: 그 공간의 옛 방 멤버 행·에이전트·파견을 닫고(기한 지난 손님은 아직 열려 있다)
-- 이번 초대의 방만 넣는다. 방은 지금도 유효하고(공간 안·보관 안 됨·open/private) 초대 만든 사람이 지금 그 방에 초대할 수 있어야 한다(_msgr2_access_for(방, 만든 사람).invite).
-- 링크 초대는 방에서 빠진 행을 되살리지 않는다(없는 행만 넣는다). 사람 지정 초대는 되살린다.
-- 반환 {space_id, role, rooms[], already_member}
create or replace function public.msgr2_invite_accept(p_code text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); i public.msgr2_space_invites; st text; cur text; prev public.msgr2_space_members; added uuid[] := '{}'; x uuid; ok boolean;
begin
  perform public._msgr2_need_live();
  select * into i from public.msgr2_space_invites where code = p_code for update;
  if i.id is null or (i.target_user_id is not null and i.target_user_id <> uid) then raise exception 'msgr2_invite_not_found' using errcode = '22023'; end if;
  st := public._msgr2_invite_state(i);
  if st <> 'valid' then raise exception 'msgr2_invite_%', st using errcode = '22023'; end if;
  cur := public._msgr2_team_role(i.space_id, uid);
  if cur is null then
    select * into prev from public.msgr2_space_members where space_id = i.space_id and user_id = uid for update;
    if prev.user_id is not null then
      if i.target_user_id is null then raise exception 'msgr2_invite_rejoin_direct_only' using errcode = '42501'; end if;
      perform public._msgr2_space_close(i.space_id, uid);
      update public.msgr2_space_members set removed_at = null, role = i.role,
             expires_at = case when i.guest_days is null then null else now() + make_interval(days => i.guest_days) end
       where space_id = i.space_id and user_id = uid;
    else
      insert into public.msgr2_space_members (space_id, user_id, role, expires_at)
      values (i.space_id, uid, i.role, case when i.guest_days is null then null else now() + make_interval(days => i.guest_days) end);
    end if;
  end if;
  update public.msgr2_space_invites set use_count = use_count + 1 where id = i.id;
  foreach x in array i.room_ids loop
    if exists (select 1 from public.msgr2_rooms r where r.id = x and r.space_id = i.space_id and r.archived_at is null and r.kind in ('open', 'private'))
       and coalesce((public._msgr2_access_for(x, i.created_by)).invite, false) then
      ok := case when i.target_user_id is null then public._msgr2_room_put_new(x, uid, i.created_by) else public._msgr2_room_put(x, 'user', uid, i.created_by) end;
      if ok or exists (select 1 from public.msgr2_room_members m where m.room_id = x and m.member_kind = 'user' and m.member_id = uid and m.removed_at is null) then
        added := added || x;
      end if;
    end if;
  end loop;
  perform public._msgr2_send_u(uid, 'spaces', jsonb_build_object('space_id', i.space_id));
  return jsonb_build_object('space_id', i.space_id, 'role', coalesce(cur, i.role), 'rooms', to_jsonb(added), 'already_member', cur is not null);
end $$;

-- 거절(사람 초대만, 받는 사람만): 앱 기기. 이미 정했으면 false.
create or replace function public.msgr2_invite_decline(p_code text) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); n int;
begin
  update public.msgr2_space_invites set declined_at = now()
   where code = p_code and target_user_id = uid and declined_at is null and revoked_at is null and use_count = 0;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 취소: 앱 기기, 만든 사람 또는 그 공간의 owner·admin. 이미 취소됐으면 false. 없는 초대·남의 공간은 msgr2_invite_not_found.
create or replace function public.msgr2_invite_revoke(p_invite uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); i public.msgr2_space_invites;
begin
  select * into i from public.msgr2_space_invites where id = p_invite for update;
  if i.id is null or not (i.created_by = uid or coalesce(public._msgr2_team_role(i.space_id, uid), '') in ('owner', 'admin')) then
    raise exception 'msgr2_invite_not_found' using errcode = '42501';
  end if;
  if i.revoked_at is not null then return false; end if;
  update public.msgr2_space_invites set revoked_at = now() where id = i.id;
  return true;
end $$;

-- 공간의 초대 목록(관리 화면): 앱 기기, 그 공간의 owner·admin. 링크 코드를 다시 쓸 수 있게 코드를 싣되, 부른 사람이 만들 수 없는 역할(admin이 보는 admin 초대)의 코드는 비운다. 최근 200개.
create or replace function public.msgr2_invites_list(p_space uuid)
  returns table (id uuid, code text, role text, target_user_id uuid, target_name text, room_ids uuid[], guest_days int, max_uses int, use_count int,
                 expires_at timestamptz, created_by uuid, created_at timestamptz, state text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); me text := public._msgr2_team_role(p_space, auth.uid());
begin
  if coalesce(me, '') not in ('owner', 'admin') then return; end if;
  return query
    select i.id, case when i.role = 'admin' and me <> 'owner' then null else i.code end, i.role, i.target_user_id, case when i.target_user_id is not null then public._msgr2_label(i.target_user_id) end,
           i.room_ids, i.guest_days, i.max_uses, i.use_count, i.expires_at, i.created_by, i.created_at, public._msgr2_invite_state(i)
      from public.msgr2_space_invites i where i.space_id = p_space
     order by i.created_at desc limit 200;
end $$;

-- 내 초대함(나에게 온 사람 초대 중 받을 수 있는 것): 유효한 기기. 내가 차단한 사람·나를 차단한 사람의 초대는 숨긴다.
create or replace function public.msgr2_my_invites()
  returns table (invite_id uuid, code text, space_id uuid, space_name text, role text, inviter_id uuid, inviter_name text, created_at timestamptz, expires_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device();
begin
  return query
    select i.id, i.code, i.space_id, s.name, i.role, i.created_by, public._msgr2_label(i.created_by), i.created_at, i.expires_at
      from public.msgr2_space_invites i join public.msgr2_spaces s on s.id = i.space_id
     where i.target_user_id = uid and i.revoked_at is null and i.declined_at is null
       and public._msgr2_invite_state(i) = 'valid' and public._msgr2_team_role(i.space_id, uid) is null
       and not public._msgr2_blocked(uid, i.created_by)
     order by i.created_at desc limit 100;
end $$;

-- ── 7. 방 ───────────────────────────────────────────────────────────────────────
-- 방 만들기: 앱 기기. p_space null = 내 개인 공간. kind open(팀만)·private. 1:1은 msgr2_dm_open·msgr2_agent_dm_open.
-- 팀: 손님 아닌 활동 멤버가 만들고, 넣는 사람은 그 공간의 활동 멤버만. 개인: 내 개인 공간에만, 넣는 사람은 수락한 친구(차단 관계 아님)만.
-- 만든 사람은 늘 방 멤버. 에이전트는 _msgr2_room_add_agent 규칙. 공간당 방 상한(msgr2_limit_rooms_space, 기본 1000). 반환 = 방 id.
create or replace function public.msgr2_room_create(p_space uuid, p_kind text, p_name text, p_users uuid[] default '{}', p_agents uuid[] default '{}') returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); sp uuid := p_space; s public.msgr2_spaces; me text; rid uuid := gen_random_uuid();
  nm text := btrim(coalesce(p_name, '')); users uuid[]; agents uuid[]; x uuid;
begin
  perform public._msgr2_need_live();
  if p_kind is null or p_kind not in ('open', 'private') then raise exception 'msgr2_bad_kind' using errcode = '22023'; end if;
  if sp is null then sp := public.msgr2_my_personal_space(); end if;
  select * into s from public.msgr2_spaces where id = sp and deleted_at is null;
  if s.id is null then raise exception 'msgr2_space_not_found' using errcode = '42501'; end if;
  users := coalesce((select array_agg(distinct u) from unnest(coalesce(p_users, '{}')) u where u is not null and u <> uid), '{}');
  agents := coalesce((select array_agg(distinct a) from unnest(coalesce(p_agents, '{}')) a where a is not null), '{}');
  if cardinality(users) > 100 or cardinality(agents) > 20 or char_length(nm) > 80 then raise exception 'msgr2_bad_room' using errcode = '22023'; end if;
  if s.kind = 'team' then
    me := public._msgr2_team_role(s.id, uid);
    if me is null or me = 'guest' then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
    if char_length(nm) = 0 then raise exception 'msgr2_bad_name' using errcode = '22023'; end if;
    if exists (select 1 from unnest(users) u where public._msgr2_team_role(s.id, u) is null) then raise exception 'msgr2_not_space_member' using errcode = '42501'; end if;
  else
    if s.owner_user_id <> uid then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
    if p_kind = 'open' then raise exception 'msgr2_bad_kind' using errcode = '22023'; end if;
    if exists (select 1 from unnest(users) u where not public._msgr2_friends(uid, u) or public._msgr2_blocked(uid, u)) then
      raise exception 'msgr2_not_friend' using errcode = '42501';
    end if;
  end if;
  -- 구성원끼리(부른 사람 포함) 차단 관계가 있으면 한 방에 넣지 않는다(팀·개인 모두, 옛 msgr_group_blocked_pair)
  if public._msgr2_blocked_among(users || uid, users || uid) then raise exception 'msgr2_group_blocked_pair' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr2_room_create:' || s.id::text));
  if (select count(*) from public.msgr2_rooms where space_id = s.id and archived_at is null) >= public._msgr2_setting_int('msgr2_limit_rooms_space', 1000) then
    raise exception 'msgr2_limit' using errcode = '22023', detail = 'rooms';
  end if;
  insert into public.msgr2_rooms (id, space_id, kind, name, created_by) values (rid, s.id, p_kind, nm, uid);
  perform public._msgr2_room_put(rid, 'user', uid, uid);
  foreach x in array users loop perform public._msgr2_room_put(rid, 'user', x, uid); end loop;
  foreach x in array agents loop perform public._msgr2_room_add_agent(rid, x, uid); end loop;
  foreach x in array (users || uid) loop perform public._msgr2_send_u(x, 'rooms', jsonb_build_object('space_id', s.id, 'room_id', rid)); end loop;
  return rid;
end $$;

-- 1:1 열기: 앱 기기. p_space null = 개인 1:1(수락한 친구만), 팀 공간 id = 그 공간의 1:1(둘 다 활동 멤버). 차단(어느 쪽이든)이면 거부.
-- 거부는 모두 msgr2_dm_unavailable 하나(친구·차단·멤버 여부를 드러내지 않는다). 짝당 한 방 — 있으면 그 방(나갔던 사람은 되살림, 보관은 풂).
-- 개인 1:1은 처음 연 사람의 개인 공간에 만든다. 이미 있고 둘 다 멤버면 쓰기 0. 반환 {room_id, space_id, existing}
create or replace function public.msgr2_dm_open(p_user uuid, p_space uuid default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); k text; r public.msgr2_rooms; existing boolean := true; sp uuid; wrote boolean := false;
begin
  perform public._msgr2_need_live();
  if p_user is null or p_user = uid or not exists (select 1 from auth.users u where u.id = p_user) or public._msgr2_blocked(uid, p_user) then
    raise exception 'msgr2_dm_unavailable' using errcode = '42501';
  end if;
  k := least(uid::text, p_user::text) || ':' || greatest(uid::text, p_user::text);
  if p_space is null then
    if not public._msgr2_friends(uid, p_user) then raise exception 'msgr2_dm_unavailable' using errcode = '42501'; end if;
    k := 'p:' || k;
    perform pg_advisory_xact_lock(hashtext('msgr2_dm:' || k));
    select * into r from public.msgr2_rooms where kind = 'direct' and pair_key = k;
    if r.id is null then
      sp := public.msgr2_my_personal_space();
      insert into public.msgr2_rooms (space_id, kind, pair_key, name, created_by) values (sp, 'direct', k, '', uid)
        on conflict (pair_key) where kind = 'direct' and pair_key like 'p:%' do nothing returning * into r;
      if r.id is null then select * into r from public.msgr2_rooms where kind = 'direct' and pair_key = k; else existing := false; end if;
    end if;
  else
    if public._msgr2_team_role(p_space, uid) is null or public._msgr2_team_role(p_space, p_user) is null then
      raise exception 'msgr2_dm_unavailable' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('msgr2_dm:' || p_space::text || ':' || k));
    select * into r from public.msgr2_rooms where space_id = p_space and kind = 'direct' and pair_key = k;
    if r.id is null then
      insert into public.msgr2_rooms (space_id, kind, pair_key, name, created_by) values (p_space, 'direct', k, '', uid)
        on conflict (space_id, pair_key) where kind = 'direct' do nothing returning * into r;
      if r.id is null then select * into r from public.msgr2_rooms where space_id = p_space and kind = 'direct' and pair_key = k; else existing := false; end if;
    end if;
  end if;
  if r.archived_at is not null then update public.msgr2_rooms set archived_at = null where id = r.id; end if;
  if public._msgr2_room_put(r.id, 'user', uid, uid) then wrote := true; end if;
  if public._msgr2_room_put(r.id, 'user', p_user, uid) then wrote := true; end if;
  if wrote or not existing then
    perform public._msgr2_send_u(uid, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', r.id));
    perform public._msgr2_send_u(p_user, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', r.id));
  end if;
  return jsonb_build_object('room_id', r.id, 'space_id', r.space_id, 'existing', existing);
end $$;

-- 내 에이전트와의 1:1: 앱 기기. 내 개인 공간의 비공개 방 중 활동 멤버가 정확히 나와 그 에이전트뿐인 방(가장 오래된 것), 없으면 만든다.
-- 반환 {room_id, space_id, existing}
create or replace function public.msgr2_agent_dm_open(p_agent uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); sp uuid; rid uuid;
begin
  perform public._msgr2_need_live();
  if not exists (select 1 from public.msgr2_agents a where a.id = p_agent and a.owner_user_id = uid and a.status = 'active') then
    raise exception 'msgr2_agent_not_allowed' using errcode = '42501';
  end if;
  sp := public.msgr2_my_personal_space();
  perform pg_advisory_xact_lock(hashtext('msgr2_agent_dm:' || p_agent::text));
  select r.id into rid from public.msgr2_rooms r
   where r.space_id = sp and r.kind = 'private' and r.archived_at is null
     and exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id = uid and m.removed_at is null)
     and exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'agent' and m.member_id = p_agent and m.removed_at is null)
     and not exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.removed_at is null
                       and not ((m.member_kind = 'user' and m.member_id = uid) or (m.member_kind = 'agent' and m.member_id = p_agent)))
   order by r.created_at, r.id limit 1;
  if rid is not null then return jsonb_build_object('room_id', rid, 'space_id', sp, 'existing', true); end if;
  insert into public.msgr2_rooms (space_id, kind, name, created_by) values (sp, 'private', '', uid) returning id into rid;
  perform public._msgr2_room_put(rid, 'user', uid, uid);
  perform public._msgr2_room_put(rid, 'agent', p_agent, uid);
  perform public._msgr2_send_u(uid, 'rooms', jsonb_build_object('space_id', sp, 'room_id', rid));
  return jsonb_build_object('room_id', rid, 'space_id', sp, 'existing', false);
end $$;

-- 방 멤버 넣기: 앱 기기. 사람은 msgr2_access(방).invite일 때만(1:1은 사람 고정), 팀은 활동 공간 멤버만, 개인은 수락한 친구(차단 아님)만.
-- 에이전트는 _msgr2_room_add_agent 규칙(1:1에도 넣을 수 있다). 반환 = 새로 넣거나 되살린 수.
create or replace function public.msgr2_room_members_add(p_room uuid, p_users uuid[] default '{}', p_agents uuid[] default '{}') returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); r public.msgr2_rooms; s public.msgr2_spaces; acc public.msgr2_access_t; users uuid[]; agents uuid[]; x uuid; n int := 0;
begin
  perform public._msgr2_need_live();
  acc := public.msgr2_access(p_room);
  if not coalesce(acc.read, false) then raise exception 'msgr2_room_not_found' using errcode = '42501'; end if;
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  users := coalesce((select array_agg(distinct u) from unnest(coalesce(p_users, '{}')) u where u is not null and u <> uid), '{}');
  agents := coalesce((select array_agg(distinct a) from unnest(coalesce(p_agents, '{}')) a where a is not null), '{}');
  if cardinality(users) > 100 or cardinality(agents) > 20 then raise exception 'msgr2_bad_room' using errcode = '22023'; end if;
  if cardinality(users) > 0 then
    if r.kind = 'direct' then raise exception 'msgr2_direct_fixed' using errcode = '42501'; end if;
    if not coalesce(acc.invite, false) then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
    if s.kind = 'team' then
      if exists (select 1 from unnest(users) u where public._msgr2_team_role(s.id, u) is null) then raise exception 'msgr2_not_space_member' using errcode = '42501'; end if;
    elsif exists (select 1 from unnest(users) u where not public._msgr2_friends(uid, u) or public._msgr2_blocked(uid, u)) then
      raise exception 'msgr2_not_friend' using errcode = '42501';
    end if;
    -- 새로 넣는 사람과 방의 사람(활동 중인 사람 멤버 + 부른 사람 + 함께 넣는 사람) 사이에 차단 관계가 있으면 거부
    if public._msgr2_blocked_among(users, users || uid || coalesce((select array_agg(m.member_id) from public.msgr2_room_members m
         where m.room_id = p_room and m.member_kind = 'user' and m.removed_at is null), '{}')) then
      raise exception 'msgr2_group_blocked_pair' using errcode = '42501';
    end if;
    foreach x in array users loop
      if public._msgr2_room_put(p_room, 'user', x, uid) then
        n := n + 1;
        perform public._msgr2_send_u(x, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', p_room));
      end if;
    end loop;
  end if;
  foreach x in array agents loop if public._msgr2_room_add_agent(p_room, x, uid) then n := n + 1; end if; end loop;
  return n;
end $$;

-- 방 멤버 빼기: 앱 기기. 사람: 1:1이 아니고 msgr2_access(방).manage일 때(나 자신은 msgr2_room_leave). 에이전트: 그 에이전트의 주인이거나 manage.
-- 빠진 사람이 더는 방을 못 읽으면 그 사람의 에이전트도 뺀다. 이미 빠졌으면 false.
create or replace function public.msgr2_room_member_remove(p_room uuid, p_kind text, p_member uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); acc public.msgr2_access_t := public.msgr2_access(p_room); r public.msgr2_rooms; n int;
begin
  if not coalesce(acc.read, false) then raise exception 'msgr2_room_not_found' using errcode = '42501'; end if;
  select * into r from public.msgr2_rooms where id = p_room;
  if p_kind = 'user' then
    if p_member = uid then raise exception 'msgr2_use_leave' using errcode = '22023'; end if;
    if r.kind = 'direct' or not coalesce(acc.manage, false) then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  elsif p_kind = 'agent' then
    if not coalesce(acc.manage, false) and not exists (select 1 from public.msgr2_agents a where a.id = p_member and a.owner_user_id = uid) then
      raise exception 'msgr2_forbidden' using errcode = '42501';
    end if;
  else
    raise exception 'msgr2_bad_kind' using errcode = '22023';
  end if;
  update public.msgr2_room_members set removed_at = now() where room_id = p_room and member_kind = p_kind and member_id = p_member and removed_at is null;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  if p_kind = 'user' then
    perform public._msgr2_room_drop_agents_of(p_room, p_member);
    perform public._msgr2_send_u(p_member, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', p_room, 'removed', true));
  end if;
  return true;
end $$;

-- 방 나가기: 앱 기기(1:1 포함 — 목록에서 숨김. 다시 열면 msgr2_dm_open이 되살린다). 나간 뒤 그 방을 못 읽으면 내 에이전트도 뺀다. 이미 나갔으면 false.
create or replace function public.msgr2_room_leave(p_room uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); n int;
begin
  update public.msgr2_room_members set removed_at = now() where room_id = p_room and member_kind = 'user' and member_id = uid and removed_at is null;
  get diagnostics n = row_count;
  if n = 0 then return false; end if;
  perform public._msgr2_room_drop_agents_of(p_room, uid);
  perform public._msgr2_send_u(uid, 'rooms', jsonb_build_object('room_id', p_room, 'removed', true));
  return true;
end $$;

-- 공개 방 참여: 앱 기기. 팀 open 방이고 읽을 수 있을 때(owner·admin·member). 이미 멤버면 false(쓰기 0).
create or replace function public.msgr2_room_join(p_room uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); r public.msgr2_rooms;
begin
  perform public._msgr2_need_live();
  select * into r from public.msgr2_rooms where id = p_room;
  if r.id is null or r.kind <> 'open' or r.archived_at is not null or not coalesce((public.msgr2_access(p_room)).read, false) then
    raise exception 'msgr2_room_not_found' using errcode = '42501';
  end if;
  if not public._msgr2_room_put(p_room, 'user', uid, uid) then return false; end if;
  perform public._msgr2_send_u(uid, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', p_room));
  return true;
end $$;

-- 공개 방 둘러보기: 유효한 기기. 팀 공간의 open 방(보관 안 됨) 중 읽을 수 있는 것. 손님·남에게는 빈 목록. 기본은 아직 안 들어간 방만. 500개까지.
create or replace function public.msgr2_rooms_browse(p_space uuid, p_include_joined boolean default false)
  returns table (id uuid, name text, members int, created_at timestamptz, joined boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device();
begin
  if coalesce(public._msgr2_team_role(p_space, uid), 'guest') = 'guest' then return; end if;
  return query
    select q.id, q.name, q.members, q.created_at, q.joined from (
      select r.id, r.name, r.created_at,
             (select count(*)::int from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.removed_at is null) as members,
             exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id = uid and m.removed_at is null) as joined
        from public.msgr2_rooms r
       where r.space_id = p_space and r.kind = 'open' and r.archived_at is null and coalesce((public.msgr2_access(r.id)).read, false)) q
     where p_include_joined or not q.joined
     order by q.created_at, q.id limit 500;
end $$;

-- ── 8. 안 읽음·읽음 표시·방 설정 ─────────────────────────────────────────────────
-- 방별 안 읽음: 유효한 기기. 내가 활동 멤버인 방(보관 안 됨, p_space로 좁힘) 중 읽을 수 있는 것. n = 내 읽음 뒤의 글 중
-- 지우지 않았고 시스템 글이 아니고 내 글이 아니고 내가 차단한 사람 글이 아닌 것(99에서 멈춘다 — 방마다 최대 99행만 훑는다).
-- last_id = 그 방 마지막 글 id(읽음 표시에 쓴다), muted = 내 음소거(합계에서 빼는 것은 화면). 중단 중이면 빈 결과. 쓰기 0. 방 1000개까지.
create or replace function public.msgr2_unread(p_space uuid default null)
  returns table (room_id uuid, space_id uuid, n int, last_id bigint, last_read_id bigint, muted boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); blocked uuid[] := public._msgr2_my_blocked(auth.uid());
begin
  if public._msgr2_paused() then return; end if;
  return query
    with mine as (
      select r.id, r.space_id from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id
       where m.member_kind = 'user' and m.member_id = uid and m.removed_at is null and r.archived_at is null and (p_space is null or r.space_id = p_space)
       order by r.id limit 1000)
    select mi.id, mi.space_id,
           (select count(*)::int from (select 1 from public.msgr2_messages x
              where x.room_id = mi.id and x.id > coalesce(rd.last_read_id, 0) and x.deleted_at is null and x.kind <> 'system'
                and x.author_user_id is distinct from uid and not coalesce(x.author_user_id = any (blocked), false)
              order by x.id desc limit 99) z),
           (select max(x.id) from public.msgr2_messages x where x.room_id = mi.id),
           coalesce(rd.last_read_id, 0),
           coalesce(p.muted, false)
      from mine mi
      left join public.msgr2_reads rd on rd.room_id = mi.id and rd.user_id = uid
      left join public.msgr2_prefs p on p.room_id = mi.id and p.user_id = uid
     where coalesce((public.msgr2_access(mi.id)).read, false);
end $$;

-- 읽음 행은 RPC로만(총괄 지시 2026-10-18): 휴대폰 알림(U7 #1081)이 "최근 60초 안의 읽음 갱신 = 보는 중"으로 알림을 빼므로 updated_at을 사람이 정하면 안 된다
-- (열을 빼고 upsert하면 처음 시각에 머물고, 미래 시각을 쓰면 그때까지 알림이 막힌다). U1의 사람 직접 쓰기(insert·update 권한 + for all 정책)를 걷고 읽기 정책만 둔다.
-- 사람 문맥(auth.uid() 있음)의 쓰기는 updated_at을 서버 시각으로 고정한다. 서비스 문맥(이전 U8)은 옛 시각을 그대로 넣는다(msgr2_insert_stamp와 같은 관례).
revoke insert, update on public.msgr2_reads from authenticated;
drop policy if exists msgr2_reads_own on public.msgr2_reads;
drop policy if exists msgr2_reads_select on public.msgr2_reads;
create policy msgr2_reads_select on public.msgr2_reads for select to authenticated
  using (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read));
create or replace function public.msgr2_reads_stamp() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then new.updated_at := now(); end if;
  return new;
end $$;
drop trigger if exists msgr2_reads_stamp on public.msgr2_reads;
create trigger msgr2_reads_stamp before insert or update on public.msgr2_reads for each row execute function public.msgr2_reads_stamp();

-- 읽음 표시: 유효한 기기 + 읽기. 값이 커질 때만 쓴다(그 방의 마지막 글 id를 넘지 않게). 반환 = 저장된 값.
create or replace function public.msgr2_mark_read(p_room uuid, p_last_id bigint) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); v bigint; cur bigint;
begin
  if not coalesce((public.msgr2_access(p_room)).read, false) then raise exception 'msgr2_room_not_found' using errcode = '42501'; end if;
  select last_read_id into cur from public.msgr2_reads where room_id = p_room and user_id = uid;
  v := least(p_last_id, (select max(x.id) from public.msgr2_messages x where x.room_id = p_room));
  if v is null or v <= coalesce(cur, 0) then return coalesce(cur, 0); end if;
  insert into public.msgr2_reads as t (room_id, user_id, last_read_id, updated_at) values (p_room, uid, v, now())
  on conflict (room_id, user_id) do update set last_read_id = excluded.last_read_id, updated_at = now() where t.last_read_id < excluded.last_read_id;
  return v;
end $$;

-- 방 알림 설정(음소거·고정): 유효한 기기 + 읽기. null = 그대로. 값이 바뀔 때만 쓴다(행이 없고 둘 다 기본값이면 쓰지 않는다). 반환 {muted, pinned}
create or replace function public.msgr2_room_pref_set(p_room uuid, p_muted boolean default null, p_pinned boolean default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); cur public.msgr2_prefs; mu boolean; pi boolean;
begin
  if not coalesce((public.msgr2_access(p_room)).read, false) then raise exception 'msgr2_room_not_found' using errcode = '42501'; end if;
  select * into cur from public.msgr2_prefs where room_id = p_room and user_id = uid;
  mu := coalesce(p_muted, cur.muted, false); pi := coalesce(p_pinned, cur.pinned, false);
  if cur.room_id is null then
    if mu or pi then insert into public.msgr2_prefs (room_id, user_id, muted, pinned) values (p_room, uid, mu, pi) on conflict do nothing; end if;
  elsif (cur.muted, cur.pinned) is distinct from (mu, pi) then
    update public.msgr2_prefs set muted = mu, pinned = pi, updated_at = now() where room_id = p_room and user_id = uid;
  end if;
  return jsonb_build_object('muted', mu, 'pinned', pi);
end $$;

-- ── 9. 개인 1:1 목록 ─────────────────────────────────────────────────────────────
-- 개인 공간(누구의 것이든)의 방 중 내가 활동 멤버이고 읽을 수 있는 1:1(direct). p_include_groups면 개인 공간의 비공개 방(친구 그룹·에이전트 1:1)도.
-- 개인 1:1은 처음 연 사람의 개인 공간에 있어 상대의 공간 목록(msgr2_rooms by space)에는 안 보인다 — 이 목록이 그 자리다.
-- other_user_id = 1:1 상대(pair_key에서), agent_id = 사람이 나 하나이고 에이전트가 하나인 방의 그 에이전트. 마지막 글(지우지 않은 사람·에이전트 글) 미리보기 200자.
-- 중단 중이면 빈 결과. 500개까지, 최근 글 순.
create or replace function public.msgr2_dm_list(p_include_groups boolean default false)
  returns table (room_id uuid, space_id uuid, kind text, name text, other_user_id uuid, other_name text, members jsonb, agent_id uuid,
                 last_id bigint, last_at timestamptz, last_body text, created_by uuid)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device();
begin
  if public._msgr2_paused() then return; end if;
  return query
    with rs as (
      select r.* from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id join public.msgr2_spaces s on s.id = r.space_id
       where m.member_kind = 'user' and m.member_id = uid and m.removed_at is null and r.archived_at is null and s.kind = 'personal' and s.deleted_at is null
         and (r.kind = 'direct' or (p_include_groups and r.kind = 'private'))
         and coalesce((public.msgr2_access(r.id)).read, false)
       limit 2000),
    o as (
      select rs.*,
             case when rs.kind = 'direct' then (select x::uuid from unnest(string_to_array(substr(rs.pair_key, 3), ':')) x where x <> uid::text limit 1) end as other,
             (select jsonb_agg(jsonb_build_object('kind', m.member_kind, 'id', m.member_id,
                       'name', case when m.member_kind = 'user' then public._msgr2_label(m.member_id)
                                    else (select coalesce(nullif(a.display_name, ''), a.slug) from public.msgr2_agents a where a.id = m.member_id) end) order by m.added_at, m.member_id)
                from public.msgr2_room_members m where m.room_id = rs.id and m.removed_at is null) as mem,
             (select case when count(*) filter (where m.member_kind = 'user') = 1 and count(*) filter (where m.member_kind = 'agent') = 1
                          then (array_agg(m.member_id) filter (where m.member_kind = 'agent'))[1] end
                from public.msgr2_room_members m where m.room_id = rs.id and m.removed_at is null) as ag,
             (select x from public.msgr2_messages x where x.room_id = rs.id and x.deleted_at is null and x.kind <> 'system' order by x.id desc limit 1) as lm
        from rs)
    select o.id, o.space_id, o.kind, o.name, o.other, case when o.other is not null then public._msgr2_label(o.other) end,
           coalesce(o.mem, '[]'::jsonb), o.ag, (o.lm).id, (o.lm).created_at, left((o.lm).body, 200), o.created_by
      from o
     order by (o.lm).id desc nulls last, o.created_at desc
     limit 500;
end $$;

-- ── 10. 검색(⌘K) ────────────────────────────────────────────────────────────────
-- 유효한 기기. 검색어 2~100자(앞뒤 공백 제외), 결과는 종류마다 p_limit(1~50, 기본 20)개.
-- 후보 방 = 내가 활동 멤버인 방 ∪ 내가 owner·admin·member인 팀 공간의 open 방(보관 안 됨), 그중 msgr2_access 읽기 — 최근 글 순 200개까지.
--   rooms: 이름 일치. messages: 후보 방마다 최근 300글 안에서(지우지 않은 사람·에이전트 글, 내가 차단한 사람 글 제외) 최신 순, 일치 주변 200자.
--   people: 나와 같은 활동 팀 공간의 활동 멤버 ∪ 수락한 친구 ∪ 내 후보 방의 사람(차단 관계 제외, 후보 2000명까지) 중 이름 일치.
--   agents: 내 에이전트 ∪ 내 활동 팀 공간에 파견된 에이전트 ∪ 후보 방의 에이전트(은퇴 제외) 중 이름·slug 일치.
-- 작업량 상한: 방 200 × 글 300 = 6만 행(PR 부하 절 실측). 쓰기 0. 중단 중이면 빈 결과 + paused.
create or replace function public.msgr2_search(p_q text, p_limit int default 20) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); q text := btrim(coalesce(p_q, '')); lim int := least(greatest(coalesce(p_limit, 20), 1), 50);
  pat text; rids uuid[]; blocked uuid[] := public._msgr2_my_blocked(auth.uid()); res jsonb;
  empty jsonb := jsonb_build_object('rooms', '[]'::jsonb, 'messages', '[]'::jsonb, 'people', '[]'::jsonb, 'agents', '[]'::jsonb);
begin
  if public._msgr2_paused() then return empty || jsonb_build_object('paused', true); end if;
  if char_length(q) not between 2 and 100 then return empty; end if;
  pat := '%' || replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  select coalesce(array_agg(c.id order by c.last desc nulls last), '{}') into rids from (
    select k.id, (select max(x.id) from public.msgr2_messages x where x.room_id = k.id) as last from (
      select m.room_id as id from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id
       where m.member_kind = 'user' and m.member_id = uid and m.removed_at is null and r.archived_at is null
      union
      select r.id from public.msgr2_rooms r join public.msgr2_space_members sm on sm.space_id = r.space_id and sm.user_id = uid and sm.removed_at is null
       where r.kind = 'open' and r.archived_at is null and sm.role in ('owner', 'admin', 'member')) k
     where coalesce((public.msgr2_access(k.id)).read, false)
     order by 2 desc nulls last limit 200) c;
  select jsonb_build_object(
    'rooms', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'space_id', r.space_id, 'kind', r.kind, 'name', r.name) order by r.name, r.id)
                         from (select * from public.msgr2_rooms r where r.id = any (rids) and r.name ilike pat order by r.name, r.id limit lim) r), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'room_id', w.room_id, 'author_kind', w.author_kind, 'author_user_id', w.author_user_id,
                            'author_agent_id', w.author_agent_id, 'created_at', w.created_at,
                            'snippet', substr(w.body, greatest(strpos(lower(w.body), lower(q)) - 60, 1), 200)) order by w.id desc)
                            from (select x.* from unnest(rids) rid
                                  cross join lateral (select y.id, y.room_id, y.author_kind, y.author_user_id, y.author_agent_id, y.created_at, y.body, y.deleted_at, y.kind
                                                        from public.msgr2_messages y where y.room_id = rid order by y.id desc limit 300) x
                                  where x.deleted_at is null and x.kind <> 'system' and x.body ilike pat and not coalesce(x.author_user_id = any (blocked), false)
                                  order by x.id desc limit lim) w), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('id', p.u, 'name', p.name, 'friend', p.friend) order by p.name, p.u)
                          from (select p0.* from (select c.u, public._msgr2_label(c.u) as name, public._msgr2_friends(uid, c.u) as friend from (
                                  select distinct u from (
                                    select o.user_id as u from public.msgr2_space_members me join public.msgr2_space_members o on o.space_id = me.space_id
                                      join public.msgr2_spaces s on s.id = me.space_id and s.kind = 'team' and s.deleted_at is null
                                     where me.user_id = uid and me.removed_at is null and (me.expires_at is null or me.expires_at > now())
                                       and o.removed_at is null and (o.expires_at is null or o.expires_at > now())
                                    union all
                                    select m.member_id from public.msgr2_room_members m where m.room_id = any (rids) and m.member_kind = 'user' and m.removed_at is null
                                    union all
                                    select unnest(public._msgr2_friend_ids(uid))) a
                                   where u <> uid limit 2000) c
                                 where not public._msgr2_blocked(uid, c.u)) p0
                                 where p0.name ilike pat order by p0.name, p0.u limit lim) p), '[]'::jsonb),
    'agents', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'owner_user_id', a.owner_user_id, 'name', coalesce(nullif(a.display_name, ''), a.slug), 'slug', a.slug)
                                         order by a.display_name, a.id)
                          from (select a.* from public.msgr2_agents a
                                 where a.status <> 'retired' and (a.display_name ilike pat or a.slug ilike pat)
                                   and (a.owner_user_id = uid
                                        or exists (select 1 from public.msgr2_agent_seats st join public.msgr2_space_members sm on sm.space_id = st.space_id
                                                    join public.msgr2_spaces s on s.id = st.space_id and s.deleted_at is null
                                                    where st.agent_id = a.id and st.removed_at is null and sm.user_id = uid and sm.removed_at is null
                                                      and (sm.expires_at is null or sm.expires_at > now()))
                                        or exists (select 1 from public.msgr2_room_members m where m.room_id = any (rids) and m.member_kind = 'agent' and m.member_id = a.id and m.removed_at is null))
                                 order by a.display_name, a.id limit lim) a), '[]'::jsonb))
    into res;
  return res;
end $$;

-- ── 11. 신고(v2 글) ─────────────────────────────────────────────────────────────
-- 옛 msgr_reports 표에 넣는다(운영자 신고함·알림 트리거 그대로). v2 신고는 channel_id = v2 방, org_id = null(옛 조직 관리자 목록에 v2 글이 섞이지 않게),
-- 팀 공간 관리자는 msgr2_reports_list·msgr2_report_resolve로 본다. 읽을 수 없는 글·없는 글·시스템 글은 같은 오류. 같은 글 반복 신고는 하나로.
create or replace function public.msgr2_report_message(p_message bigint, p_reason text default null) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); m public.msgr2_messages; rid uuid;
begin
  if to_regclass('public.msgr_reports') is null then raise exception 'msgr2_reports_unavailable' using errcode = '0A000'; end if;
  select * into m from public.msgr2_messages where id = p_message;
  if m.id is null or m.deleted_at is not null or m.author_kind = 'system' or not coalesce((public.msgr2_access(m.room_id)).read, false) then
    raise exception 'msgr2_report_no_message' using errcode = '22023';
  end if;
  if m.author_kind = 'user' and m.author_user_id = uid then raise exception 'msgr2_report_own' using errcode = '42501'; end if;
  select r.id into rid from public.msgr_reports r where r.message_id = m.id and r.channel_id = m.room_id and r.reporter_user_id = uid and r.status = 'open';
  if rid is not null then return rid; end if;
  insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id, author_user_id, author_crew_id, body_snapshot, reason)
  values (m.id, m.room_id, null, uid, m.author_user_id, null, left(m.body, 1000), nullif(left(btrim(coalesce(p_reason, '')), 500), ''))
  returning id into rid;
  return rid;
end $$;

-- 운영자인가(옛 표 msgr_report_operators — 없으면 거짓)
create or replace function public._msgr2_report_operator(p_uid uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if to_regclass('public.msgr_report_operators') is null then return false; end if;
  return exists (select 1 from public.msgr_report_operators o where o.user_id = p_uid);
end $$;

-- v2 방의 신고 목록: 유효한 기기. 내 신고 ∪ 내가 owner·admin인 팀 공간 방의 신고 ∪ 운영자는 전부. 500개까지.
create or replace function public.msgr2_reports_list()
  returns table (id uuid, message_id bigint, room_id uuid, space_id uuid, reporter_user_id uuid, author_user_id uuid, author_agent_id uuid,
                 reason text, status text, created_at timestamptz, message_body text, message_created_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_device(); op boolean := public._msgr2_report_operator(auth.uid());
begin
  if to_regclass('public.msgr_reports') is null then return; end if;
  return query
    select r.id, r.message_id, r.channel_id, rm.space_id, r.reporter_user_id, r.author_user_id, x.author_agent_id,
           r.reason, r.status, r.created_at, left(r.body_snapshot, 300), x.created_at
      from public.msgr_reports r
      join public.msgr2_rooms rm on rm.id = r.channel_id
      left join public.msgr2_messages x on x.id = r.message_id and x.room_id = r.channel_id
     where r.reporter_user_id = uid or op or coalesce(public._msgr2_team_role(rm.space_id, uid), '') in ('owner', 'admin')
     order by r.status, r.created_at desc limit 500;
end $$;

-- 처리: 앱 기기(runner 불가). 운영자, 또는 그 방이 팀 공간이고 내가 owner·admin. 개인 공간 신고는 운영자만(옛 규칙과 같다). 이미 처리됐으면 false.
create or replace function public.msgr2_report_resolve(p_report uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); sp uuid; n int;
begin
  if to_regclass('public.msgr_reports') is null then raise exception 'msgr2_report_not_found' using errcode = '22023'; end if;
  select rm.space_id into sp from public.msgr_reports r join public.msgr2_rooms rm on rm.id = r.channel_id where r.id = p_report;
  if sp is null then raise exception 'msgr2_report_not_found' using errcode = '22023'; end if;
  if not public._msgr2_report_operator(uid) and coalesce(public._msgr2_team_role(sp, uid), '') not in ('owner', 'admin') then
    raise exception 'msgr2_report_forbidden' using errcode = '42501';
  end if;
  update public.msgr_reports set status = 'resolved', resolved_by = uid, resolved_at = now() where id = p_report and status = 'open';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ── 12. 실행 권한 ───────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array[
    '_msgr2_need_app()', '_msgr2_need_device()', '_msgr2_need_live()', '_msgr2_live()', '_msgr2_team_role(uuid, uuid)', '_msgr2_blocked(uuid, uuid)',
    '_msgr2_friends(uuid, uuid)', '_msgr2_friend_ids(uuid)', '_msgr2_my_blocked(uuid)', '_msgr2_label(uuid)', '_msgr2_room_put(uuid, text, uuid, uuid)',
    '_msgr2_room_add_agent(uuid, uuid, uuid)', '_msgr2_room_drop_agents_of(uuid, uuid)', '_msgr2_space_drop(uuid, uuid)', '_msgr2_space_close(uuid, uuid)',
    '_msgr2_blocked_among(uuid[], uuid[])', '_msgr2_room_put_new(uuid, uuid, uuid)', '_msgr2_org_delete_guard()', '_msgr2_pause_pass(text, jsonb)',
    '_msgr2_mirror_org(uuid, text, uuid)', '_msgr2_ref_check()', '_msgr2_ref_old_deleted()', '_msgr2_invite_state(public.msgr2_space_invites)',
    '_msgr2_report_operator(uuid)', 'msgr2_reads_stamp()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'msgr2_space_create(text, text)', 'msgr2_space_leave(uuid)', 'msgr2_space_member_remove(uuid, uuid)',
    'msgr2_invite_create(uuid, text, uuid, uuid[], integer, integer, integer)', 'msgr2_invite_preview(text)', 'msgr2_invite_accept(text)',
    'msgr2_invite_decline(text)', 'msgr2_invite_revoke(uuid)', 'msgr2_invites_list(uuid)', 'msgr2_my_invites()',
    'msgr2_room_create(uuid, text, text, uuid[], uuid[])', 'msgr2_dm_open(uuid, uuid)', 'msgr2_agent_dm_open(uuid)',
    'msgr2_room_members_add(uuid, uuid[], uuid[])', 'msgr2_room_member_remove(uuid, text, uuid)', 'msgr2_room_leave(uuid)', 'msgr2_room_join(uuid)',
    'msgr2_rooms_browse(uuid, boolean)', 'msgr2_unread(uuid)', 'msgr2_mark_read(uuid, bigint)', 'msgr2_room_pref_set(uuid, boolean, boolean)',
    'msgr2_dm_list(boolean)', 'msgr2_search(text, integer)', 'msgr2_report_message(bigint, text)', 'msgr2_reports_list()', 'msgr2_report_resolve(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
