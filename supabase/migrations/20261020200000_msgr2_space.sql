-- 메신저 v2 U1 — 공간·방·에이전트·판정 함수·RLS(설계 정본: AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md 0절 D1~D4·D9·D12, 1절, 6절, 7절 6·7·15·19·26).
-- 원칙
--   D1 개인 공간 = kind 'personal' 공간(1인 1개). 모든 방은 space_id NOT NULL — `org_id is null` 분기가 없다.
--   D2 새 표 msgr2_*. 옛 msgr_* 표는 손대지 않는다(이 파일은 옛 표를 읽지도 쓰지도 않는다). id 보존 이전은 U8.
--   D3 에이전트 = msgr2_agents 1행(주인·회사·slug). 팀 공간에는 파견 행(msgr2_agent_seats)만 둔다. 개인 공간 자리는 행 없이 늘 있다고 본다.
--   D4 토픽은 일 단위(work_id 유일). 사람 대화에는 토픽을 강제하지 않는다. 토픽 쓰기는 U2(일·약속 서버)가 정의한다 — 여기서는 표와 읽기 정책만.
--   1-5 판정 함수는 msgr2_access(room) 하나다. 표 정책·RPC는 이 함수만 부르고 멤버십 식을 다시 쓰지 않는다.
--       기기 확인 _msgr2_device_ok()·앱 기기 확인 _msgr2_device_app()은 U3가 정의한다 — 이 파일은 그 이름의 함수가 없을 때만 닫힌 자리 함수(늘 거짓)를 만든다.
--       U3 뒤에 이 파일이 다시 적용돼도(제자리 수정 뒤 재적용·반복 적용) U3 정의를 덮지 않는다. U3 전에는 v2가 닫혀 있다(공개 전이라 손해 없음).
--       U3 마이그레이션이 같은 이름으로 create or replace 한다(시그니처: () returns boolean, security definer, stable, search_path public, pg_temp).
--   D9 권한 표(space_members 역할·agent_seats·rooms.agent_policy)에는 직접 쓰기 정책이 없다. 앱 기기만 부를 수 있는 RPC로만 바꾼다.
--   D12 등급(tier) owner·team·guest는 방의 사람 구성으로 정한다(보는 사람과 무관). 판정 결과에 함께 싣는다.
-- 함정(6절): 이 파일은 지우는 SQL을 넣지 않는다. 기억 데이터(msgr2_messages)는 계정 삭제·정리로 cascade 되지 않게 auth.users FK를 두지 않는다(계정 삭제는 U8 새 함수).
-- 멱등: if not exists / create or replace / drop policy if exists / drop trigger if exists.
-- 시험: test/msgr2-access-matrix-pg.test.mjs(행렬), test/msgr2-access-rpc-pg.test.mjs(RPC·잠금·유휴 쓰기 0) — bash scripts/billing-pg-drill.sh <파일>.

create extension if not exists pgcrypto;

-- ── 표 ──────────────────────────────────────────────────────────────────────────
create table if not exists public.msgr2_spaces (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('personal', 'team')),
  name text not null default '',
  slug text,
  owner_user_id uuid not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists msgr2_spaces_personal_one on public.msgr2_spaces (owner_user_id) where kind = 'personal'; -- D1: 개인 공간 1인 1개
create unique index if not exists msgr2_spaces_slug on public.msgr2_spaces (slug) where slug is not null;

create table if not exists public.msgr2_space_members (
  space_id uuid not null references public.msgr2_spaces (id),
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  display_name text,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,
  expires_at timestamptz,
  primary key (space_id, user_id)
);
create index if not exists msgr2_space_members_user on public.msgr2_space_members (user_id) where removed_at is null;

create table if not exists public.msgr2_rooms (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.msgr2_spaces (id),
  kind text not null check (kind in ('open', 'private', 'direct')),
  pair_key text,
  name text not null default '',
  memory boolean not null default true,
  agent_policy text not null default 'allowed' check (agent_policy in ('allowed', 'approval', 'blocked')),
  created_by uuid,
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((kind = 'direct') = (pair_key is not null))
);
create index if not exists msgr2_rooms_space on public.msgr2_rooms (space_id);
create unique index if not exists msgr2_rooms_pair on public.msgr2_rooms (space_id, pair_key) where kind = 'direct';

create table if not exists public.msgr2_room_members (
  room_id uuid not null references public.msgr2_rooms (id),
  member_kind text not null check (member_kind in ('user', 'agent')),
  member_id uuid not null,
  added_by uuid,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (room_id, member_kind, member_id)
);
create index if not exists msgr2_room_members_member on public.msgr2_room_members (member_kind, member_id) where removed_at is null;

create table if not exists public.msgr2_agents (
  id uuid primary key default gen_random_uuid(), -- 이전(U8) 때 msgr_agents.id를 그대로 넣는다
  owner_user_id uuid not null,
  ws_id text not null,
  slug text not null,
  display_name text not null default '',
  role_text text not null default '',
  face jsonb,
  hosting text not null default 'local' check (hosting in ('local', 'bot')),
  status text not null default 'active' check (status in ('active', 'paused', 'retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_user_id, ws_id, slug)
);

create table if not exists public.msgr2_agent_seats (
  agent_id uuid not null references public.msgr2_agents (id),
  space_id uuid not null references public.msgr2_spaces (id),
  allow text not null default 'all' check (allow in ('all', 'list', 'owner')),
  allow_users uuid[] not null default '{}',
  added_by uuid,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  primary key (agent_id, space_id)
);
create index if not exists msgr2_agent_seats_space on public.msgr2_agent_seats (space_id) where removed_at is null;

create table if not exists public.msgr2_topics (
  id uuid primary key default gen_random_uuid(), -- 새 표라 uuid(약속 v1 data.topic = uuid). 글 id는 옛 id 보존이라 bigint 그대로
  room_id uuid not null references public.msgr2_rooms (id),
  title text not null default '',
  status text not null default 'open' check (status in ('open', 'resolved')),
  work_id uuid unique, -- D4: 일 1건 = 토픽 1개
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists msgr2_topics_room on public.msgr2_topics (room_id);

create table if not exists public.msgr2_messages (
  id bigint generated by default as identity primary key, -- 이전(U8)은 옛 글 id를 그대로 넣고 identity를 최댓값+1로 맞춘다
  room_id uuid not null references public.msgr2_rooms (id),
  topic_id uuid references public.msgr2_topics (id),
  author_kind text not null check (author_kind in ('user', 'agent', 'system')),
  author_user_id uuid,
  author_agent_id uuid references public.msgr2_agents (id),
  kind text not null default 'text' check (kind in ('text', 'card', 'system')),
  body text not null default '',
  meta jsonb not null default '{}'::jsonb, -- D15: 시스템 글은 코드 + 값
  reply_to bigint,
  client_msg_id text,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  check (author_kind <> 'user' or (author_user_id is not null and author_agent_id is null)),
  check (author_kind <> 'agent' or author_agent_id is not null),
  check (author_kind <> 'system' or (author_user_id is null and author_agent_id is null))
);
create index if not exists msgr2_messages_room on public.msgr2_messages (room_id, id);
create index if not exists msgr2_messages_topic on public.msgr2_messages (topic_id, id) where topic_id is not null;
create unique index if not exists msgr2_messages_client on public.msgr2_messages (room_id, client_msg_id) where client_msg_id is not null;

create table if not exists public.msgr2_attachments (
  id bigint generated by default as identity primary key,
  message_id bigint not null references public.msgr2_messages (id),
  room_id uuid not null references public.msgr2_rooms (id),
  storage_path text not null, -- 이전 때 옛 경로를 그대로 쓴다(파일은 옮기지 않는다 — 6절 sweep 함정은 U8)
  name text not null default '',
  mime text,
  bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists msgr2_attachments_message on public.msgr2_attachments (message_id);
create index if not exists msgr2_attachments_path on public.msgr2_attachments (storage_path);

create table if not exists public.msgr2_reads (
  room_id uuid not null references public.msgr2_rooms (id),
  user_id uuid not null,
  last_read_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.msgr2_reactions (
  message_id bigint not null references public.msgr2_messages (id),
  user_id uuid not null,
  emoji text not null check (length(emoji) between 1 and 32),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create table if not exists public.msgr2_prefs (
  room_id uuid not null references public.msgr2_rooms (id),
  user_id uuid not null,
  muted boolean not null default false,
  pinned boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- ── 기기 확인 자리 함수(U3가 같은 이름·시그니처로 다시 정의한다) ─────────────────
-- _msgr2_device_ok(): 지금 요청한 기기가 유효한가(폐기·만료가 아닌가). 거짓이면 모든 판정이 거짓이다(1-5 원칙 4).
-- _msgr2_device_app(): 지금 요청한 기기가 앱(kind 'app') 기기인가. 권한 표를 바꾸는 RPC 첫 줄이 부른다(D9).
-- 없을 때만 만든다 — create or replace로 두면 U3 뒤 재적용이 기기 검사를 모든 RLS·RPC에서 한꺼번에 지운다.
do $do$ begin
  if to_regprocedure('public._msgr2_device_ok()') is null then
    create function public._msgr2_device_ok() returns boolean
      language sql stable security definer set search_path = public, pg_temp as $$ select false $$;
  end if;
  if to_regprocedure('public._msgr2_device_app()') is null then
    create function public._msgr2_device_app() returns boolean
      language sql stable security definer set search_path = public, pg_temp as $$ select false $$;
  end if;
end $do$;

-- ── 판정 함수 ────────────────────────────────────────────────────────────────────
do $$ begin
  if not exists (select from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typname = 'msgr2_access_t') then
    create type public.msgr2_access_t as (read boolean, write boolean, invite boolean, manage boolean, decide boolean, tier text);
  end if;
end $$;

-- 판정 규칙(1-5 원칙 2):
--   팀 공간: 활동 중인 공간 멤버(removed_at 없음, expires_at 없거나 미래)여야 한다. open 방은 owner·admin·member가 들어가고, 그 밖(손님·private·direct)은 방 멤버여야 한다.
--   개인 공간: 활동 중인 방 멤버만으로 판정한다(개인 공간의 멤버는 주인 하나).
--   read = 들어갈 수 있다 · write = read + 보관 안 된 방 · invite = read + direct 아님 + 보관 안 됨 + (팀: owner·admin·member / 개인: 공간 주인)
--   manage = read + direct 아님 + (팀: owner·admin / 개인: 공간 주인) · decide = read + (팀: owner·admin / 개인: 공간 주인)
--   tier(방의 사람 구성): 사람이 공간 주인뿐이면 owner, 팀 공간이고 손님 역할이 없으면 team, 그 밖은 guest. read가 거짓이면 null(구성을 흘리지 않는다).
--     팀 방의 사람은 활동 중인 공간 멤버만 센다(공간 밖 방 멤버는 판정에서 이미 못 들어온다 — 팀 private·direct도 공간 멤버 + 방 멤버, 설계 1-5 원칙 2보다 좁은 쪽).
--   삭제된 공간·없는 방·로그인 없음·기기 무효는 모두 거짓.
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

-- 공간을 볼 수 있나(공간·멤버·파견 행 읽기) — 활동 중인 멤버이거나 공간 주인. 기기 무효면 거짓.
create or replace function public._msgr2_space_visible(p_space uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and public._msgr2_device_ok() and exists (
    select 1 from public.msgr2_spaces s where s.id = p_space and s.deleted_at is null and (
      s.owner_user_id = auth.uid()
      or exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id = auth.uid() and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))))
$$;

-- 에이전트 행을 볼 수 있나 — 주인이거나, 읽을 수 있는 방의 멤버이거나, 볼 수 있는 팀 공간에 파견돼 있다.
create or replace function public._msgr2_agent_visible(p_agent uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and public._msgr2_device_ok() and (
    exists (select 1 from public.msgr2_agents a where a.id = p_agent and a.owner_user_id = auth.uid())
    or exists (select 1 from public.msgr2_agent_seats st where st.agent_id = p_agent and st.removed_at is null and public._msgr2_space_visible(st.space_id))
    or exists (select 1 from public.msgr2_room_members m where m.member_kind = 'agent' and m.member_id = p_agent and m.removed_at is null and (public.msgr2_access(m.room_id)).read))
$$;

revoke all on function public.msgr2_access(uuid) from public, anon;
revoke all on function public._msgr2_space_visible(uuid) from public, anon;
revoke all on function public._msgr2_agent_visible(uuid) from public, anon;
revoke all on function public._msgr2_device_ok() from public, anon;
revoke all on function public._msgr2_device_app() from public, anon;
grant execute on function public.msgr2_access(uuid) to authenticated, service_role;
grant execute on function public._msgr2_space_visible(uuid) to authenticated, service_role;
grant execute on function public._msgr2_agent_visible(uuid) to authenticated, service_role;
grant execute on function public._msgr2_device_ok() to authenticated, service_role;
grant execute on function public._msgr2_device_app() to authenticated, service_role;

-- ── 잠금 트리거(1-5 원칙 5) ─────────────────────────────────────────────────────
-- 소속 열을 같은 UPDATE에서 바꾸면 다른 공간·방으로 옮길 수 있다 — old 값을 보는 트리거로 막는다(msgr_lock_cols와 같은 계약, 옛 함수에 기대지 않게 따로 둔다).
-- 서비스 문맥(auth.uid() 없음 — 운영 도구·이전 함수)과 다른 트리거 안의 갱신은 통과한다.
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
drop trigger if exists msgr2_lock on public.msgr2_spaces;
create trigger msgr2_lock before update on public.msgr2_spaces for each row execute function public.msgr2_lock_cols('id', 'kind', 'owner_user_id', 'created_at');
drop trigger if exists msgr2_lock on public.msgr2_space_members;
create trigger msgr2_lock before update on public.msgr2_space_members for each row execute function public.msgr2_lock_cols('space_id', 'user_id', 'joined_at');
drop trigger if exists msgr2_lock on public.msgr2_rooms;
create trigger msgr2_lock before update on public.msgr2_rooms for each row execute function public.msgr2_lock_cols('id', 'space_id', 'kind', 'pair_key', 'created_by', 'created_at');
drop trigger if exists msgr2_lock on public.msgr2_room_members;
create trigger msgr2_lock before update on public.msgr2_room_members for each row execute function public.msgr2_lock_cols('room_id', 'member_kind', 'member_id', 'added_at');
drop trigger if exists msgr2_lock on public.msgr2_agents;
create trigger msgr2_lock before update on public.msgr2_agents for each row execute function public.msgr2_lock_cols('id', 'owner_user_id', 'ws_id', 'slug', 'created_at');
drop trigger if exists msgr2_lock on public.msgr2_agent_seats;
create trigger msgr2_lock before update on public.msgr2_agent_seats for each row execute function public.msgr2_lock_cols('agent_id', 'space_id');
drop trigger if exists msgr2_lock on public.msgr2_topics;
create trigger msgr2_lock before update on public.msgr2_topics for each row execute function public.msgr2_lock_cols('id', 'room_id', 'work_id', 'created_at');
drop trigger if exists msgr2_lock on public.msgr2_messages;
create trigger msgr2_lock before update on public.msgr2_messages for each row execute function public.msgr2_lock_cols('id', 'room_id', 'topic_id', 'author_kind', 'author_user_id', 'author_agent_id', 'kind', 'client_msg_id', 'created_at');
drop trigger if exists msgr2_lock on public.msgr2_attachments;
create trigger msgr2_lock before update on public.msgr2_attachments for each row execute function public.msgr2_lock_cols('id', 'message_id', 'room_id', 'storage_path');
drop trigger if exists msgr2_lock on public.msgr2_reads;
create trigger msgr2_lock before update on public.msgr2_reads for each row execute function public.msgr2_lock_cols('room_id', 'user_id');
drop trigger if exists msgr2_lock on public.msgr2_prefs;
create trigger msgr2_lock before update on public.msgr2_prefs for each row execute function public.msgr2_lock_cols('room_id', 'user_id');

-- 글의 토픽·첨부의 방이 같은 방인가(소속 열을 섞어 다른 방의 토픽·글에 붙이지 못하게) — 넣을 때 본다(바꾸기는 위 잠금이 막는다)
create or replace function public.msgr2_same_room() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_table_name = 'msgr2_messages' then
    if new.topic_id is not null and not exists (select 1 from public.msgr2_topics t where t.id = new.topic_id and t.room_id = new.room_id) then
      raise exception 'msgr2_topic_room_mismatch' using errcode = '42501'; end if;
  elsif tg_table_name = 'msgr2_attachments' then
    if not exists (select 1 from public.msgr2_messages m where m.id = new.message_id and m.room_id = new.room_id) then
      raise exception 'msgr2_attachment_room_mismatch' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
drop trigger if exists msgr2_same_room on public.msgr2_messages;
create trigger msgr2_same_room before insert on public.msgr2_messages for each row execute function public.msgr2_same_room();
drop trigger if exists msgr2_same_room on public.msgr2_attachments;
create trigger msgr2_same_room before insert on public.msgr2_attachments for each row execute function public.msgr2_same_room();

-- 사람 문맥(auth.uid() 있음 — 사람이 부른 RPC 안)에서 넣는 글은 시각을 서버가 정하고, 첨부 경로는 그 방 폴더만(검수 1 지적 1~3).
-- 서비스 문맥(이전 U8)은 옛 시각·옛 경로를 그대로 보존해 넣는다. 작성자 열은 바꾸지 않는다 — 남의 이름으로 넣으면 정책이 거부해야 하므로(조용히 고치지 않는다).
create or replace function public.msgr2_insert_stamp() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'msgr2_messages' then
    new.created_at := now();
  elsif tg_table_name = 'msgr2_attachments' then
    new.created_at := now();
    if new.storage_path not like 'msgr/' || (select r.space_id::text from public.msgr2_rooms r where r.id = new.room_id) || '/' || new.room_id::text || '/%'
       or new.storage_path like '%..%' or new.storage_path like '%//%' then
      raise exception 'msgr2_attachment_path' using errcode = '42501'; end if;
  end if;
  return new;
end $$;
drop trigger if exists msgr2_insert_stamp on public.msgr2_messages;
create trigger msgr2_insert_stamp before insert on public.msgr2_messages for each row execute function public.msgr2_insert_stamp();
drop trigger if exists msgr2_insert_stamp on public.msgr2_attachments;
create trigger msgr2_insert_stamp before insert on public.msgr2_attachments for each row execute function public.msgr2_insert_stamp();

-- 파견은 팀 공간에만(D3 — 개인 공간 자리는 행 없이 늘 있다)
create or replace function public.msgr2_seat_team_only() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from public.msgr2_spaces s where s.id = new.space_id and s.kind = 'team') then
    raise exception 'msgr2_seat_team_only' using errcode = '22023'; end if;
  return new;
end $$;
drop trigger if exists msgr2_seat_team_only on public.msgr2_agent_seats;
create trigger msgr2_seat_team_only before insert on public.msgr2_agent_seats for each row execute function public.msgr2_seat_team_only();

-- ── RLS ─────────────────────────────────────────────────────────────────────────
alter table public.msgr2_spaces enable row level security;
alter table public.msgr2_space_members enable row level security;
alter table public.msgr2_rooms enable row level security;
alter table public.msgr2_room_members enable row level security;
alter table public.msgr2_agents enable row level security;
alter table public.msgr2_agent_seats enable row level security;
alter table public.msgr2_topics enable row level security;
alter table public.msgr2_messages enable row level security;
alter table public.msgr2_attachments enable row level security;
alter table public.msgr2_reads enable row level security;
alter table public.msgr2_reactions enable row level security;
alter table public.msgr2_prefs enable row level security;

revoke all on public.msgr2_spaces, public.msgr2_space_members, public.msgr2_rooms, public.msgr2_room_members, public.msgr2_agents, public.msgr2_agent_seats,
  public.msgr2_topics, public.msgr2_messages, public.msgr2_attachments, public.msgr2_reads, public.msgr2_reactions, public.msgr2_prefs from anon, authenticated;
grant select on public.msgr2_spaces, public.msgr2_space_members, public.msgr2_rooms, public.msgr2_room_members, public.msgr2_agents, public.msgr2_agent_seats,
  public.msgr2_topics, public.msgr2_messages, public.msgr2_attachments, public.msgr2_reads, public.msgr2_reactions, public.msgr2_prefs to authenticated;
-- 사람이 직접 쓰는 것은 글·읽음·반응·설정뿐이다. 공간·멤버·방·방 멤버·에이전트·파견·토픽은 RPC(이 파일·U2)로만 쓴다.
-- 글·첨부는 열 단위로만 연다(검수 1 #1070 지적 1·2): id(identity)를 사람이 정하면 앞으로 쓸 id를 선점해 모든 사람의 다음 글이 pkey 충돌로 실패하고,
-- created_at·edited_at·deleted_at을 정하면 기록 날짜를 꾸민다. 이 열들은 기본값만 쓴다. 이전(U8, 서비스 문맥)은 표 권한으로 id를 보존해 넣는다.
grant insert (room_id, topic_id, author_kind, author_user_id, kind, body, meta, reply_to, client_msg_id) on public.msgr2_messages to authenticated;
-- 첨부 행은 사람이 직접 넣지 않는다(검수 1 지적 3, 총괄 결정): 업로드 슬롯 RPC(U2·U6)가 경로(msgr/<공간>/<방>/<uuid>)를 정해 넣는다. 아래 msgr2_attachment_path 트리거가 경로를 검사한다.
grant insert, update on public.msgr2_reads, public.msgr2_prefs to authenticated;
grant insert, delete on public.msgr2_reactions to authenticated;

-- 글이 그 방의 글인가 — 글 넣기 정책의 답글 확인(정책 안에서 같은 표를 읽으면 정책이 재귀한다). 존재 여부만 돌려주고 내용은 돌려주지 않는다.
create or replace function public._msgr2_msg_in_room(p_msg bigint, p_room uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr2_messages m where m.id = p_msg and m.room_id = p_room)
$$;
revoke all on function public._msgr2_msg_in_room(bigint, uuid) from public, anon;
grant execute on function public._msgr2_msg_in_room(bigint, uuid) to authenticated, service_role;

drop policy if exists msgr2_spaces_select on public.msgr2_spaces;
create policy msgr2_spaces_select on public.msgr2_spaces for select to authenticated using ((select public._msgr2_space_visible(id)));
drop policy if exists msgr2_space_members_select on public.msgr2_space_members;
create policy msgr2_space_members_select on public.msgr2_space_members for select to authenticated using ((select public._msgr2_space_visible(space_id)));
drop policy if exists msgr2_rooms_select on public.msgr2_rooms;
create policy msgr2_rooms_select on public.msgr2_rooms for select to authenticated using ((select (public.msgr2_access(id)).read));
drop policy if exists msgr2_room_members_select on public.msgr2_room_members;
create policy msgr2_room_members_select on public.msgr2_room_members for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_agents_select on public.msgr2_agents;
create policy msgr2_agents_select on public.msgr2_agents for select to authenticated using ((select public._msgr2_agent_visible(id)));
drop policy if exists msgr2_agent_seats_select on public.msgr2_agent_seats;
create policy msgr2_agent_seats_select on public.msgr2_agent_seats for select to authenticated using ((select public._msgr2_space_visible(space_id)));
drop policy if exists msgr2_topics_select on public.msgr2_topics;
create policy msgr2_topics_select on public.msgr2_topics for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_messages_select on public.msgr2_messages;
create policy msgr2_messages_select on public.msgr2_messages for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_messages_insert on public.msgr2_messages;
-- 사람 글만(에이전트·시스템 글은 U2 서버 함수가 쓴다). 토픽 글은 같은 방의 토픽만(msgr2_same_room 트리거).
-- meta는 비운다 — 시스템 글 코드(D15 meta.code)를 사람 글이 흉내 내지 못하게(검수 1 지적 2). 답글은 같은 방의 글에만.
create policy msgr2_messages_insert on public.msgr2_messages for insert to authenticated with check (
  author_kind = 'user' and author_user_id = (select auth.uid()) and author_agent_id is null and kind = 'text'
  and deleted_at is null and edited_at is null and meta = '{}'::jsonb
  and (reply_to is null or (select public._msgr2_msg_in_room(reply_to, room_id)))
  and (select (public.msgr2_access(room_id)).write));
drop policy if exists msgr2_attachments_select on public.msgr2_attachments;
create policy msgr2_attachments_select on public.msgr2_attachments for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_attachments_insert on public.msgr2_attachments; -- 사람 직접 넣기 없음(위 권한 참고)
drop policy if exists msgr2_reads_own on public.msgr2_reads;
create policy msgr2_reads_own on public.msgr2_reads for all to authenticated
  using (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read))
  with check (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_prefs_own on public.msgr2_prefs;
create policy msgr2_prefs_own on public.msgr2_prefs for all to authenticated
  using (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read))
  with check (user_id = (select auth.uid()) and (select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_reactions_select on public.msgr2_reactions;
create policy msgr2_reactions_select on public.msgr2_reactions for select to authenticated
  using (exists (select 1 from public.msgr2_messages m where m.id = message_id and (select (public.msgr2_access(m.room_id)).read)));
drop policy if exists msgr2_reactions_own on public.msgr2_reactions;
create policy msgr2_reactions_own on public.msgr2_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.msgr2_messages m where m.id = message_id and (select (public.msgr2_access(m.room_id)).write)));
drop policy if exists msgr2_reactions_unreact on public.msgr2_reactions;
create policy msgr2_reactions_unreact on public.msgr2_reactions for delete to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.msgr2_messages m where m.id = message_id and (select (public.msgr2_access(m.room_id)).write)));

-- ── RPC ─────────────────────────────────────────────────────────────────────────
-- 개인 공간(경우 표 6): 없으면 만들고 있으면 그대로 — 두 번째 부름은 쓰기 0. 주인 멤버 행도 함께(없을 때만).
create or replace function public.msgr2_my_personal_space() returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); sid uuid;
begin
  if uid is null then raise exception 'msgr2_signin_required' using errcode = '42501'; end if;
  if not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  select id into sid from public.msgr2_spaces where owner_user_id = uid and kind = 'personal';
  if sid is null then
    insert into public.msgr2_spaces (kind, owner_user_id) values ('personal', uid)
      on conflict (owner_user_id) where kind = 'personal' do nothing returning id into sid;
    if sid is null then select id into sid from public.msgr2_spaces where owner_user_id = uid and kind = 'personal'; end if; -- 동시 부름이 먼저 만들었다
  end if;
  if not exists (select 1 from public.msgr2_space_members where space_id = sid and user_id = uid) then
    insert into public.msgr2_space_members (space_id, user_id, role) values (sid, uid, 'owner') on conflict do nothing;
  end if;
  return sid;
end $$;

-- 에이전트 등록(1-3, 경우 표 7): 본체가 로컬 에이전트 목록을 보낸다. 값이 바뀐 행만 쓴다(IS DISTINCT FROM) — 두 번째 동기화의 쓰기는 0.
-- 주인 = 부른 사람(받은 값의 주인 필드는 보지 않는다). 목록에 없는 행은 지우지 않는다(은퇴는 status로). 돌려주는 값 = 새로 넣거나 바꾼 행 수.
-- 앱 기기만으로 묶지 않는다 — 본체(runner 기기)가 부르는 입구다. 기기 유효성만 본다.
create or replace function public.msgr2_agent_sync(p_agents jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n integer := 0; k integer; a jsonb;
begin
  if uid is null then raise exception 'msgr2_signin_required' using errcode = '42501'; end if;
  if not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if jsonb_typeof(p_agents) is distinct from 'array' or jsonb_array_length(p_agents) > 500 then raise exception 'msgr2_bad_agents' using errcode = '22023'; end if;
  for a in select * from jsonb_array_elements(p_agents) loop
    if coalesce(a->>'ws_id', '') = '' or coalesce(a->>'slug', '') = '' then raise exception 'msgr2_bad_agents' using errcode = '22023'; end if;
    insert into public.msgr2_agents as t (owner_user_id, ws_id, slug, display_name, role_text, face, hosting, status)
    values (uid, a->>'ws_id', a->>'slug', left(coalesce(a->>'display_name', ''), 80), left(coalesce(a->>'role_text', ''), 200), a->'face',
      coalesce(a->>'hosting', 'local'), coalesce(a->>'status', 'active'))
    on conflict (owner_user_id, ws_id, slug) do update set
      display_name = excluded.display_name, role_text = excluded.role_text, face = excluded.face, hosting = excluded.hosting, status = excluded.status, updated_at = now()
    where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from (excluded.display_name, excluded.role_text, excluded.face, excluded.hosting, excluded.status);
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;

-- 공간 멤버 역할 바꾸기(D9): 앱 기기만, 팀 공간의 owner·admin만. owner 역할은 주거나 빼앗지 못한다(주인 이전은 별도). admin은 다른 admin·owner를 바꾸지 못한다.
create or replace function public.msgr2_set_member_role(p_space uuid, p_user uuid, p_role text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); me text; them text;
begin
  if uid is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if p_role not in ('admin', 'member', 'guest') then raise exception 'msgr2_bad_role' using errcode = '22023'; end if;
  if not exists (select 1 from public.msgr2_spaces where id = p_space and kind = 'team' and deleted_at is null) then raise exception 'msgr2_team_only' using errcode = '42501'; end if;
  select role into me from public.msgr2_space_members where space_id = p_space and user_id = uid and removed_at is null and (expires_at is null or expires_at > now());
  select role into them from public.msgr2_space_members where space_id = p_space and user_id = p_user and removed_at is null;
  if me is null or me not in ('owner', 'admin') or them is null or them = 'owner' or (me = 'admin' and them = 'admin') or (me = 'admin' and p_role = 'admin') then
    raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  update public.msgr2_space_members set role = p_role where space_id = p_space and user_id = p_user and role is distinct from p_role;
end $$;

-- 파견 행(D3·D9): 앱 기기만, 그 에이전트의 주인이고 그 팀 공간의 손님 아닌 활동 멤버일 때. p_remove면 removed_at을 찍는다(지우지 않는다).
-- 같은 값이면 쓰지 않는다(쓰기 0).
create or replace function public.msgr2_set_seat(p_agent uuid, p_space uuid, p_allow text default 'all', p_users uuid[] default '{}', p_remove boolean default false) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid();
begin
  if uid is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if p_allow not in ('all', 'list', 'owner') then raise exception 'msgr2_bad_allow' using errcode = '22023'; end if;
  if not exists (select 1 from public.msgr2_agents where id = p_agent and owner_user_id = uid)
     or not exists (select 1 from public.msgr2_spaces where id = p_space and kind = 'team' and deleted_at is null)
     or not exists (select 1 from public.msgr2_space_members where space_id = p_space and user_id = uid and role in ('owner', 'admin', 'member') and removed_at is null and (expires_at is null or expires_at > now())) then
    raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  if p_remove then
    update public.msgr2_agent_seats set removed_at = now() where agent_id = p_agent and space_id = p_space and removed_at is null;
    return;
  end if;
  insert into public.msgr2_agent_seats as t (agent_id, space_id, allow, allow_users, added_by) values (p_agent, p_space, p_allow, coalesce(p_users, '{}'), uid)
  on conflict (agent_id, space_id) do update set allow = excluded.allow, allow_users = excluded.allow_users, removed_at = null
  where (t.allow, t.allow_users, t.removed_at) is distinct from (excluded.allow, excluded.allow_users, null::timestamptz);
end $$;

-- 방의 에이전트 정책(D9): 앱 기기만, msgr2_access(방).manage일 때. 같은 값이면 쓰지 않는다.
create or replace function public.msgr2_set_room_agent_policy(p_room uuid, p_policy text) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if p_policy not in ('allowed', 'approval', 'blocked') then raise exception 'msgr2_bad_policy' using errcode = '22023'; end if;
  if not (public.msgr2_access(p_room)).manage then raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  update public.msgr2_rooms set agent_policy = p_policy where id = p_room and agent_policy is distinct from p_policy;
end $$;

revoke all on function public.msgr2_my_personal_space() from public, anon;
revoke all on function public.msgr2_agent_sync(jsonb) from public, anon;
revoke all on function public.msgr2_set_member_role(uuid, uuid, text) from public, anon;
revoke all on function public.msgr2_set_seat(uuid, uuid, text, uuid[], boolean) from public, anon;
revoke all on function public.msgr2_set_room_agent_policy(uuid, text) from public, anon;
grant execute on function public.msgr2_my_personal_space() to authenticated;
grant execute on function public.msgr2_agent_sync(jsonb) to authenticated;
grant execute on function public.msgr2_set_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.msgr2_set_seat(uuid, uuid, text, uuid[], boolean) to authenticated;
grant execute on function public.msgr2_set_room_agent_policy(uuid, text) to authenticated;
revoke execute on function public.msgr2_lock_cols(), public.msgr2_same_room(), public.msgr2_seat_team_only(), public.msgr2_insert_stamp() from public, anon, authenticated;
