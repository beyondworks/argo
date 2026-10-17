-- 메신저 v2 U8 — 기존 데이터 이전(백필) 함수·검증 함수(설계 정본: AI-Sessions/conversations/argo/2026-10-17-argo-messenger-redesign-design.md 1-2절 표, 6절, 7절 13·25).
-- 이 파일은 표·함수만 만든다. 백필을 실행하지 않는다 — 실행은 맥 one이 운영에서 scripts/msgr2-migrate.sh로 한다(런북 scripts/msgr2-migrate-runbook.md).
-- 원칙
--   · 옛 msgr_* 표는 읽기만 한다(이 파일의 함수는 옛 표에 insert·update·delete를 하지 않는다 — 시험이 옛 표 전체의 내용 해시로 잠근다).
--   · id 보존: 공간(팀) = 조직 id, 방 = 채널 id, 글 = 글 id, 에이전트 = msgr_agents.id, 대기 결재 = 결재 id. 개인 공간·첨부 행만 새 id다.
--   · 멱등: 모든 단계가 on conflict + IS DISTINCT FROM으로 값이 바뀐 행만 쓴다. 두 번째 실행의 데이터 쓰기 = 0(시험: xmin 불변).
--   · 작업 = 행(msgr2_backfill_jobs). 한 번 부르기 = 한 묶음 = 한 트랜잭션이고, 체크포인트를 같은 트랜잭션에서 쓴다. 중간에 멈추면 그 묶음만 되돌아가고
--     체크포인트부터 다시 간다. 같은 작업을 두 곳에서 부르면 뒤에 온 쪽은 'busy'(행 잠금 = 단일 claim). 다시 처음부터 돌릴 때는 세대(generation)를 올린다 —
--     옛 세대를 들고 있는 실행기는 'stale_generation'으로 멈춘다.
--   · 백필 중 방송·푸시·offer = 0: 서비스 문맥(auth.uid() 없음)에서 msgr2.backfill = on(이 함수가 트랜잭션 안에서만 켠다)이면
--     글 방송(U2b)·푸시 줄 세우기(U7)·사람 글 → offer(아래에서 감싼다)가 모두 건너뛴다.
--   · 스위치 뒤에는 돌지 않는다: msgr_settings key 'msgr2_switched_at'(런북이 손으로 넣는다) 또는 'msgr2_enabled'(v2 운영 표지, U6d)가 있으면 모든 실행이 거부된다
--     (스위치 뒤 v2에서 생긴 변경 — 새 멤버·새 방 — 을 옛 값으로 덮거나 removed_at을 찍지 않게).
-- 옛 → 새 대응(설계 1-2절 표, 정하지 않았던 칸은 여기서 정했다 — PR 본문 경우 표에 적었다)
--   방 종류: public → open. 단 제외 목록(excluded_user_ids)이 있는 public은 private + 그 조직의 활동 중인 owner·admin·member 중 제외되지 않은 사람을 멤버로
--            (v2 open 방에는 제외 개념이 없다 — 옛날에 못 보던 사람이 보게 되는 길을 막는다).
--            private → private. 1:1 짝 키는 U6d(20261018040000_msgr2_rooms.sql — msgr2_dm_open·msgr2_agent_dm_open·msgr2_dm_list)와 같다:
--              개인 친구 dm(personal_pair 'a:b') → direct 'p:' || 같은 짝(모든 개인 공간에서 유일). 조직 dm 사람 둘 → direct '<작은 uid>:<큰 uid>'(공간마다 유일).
--              에이전트 1:1(개인 'crew:<crew>'·조직 사람 하나 + 에이전트 하나) → private, pair_key 없음(U6d는 "나와 그 에이전트만 있는 private 방"으로 찾는다).
--              그 밖(그룹·자기 자신) → private. 같은 짝이 이미 있으면(개인은 전체, 조직은 그 공간) 먼저 만든 방만 direct, 나머지는 private.
--   개인 방(org_id null)은 만든 사람의 개인 공간에 둔다. 에이전트 정책: allowed·approval·blocked 그대로, read_only → blocked. 기억 = crew_memory.
--   방 멤버: 사람은 그대로(단 옛 public 방의 손님 역할 행은 뺀다 — 옛 판정도 public 방에서 손님을 막는다. 제외 목록은 참여 행이 없는 사람에게만 듣는다). 크루 → 에이전트(crews.agent_id), 제외 목록의 크루는 뺀다.
--   글 작성자: 사람 → user. 크루 → agent(crews.agent_id). 작성자가 지워져 null인 사람 글·크루 글 → system 작성자 + meta.legacy_author(옛 작성자 종류).
--            종류: text → text, approval_card → card, system → system. thread_root는 토픽 없이 reply_to로만(reply_to가 없을 때).
--            멘션: [{kind:'user'|'crew', id}] → uuid[](크루는 에이전트 id), 최대 20. client_msg_id는 같은 방에 같은 값이 둘 이상이면 비운다(v2 유일 색인).
--   첨부: 행만 복사한다(파일은 옮기지 않는다). storage_path = 'msgr/' || 옛 경로(v2는 '버킷/경로' — U2b 정리 제외 조건과 _msgr2_attachments_of가 이 모양을 본다).
--   대기 결재(pending) → 결재 행 expired + 일 행 cancelled(같은 id, 다시 실행하지 않는다). 결정된 결재·실행 기록·푸시 토큰·초대·리스는 옮기지 않는다.
--   조직 고정(msgr_target_prefs, 사람·크루 고정) → 그 조직의 옛 1:1 채널(나와 그 사람 / 나와 그 에이전트) 방 설정 pinned.
--   에이전트: 자리가 하나도 없는 msgr_agents 행(게이트웨이가 자리만 지운 경우)도 기본값(이름 = slug, local, active)으로 옮긴다(id 보존).
--   옮기지 않는 것(옛 표에 남는다): 채널 topic, 방 설정 pin_pos·folder·sort_pos, 멤버 department·title.
-- 함정: 이 파일은 기억 데이터를 지우는 SQL이 없다(rule-gates). 비우기(스위치 전 되돌림)는 scripts/msgr2-migrate-rollback.sql — 백필로 생긴 행만 있을 때만 돈다.
-- 시험: test/msgr2-backfill-pg.test.mjs(합성 옛 데이터 — bash scripts/billing-pg-drill.sh test/msgr2-backfill-pg.test.mjs).
-- 되돌림(이 파일): scripts/rollback/20261018050000_msgr2_backfill.down.sql

-- ── 0. 작업 행 ──────────────────────────────────────────────────────────────────
create table if not exists public.msgr2_backfill_jobs (
  name text primary key,
  step int not null unique,                          -- 실행 순서(앞 단계가 끝나야 다음 단계가 돈다)
  batch_limit int not null default 5000 check (batch_limit between 1 and 50000), -- 한 번 부르기에 읽는 옛 행 상한
  generation int not null default 1,                 -- 처음부터 다시 돌릴 때 +1(msgr2_backfill_restart)
  checkpoint text,                                   -- 마지막으로 끝낸 옛 키(단계마다 뜻이 다르다, 처음 = null)
  done_at timestamptz,
  claimed_by text,                                   -- 마지막으로 부른 실행기 이름(행 잠금이 실제 claim이다)
  claimed_at timestamptz,
  runs int not null default 0,
  rows_written bigint not null default 0,            -- 이 세대에서 쓴 새 표 행 수
  verified_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.msgr2_backfill_jobs enable row level security; -- 정책 없음: 사람·기기는 못 읽는다(서비스 전용)
revoke all on public.msgr2_backfill_jobs from anon, authenticated;
-- 같은 채널에 같은 client_msg_id가 둘 이상인 (채널, 값) — message_keys 단계가 한 번 채우고 messages 단계가 기본 키로 찾는다
-- (글마다 채널 전체를 훑지 않게: 10만 글 채널에서 묶음 하나 47초였다 — 검수 #1084). 옛 표가 동결이라 한 세대 동안 그대로다. 기억 데이터 아님.
create table if not exists public.msgr2_backfill_cmid_dups (channel_id uuid not null, client_msg_id text not null, primary key (channel_id, client_msg_id));
alter table public.msgr2_backfill_cmid_dups enable row level security;
revoke all on public.msgr2_backfill_cmid_dups from anon, authenticated;
insert into public.msgr2_backfill_jobs (name, step) values
  ('agents', 1), ('spaces', 2), ('space_members', 3), ('seats', 4), ('rooms', 5), ('room_members', 6), ('message_keys', 7), ('messages', 8),
  ('attachments', 9), ('reads', 10), ('reactions', 11), ('prefs', 12), ('target_prefs', 13), ('approvals', 14), ('identity', 15)
on conflict (name) do nothing;

-- ── 1. 문맥 확인 ────────────────────────────────────────────────────────────────
-- 서비스 문맥만(사람 토큰으로 부르면 거부), 스위치 뒤 거부, 이 트랜잭션 동안 msgr2.backfill = on.
create or replace function public._msgr2_bf_begin() returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null then raise exception 'msgr2_backfill_service_only' using errcode = '42501'; end if;
  if exists (select 1 from public.msgr_settings where key in ('msgr2_switched_at', 'msgr2_enabled')) then
    raise exception 'msgr2_backfill_after_switch' using errcode = '55000', hint = '스위치 뒤(msgr2_switched_at·msgr2_enabled)에는 백필하지 않는다(v2 변경을 옛 값으로 덮는다)'; end if;
  perform set_config('msgr2.backfill', 'on', true);
end $$;

-- 사람 글 → offer 트리거(U2)를 백필 중에는 건너뛰게 감싼다. 본문은 20261018000000_msgr2_work.sql 그대로 + 첫 줄 한 줄.
-- (옛 글을 옮기는데 에이전트 1:1 방·멘션 글마다 일이 새로 생기면 옛 지시가 다시 실행된다.)
create or replace function public.msgr2_on_user_message() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[];
begin
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if; -- 이전(U8) 백필: offer·카운터 쓰기 없음
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

-- ── 2. 대응 도우미 ──────────────────────────────────────────────────────────────
create or replace function public._msgr2_bf_uuid(p text) returns uuid language sql immutable as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end $$;

-- 옛 채널 → 새 방 모양(공간·종류·짝 키). 같은 짝이 겹치는지는 rooms 단계가 본다.
-- 옛 표는 실행할 때 찾는다(plpgsql) — 옛 표가 없는 DB(v2만 적용한 시험 판)에서도 이 파일이 적용된다.
create or replace function public._msgr2_bf_room_shape(p_channel uuid, out space_id uuid, out kind text, out pair_key text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; u uuid[]; a uuid[];
begin
  select * into c from public.msgr_channels where id = p_channel;
  space_id := coalesce(c.org_id, (select s.id from public.msgr2_spaces s where s.owner_user_id = c.created_by and s.kind = 'personal'));
  if c.kind = 'public' then kind := case when cardinality(c.excluded_user_ids) > 0 then 'private' else 'open' end; return; end if;
  if c.kind = 'private' then kind := 'private'; return; end if;
  kind := 'private'; -- dm 중 짝을 못 정하면 private
  if c.org_id is null then
    -- 개인 에이전트 1:1('crew:<자리>')은 private 그대로(U6d msgr2_agent_dm_open이 찾는 모양)
    if c.personal_pair is not null and c.personal_pair not like 'crew:%' then
      kind := 'direct'; pair_key := 'p:' || c.personal_pair;
    end if;
    return;
  end if;
  select coalesce(array_agg(distinct m.member_id) filter (where m.member_kind = 'user'), '{}'),
         coalesce(array_agg(distinct cr.agent_id) filter (where m.member_kind = 'crew' and cr.agent_id is not null), '{}')
    into u, a
    from public.msgr_channel_members m left join public.msgr_crews cr on m.member_kind = 'crew' and cr.id = m.member_id
   where m.channel_id = c.id;
  if cardinality(u) = 2 and cardinality(a) = 0 then
    kind := 'direct'; pair_key := least(u[1]::text, u[2]::text) || ':' || greatest(u[1]::text, u[2]::text);
  end if; -- 사람 하나 + 에이전트 하나는 private(에이전트 1:1, pair_key 없음)
end $$;

-- 옮길 방 멤버 원본(rooms 단계 뒤에 부른다). 방 = 옛 채널 id.
create or replace function public._msgr2_bf_room_members_src()
  returns table (room_id uuid, member_kind text, member_id uuid, added_by uuid, added_at timestamptz)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
  -- 사람: 옛 public 채널(→ open, 또는 제외 목록 때문에 private)의 손님 행은 뺀다(옛 판정도 public에서 손님을 막는다).
  -- 제외 목록에 있어도 참여 행이 있으면 남긴다 — 옛 판정(msgr_can_read_channel)의 둘째 갈래가 참여 행 + member 이상 역할이면 읽게 한다.
  select m.channel_id, 'user', m.member_id, m.added_by, m.added_at
    from public.msgr_channel_members m join public.msgr_channels c on c.id = m.channel_id join public.msgr2_rooms r on r.id = c.id
   where m.member_kind = 'user'
     and not (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = m.member_id and om.role = 'guest'))
  union
  -- 제외 목록이 있던 public → private: 그 조직의 활동 중인 owner·admin·member(제외되지 않은 사람)
  select c.id, 'user', om.user_id, null::uuid, greatest(c.created_at, om.joined_at)
    from public.msgr_channels c join public.msgr2_rooms r on r.id = c.id join public.msgr_org_members om on om.org_id = c.org_id
   where c.kind = 'public' and r.kind = 'private' and om.role in ('owner', 'admin', 'member') and om.removed_at is null
     and (om.expires_at is null or om.expires_at > now()) and not (om.user_id = any (c.excluded_user_ids))
     and not exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = om.user_id)
  union
  -- 에이전트: 한 방에 같은 에이전트의 자리가 둘이어도 한 행(가장 먼저 들어온 것)
  (select distinct on (m.channel_id, cr.agent_id) m.channel_id, 'agent', cr.agent_id, m.added_by, m.added_at
     from public.msgr_channel_members m join public.msgr_channels c on c.id = m.channel_id join public.msgr2_rooms r on r.id = c.id
     join public.msgr_crews cr on cr.id = m.member_id
    where m.member_kind = 'crew' and cr.agent_id is not null and not (m.member_id = any (c.excluded_crew_ids))
    order by m.channel_id, cr.agent_id, m.added_at);
end $$;

-- 조직 고정(msgr_target_prefs)이 이 방을 고정했나 — 옛 조직 1:1 채널(사람 둘 / 나 + 에이전트 하나)의 구성으로 본다(새 방 모양과 무관).
-- prefs·target_prefs 두 단계가 같은 값을 내야 반복 실행이 쓰기 0이다.
create or replace function public._msgr2_bf_target_pin(p_room uuid, p_user uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; u uuid[]; a uuid[];
begin
  select * into c from public.msgr_channels where id = p_room;
  if not found or c.org_id is null or c.kind <> 'dm' then return false; end if;
  select coalesce(array_agg(distinct m.member_id) filter (where m.member_kind = 'user'), '{}'),
         coalesce(array_agg(distinct cr.agent_id) filter (where m.member_kind = 'crew' and cr.agent_id is not null), '{}')
    into u, a
    from public.msgr_channel_members m left join public.msgr_crews cr on m.member_kind = 'crew' and cr.id = m.member_id
   where m.channel_id = c.id;
  if not (p_user = any (u)) then return false; end if;
  if cardinality(u) = 1 and cardinality(a) = 1 then
    return exists (select 1 from public.msgr_target_prefs t join public.msgr_crews cr on cr.id = t.target_id
                    where t.user_id = p_user and t.org_id = c.org_id and t.target_kind = 'crew' and t.pinned and cr.agent_id = a[1]);
  elsif cardinality(u) = 2 and cardinality(a) = 0 then
    return exists (select 1 from public.msgr_target_prefs t where t.user_id = p_user and t.org_id = c.org_id and t.target_kind = 'user' and t.pinned
                      and t.target_id = (select x from unnest(u) x where x <> p_user));
  end if;
  return false;
end $$;

-- ── 3. 단계 ─────────────────────────────────────────────────────────────────────
-- 모두 (p_after 체크포인트, p_limit 상한) → (written 새 표 쓰기 수, next 다음 체크포인트, done 끝)
-- 작은 표(에이전트·공간·멤버·자리·방·방 멤버·조직 고정·결재)는 한 번에 끝낸다. 글·첨부·읽음·반응·설정은 키 순 묶음이다.

-- 1) 에이전트: 크루의 agent_id가 비어 있으면 멈춘다(옛 표를 고치지 않는다 — 먼저 msgr_agents_backfill, 런북 2단계).
--    값은 대표 자리 행(개인 자리 우선, 그다음 최근 등록)에서 온다. hosting: 자리가 모두 bot이면 bot, 아니면 local. status: 대표 자리가 paused면 paused.
--    자리가 하나도 없으면 이름 = slug, 역할 '', local, active(검수 #1084 — 게이트웨이 deleteCrews가 자리만 지우고 msgr_agents 행을 남긴다).
create or replace function public._msgr2_bf_agents(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  select count(*) into n from public.msgr_crews where agent_id is null;
  if n > 0 then raise exception 'msgr2_backfill_agent_ids_missing: % crews', n using errcode = '55000', hint = '먼저 select public.msgr_agents_backfill() (런북 2단계)'; end if;
  select count(*) into n from public.msgr2_agents v join public.msgr_agents a on (a.owner_user_id, a.ws_id, a.slug) = (v.owner_user_id, v.ws_id, v.slug) where a.id <> v.id;
  if n > 0 then raise exception 'msgr2_backfill_agent_id_conflict: % agents', n using errcode = '55000', hint = 'v2 agent.sync가 옛 에이전트와 다른 id로 먼저 등록했다(런북 함정 1)'; end if;
  insert into public.msgr2_agents as t (id, owner_user_id, ws_id, slug, display_name, role_text, face, hosting, status, created_at)
  select a.id, a.owner_user_id, a.ws_id, a.slug, left(coalesce(rep.display_name, a.slug), 80), left(coalesce(rep.role_text, ''), 200), rep.face,
         case when coalesce(bool_and_bot.all_bot, false) then 'bot' else 'local' end, case when rep.status = 'paused' then 'paused' else 'active' end, a.created_at
    from public.msgr_agents a
    left join lateral (select c.* from public.msgr_crews c where c.agent_id = a.id order by (c.org_id is null) desc, c.registered_at desc, c.id limit 1) rep on true
    left join lateral (select bool_and(c.hosting = 'bot') as all_bot from public.msgr_crews c where c.agent_id = a.id) bool_and_bot on true
  on conflict (id) do update set display_name = excluded.display_name, role_text = excluded.role_text, face = excluded.face,
    hosting = excluded.hosting, status = excluded.status, updated_at = now()
  where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from (excluded.display_name, excluded.role_text, excluded.face, excluded.hosting, excluded.status);
  get diagnostics written = row_count;
  done := true;
end $$;

-- 2) 공간: 팀 = 조직(같은 id, 지운 조직도 deleted_at과 함께), 개인 = 메신저에 나온 사람마다 1개(이미 있으면 그대로).
create or replace function public._msgr2_bf_spaces(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_spaces as t (id, kind, name, slug, owner_user_id, created_at, deleted_at)
  select o.id, 'team', o.name, o.slug, o.owner_user_id, o.created_at, o.deleted_at from public.msgr_orgs o
  on conflict (id) do update set name = excluded.name, slug = excluded.slug, owner_user_id = excluded.owner_user_id, deleted_at = excluded.deleted_at
  where (t.name, t.slug, t.owner_user_id, t.deleted_at) is distinct from (excluded.name, excluded.slug, excluded.owner_user_id, excluded.deleted_at);
  get diagnostics written = row_count;
  insert into public.msgr2_spaces (kind, owner_user_id)
  select 'personal', u from (
    select user_id as u from public.msgr_org_members
    union select member_id from public.msgr_channel_members where member_kind = 'user'
    union select created_by from public.msgr_channels
    union select owner_user_id from public.msgr_crews
    union select user_id from public.msgr_profiles) x
   where u is not null and not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')
  on conflict (owner_user_id) where kind = 'personal' do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

-- 3) 공간 멤버: 조직 멤버 복사(역할·표시 이름·탈퇴·만료). 옛 행이 사라진 팀 멤버는 removed_at을 찍는다(지우지 않는다). 개인 공간은 주인 1행.
create or replace function public._msgr2_bf_space_members(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_space_members as t (space_id, user_id, role, display_name, joined_at, removed_at, expires_at)
  select m.org_id, m.user_id, m.role, m.display_name, m.joined_at, m.removed_at, m.expires_at from public.msgr_org_members m
  on conflict (space_id, user_id) do update set role = excluded.role, display_name = excluded.display_name, removed_at = excluded.removed_at, expires_at = excluded.expires_at
  where (t.role, t.display_name, t.removed_at, t.expires_at) is distinct from (excluded.role, excluded.display_name, excluded.removed_at, excluded.expires_at);
  get diagnostics written = row_count;
  update public.msgr2_space_members t set removed_at = now()
   where t.removed_at is null and exists (select 1 from public.msgr_orgs o where o.id = t.space_id)
     and not exists (select 1 from public.msgr_org_members m where m.org_id = t.space_id and m.user_id = t.user_id);
  get diagnostics k = row_count; written := written + k;
  insert into public.msgr2_space_members (space_id, user_id, role, joined_at)
  select s.id, s.owner_user_id, 'owner', s.created_at from public.msgr2_spaces s
   where s.kind = 'personal' and not exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id = s.owner_user_id)
  on conflict do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

-- 4) 파견: 조직 자리 행 → seat(허용 범위 그대로). 옛 자리 행이 사라졌으면 removed_at.
create or replace function public._msgr2_bf_seats(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_agent_seats as t (agent_id, space_id, allow, allow_users, added_by, added_at)
  select distinct on (c.agent_id, c.org_id) c.agent_id, c.org_id, c.allow, c.allow_users, c.owner_user_id, c.created_at
    from public.msgr_crews c where c.org_id is not null and c.agent_id is not null order by c.agent_id, c.org_id, c.created_at
  on conflict (agent_id, space_id) do update set allow = excluded.allow, allow_users = excluded.allow_users, removed_at = null
  where (t.allow, t.allow_users, t.removed_at) is distinct from (excluded.allow, excluded.allow_users, null::timestamptz);
  get diagnostics written = row_count;
  update public.msgr2_agent_seats t set removed_at = now()
   where t.removed_at is null and exists (select 1 from public.msgr_orgs o where o.id = t.space_id)
     and not exists (select 1 from public.msgr_crews c where c.org_id = t.space_id and c.agent_id = t.agent_id);
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

-- 5) 방: 채널 id 그대로. 모양(종류·짝)은 처음 만들 때만 정하고, 다시 돌 때는 이름·보관·기억·에이전트 정책만 맞춘다.
create or replace function public._msgr2_bf_rooms(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint; c record; sh record;
begin
  written := 0;
  update public.msgr2_rooms t set name = c2.name, archived_at = c2.archived_at, memory = c2.crew_memory,
         agent_policy = case c2.personal_crews when 'read_only' then 'blocked' else c2.personal_crews end
    from public.msgr_channels c2
   where c2.id = t.id and (t.name, t.archived_at, t.memory, t.agent_policy) is distinct from
         (c2.name, c2.archived_at, c2.crew_memory, case c2.personal_crews when 'read_only' then 'blocked' else c2.personal_crews end);
  get diagnostics written = row_count;
  for c in select * from public.msgr_channels ch where not exists (select 1 from public.msgr2_rooms r where r.id = ch.id) order by ch.created_at, ch.id loop
    sh := public._msgr2_bf_room_shape(c.id);
    if sh.space_id is null then raise exception 'msgr2_backfill_room_without_space: %', c.id using errcode = '55000'; end if;
    if sh.kind = 'direct' and exists (select 1 from public.msgr2_rooms r where r.kind = 'direct' and r.pair_key = sh.pair_key
                                        and (sh.pair_key like 'p:%' or r.space_id = sh.space_id)) then
      sh.kind := 'private'; sh.pair_key := null; -- 같은 짝의 방이 이미 있다(먼저 만든 방이 direct). 'p:'는 모든 개인 공간에서 유일(U6d 인덱스)
    end if;
    insert into public.msgr2_rooms (id, space_id, kind, pair_key, name, memory, agent_policy, created_by, created_at, archived_at)
    values (c.id, sh.space_id, sh.kind, sh.pair_key, c.name, c.crew_memory,
            case c.personal_crews when 'read_only' then 'blocked' else c.personal_crews end, c.created_by, c.created_at, c.archived_at);
    written := written + 1;
  end loop;
  done := true;
end $$;

-- 6) 방 멤버: 원본에 있으면 넣거나 되살리고(removed_at = null), 옮긴 방에서 원본에 없어진 행은 removed_at을 찍는다.
create or replace function public._msgr2_bf_room_members(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  create temp table if not exists _msgr2_bf_rm (room_id uuid, member_kind text, member_id uuid, added_by uuid, added_at timestamptz) on commit drop;
  truncate _msgr2_bf_rm;
  insert into _msgr2_bf_rm select * from public._msgr2_bf_room_members_src();
  insert into public.msgr2_room_members as t (room_id, member_kind, member_id, added_by, added_at)
  select s.room_id, s.member_kind, s.member_id, s.added_by, s.added_at from _msgr2_bf_rm s
  on conflict (room_id, member_kind, member_id) do update set removed_at = null where t.removed_at is not null;
  get diagnostics written = row_count;
  update public.msgr2_room_members t set removed_at = now()
   where t.removed_at is null and exists (select 1 from public.msgr_channels c where c.id = t.room_id)
     and not exists (select 1 from _msgr2_bf_rm s where (s.room_id, s.member_kind, s.member_id) = (t.room_id, t.member_kind, t.member_id));
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

-- 7) 글 키: 같은 채널에 같은 client_msg_id가 둘 이상인 (채널, 값)을 한 번 모은다(옛 글 전체를 한 번 훑는다 — 글 단계의 묶음마다 훑지 않게).
--    세대마다 처음부터 다시 모은다(restart 뒤). 이 표는 백필 도우미라 비우고 다시 채운다(기억 데이터 아님).
create or replace function public._msgr2_bf_message_keys(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  delete from public.msgr2_backfill_cmid_dups; -- 도우미 표(기억 데이터 아님) — 이 세대의 옛 글로 다시 모은다
  insert into public.msgr2_backfill_cmid_dups (channel_id, client_msg_id)
  select o.channel_id, o.client_msg_id from public.msgr_messages o where o.client_msg_id is not null group by 1, 2 having count(*) > 1
  on conflict do nothing;
  written := 0; done := true; -- 새 표(기억·사본) 쓰기가 아니라 세지 않는다
end $$;

-- 8) 글: id 순 묶음. 체크포인트 = 이 묶음의 마지막 옛 글 id.
--    같은 id가 다른 방에 이미 있으면(v2에서 먼저 쓴 글) 멈춘다 — on conflict(id)로 다른 방 글을 덮지 않게(검수 #1084).
create or replace function public._msgr2_bf_messages(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare last_id bigint; n int;
begin
  create temp table if not exists _msgr2_bf_m on commit drop as select * from public.msgr_messages limit 0;
  truncate _msgr2_bf_m;
  insert into _msgr2_bf_m select * from public.msgr_messages m where m.id > coalesce(p_after::bigint, 0) order by m.id limit p_limit;
  select count(*), max(id) into n, last_id from _msgr2_bf_m;
  if exists (select 1 from _msgr2_bf_m m join public.msgr2_messages v on v.id = m.id where v.room_id is distinct from m.channel_id) then
    raise exception 'msgr2_backfill_message_id_conflict: 옛 글 id가 다른 방의 v2 글로 이미 있다' using errcode = '55000'; end if;
  insert into public.msgr2_messages as t (id, room_id, author_kind, author_user_id, author_agent_id, kind, body, meta, reply_to, client_msg_id,
                                          created_at, edited_at, deleted_at, mentions)
  select m.id, m.channel_id, a.kind, a.uid, a.agent,
         case m.kind when 'approval_card' then 'card' when 'system' then 'system' else 'text' end, m.body,
         case when a.legacy is null then m.meta else m.meta || jsonb_build_object('legacy_author', a.legacy) end,
         coalesce(m.reply_to, m.thread_root),
         case when m.client_msg_id is not null and not exists (select 1 from public.msgr2_backfill_cmid_dups d where d.channel_id = m.channel_id and d.client_msg_id = m.client_msg_id)
              then m.client_msg_id end,
         m.created_at, m.edited_at, m.deleted_at, coalesce(mn.ids, '{}')
    from _msgr2_bf_m m
    join public.msgr2_rooms r on r.id = m.channel_id
    left join public.msgr_crews cr on cr.id = m.crew_id
    cross join lateral (select
      case when m.author_kind = 'user' and m.author_user_id is not null then 'user' when m.author_kind = 'crew' and cr.agent_id is not null then 'agent' else 'system' end as kind,
      case when m.author_kind = 'user' then m.author_user_id end as uid,
      case when m.author_kind = 'crew' then cr.agent_id end as agent,
      case when m.author_kind = 'user' and m.author_user_id is null then 'user' when m.author_kind = 'crew' and cr.agent_id is null then 'crew' end as legacy) a
    cross join lateral (select (array_agg(distinct x))[1:20] as ids from (
      select case when e->>'kind' = 'crew' then (select c2.agent_id from public.msgr_crews c2 where c2.id = public._msgr2_bf_uuid(e->>'id'))
                  when e->>'kind' = 'user' then public._msgr2_bf_uuid(e->>'id') end as x
        from jsonb_array_elements(case when jsonb_typeof(m.mentions) = 'array' then m.mentions else '[]'::jsonb end) e) q where x is not null) mn
  on conflict (id) do update set body = excluded.body, meta = excluded.meta, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at, mentions = excluded.mentions
  where (t.body, t.meta, t.edited_at, t.deleted_at, t.mentions) is distinct from (excluded.body, excluded.meta, excluded.edited_at, excluded.deleted_at, excluded.mentions);
  get diagnostics written = row_count;
  next := coalesce(last_id::text, p_after);
  done := n < p_limit;
end $$;

-- 8) 첨부 행: 옛 첨부 id 순 묶음. 같은 글·같은 경로의 행이 있으면 넣지 않는다(첨부 id는 새로 매긴다 — 옛 id는 uuid).
create or replace function public._msgr2_bf_attachments(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare last_id uuid; n int;
begin
  create temp table if not exists _msgr2_bf_a on commit drop as select * from public.msgr_attachments limit 0;
  truncate _msgr2_bf_a;
  insert into _msgr2_bf_a select * from public.msgr_attachments a where a.id > coalesce(p_after::uuid, '00000000-0000-0000-0000-000000000000'::uuid) order by a.id limit p_limit;
  select count(*), max(id::text)::uuid into n, last_id from _msgr2_bf_a;
  insert into public.msgr2_attachments (message_id, room_id, storage_path, name, mime, bytes, created_at)
  select a.message_id, m.room_id, 'msgr/' || a.storage_path, a.name, a.mime, a.bytes, a.created_at
    from _msgr2_bf_a a join public.msgr2_messages m on m.id = a.message_id
   where not exists (select 1 from public.msgr2_attachments x where x.message_id = a.message_id and x.storage_path = 'msgr/' || a.storage_path);
  get diagnostics written = row_count;
  next := coalesce(last_id::text, p_after);
  done := n < p_limit;
end $$;

-- 9) 읽음: (채널, 사람) 순 묶음. 앞으로만 움직인다(더 읽은 v2 값을 옛 값으로 되돌리지 않는다).
create or replace function public._msgr2_bf_reads(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int; lc uuid; lu uuid;
  ac uuid := coalesce(public._msgr2_bf_uuid(split_part(p_after, ',', 1)), '00000000-0000-0000-0000-000000000000');
  au uuid := coalesce(public._msgr2_bf_uuid(split_part(p_after, ',', 2)), '00000000-0000-0000-0000-000000000000');
begin
  create temp table if not exists _msgr2_bf_r on commit drop as select * from public.msgr_reads limit 0;
  truncate _msgr2_bf_r;
  insert into _msgr2_bf_r select * from public.msgr_reads x where (x.channel_id, x.user_id) > (ac, au) order by x.channel_id, x.user_id limit p_limit;
  select count(*) into n from _msgr2_bf_r;
  select channel_id, user_id into lc, lu from _msgr2_bf_r order by channel_id desc, user_id desc limit 1;
  insert into public.msgr2_reads as t (room_id, user_id, last_read_id, updated_at)
  select x.channel_id, x.user_id, x.last_read_id, x.updated_at from _msgr2_bf_r x join public.msgr2_rooms r on r.id = x.channel_id
  on conflict (room_id, user_id) do update set last_read_id = excluded.last_read_id, updated_at = excluded.updated_at where t.last_read_id < excluded.last_read_id;
  get diagnostics written = row_count;
  next := case when lc is null then p_after else lc::text || ',' || lu::text end;
  done := n < p_limit;
end $$;

-- 10) 반응: (글, 사람, 이모지) 순 묶음. 옮긴 글에만.
create or replace function public._msgr2_bf_reactions(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int; lm bigint; lu uuid; le text;
  am bigint := coalesce(nullif(split_part(p_after, ',', 1), '')::bigint, 0);
  au uuid := coalesce(public._msgr2_bf_uuid(split_part(p_after, ',', 2)), '00000000-0000-0000-0000-000000000000');
  ae text := coalesce(substr(p_after, length(split_part(p_after, ',', 1)) + length(split_part(p_after, ',', 2)) + 3), '');
begin
  create temp table if not exists _msgr2_bf_x on commit drop as select * from public.msgr_reactions limit 0;
  truncate _msgr2_bf_x;
  insert into _msgr2_bf_x select * from public.msgr_reactions x where (x.message_id, x.user_id, x.emoji) > (am, au, ae) order by x.message_id, x.user_id, x.emoji limit p_limit;
  select count(*) into n from _msgr2_bf_x;
  select message_id, user_id, emoji into lm, lu, le from _msgr2_bf_x order by message_id desc, user_id desc, emoji desc limit 1;
  insert into public.msgr2_reactions (message_id, user_id, emoji, created_at)
  select x.message_id, x.user_id, x.emoji, x.created_at from _msgr2_bf_x x where exists (select 1 from public.msgr2_messages m where m.id = x.message_id)
  on conflict do nothing;
  get diagnostics written = row_count;
  next := case when lm is null then p_after else lm::text || ',' || lu::text || ',' || le end; -- 이모지에 쉼표가 있어도 앞 두 칸 뒤 나머지 전부가 이모지다
  done := n < p_limit;
end $$;

-- 11) 방 설정: (채널, 사람) 순 묶음. 고정 = 방 고정 또는 조직 고정(_msgr2_bf_target_pin).
create or replace function public._msgr2_bf_prefs(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int; lc uuid; lu uuid;
  ac uuid := coalesce(public._msgr2_bf_uuid(split_part(p_after, ',', 1)), '00000000-0000-0000-0000-000000000000');
  au uuid := coalesce(public._msgr2_bf_uuid(split_part(p_after, ',', 2)), '00000000-0000-0000-0000-000000000000');
begin
  create temp table if not exists _msgr2_bf_p on commit drop as select * from public.msgr_channel_prefs limit 0;
  truncate _msgr2_bf_p;
  insert into _msgr2_bf_p select * from public.msgr_channel_prefs x where (x.channel_id, x.user_id) > (ac, au) order by x.channel_id, x.user_id limit p_limit;
  select count(*) into n from _msgr2_bf_p;
  select channel_id, user_id into lc, lu from _msgr2_bf_p order by channel_id desc, user_id desc limit 1;
  insert into public.msgr2_prefs as t (room_id, user_id, muted, pinned, updated_at)
  select x.channel_id, x.user_id, x.muted, x.pinned or public._msgr2_bf_target_pin(x.channel_id, x.user_id), x.updated_at
    from _msgr2_bf_p x join public.msgr2_rooms r on r.id = x.channel_id
  on conflict (room_id, user_id) do update set muted = excluded.muted, pinned = excluded.pinned, updated_at = excluded.updated_at
  where (t.muted, t.pinned) is distinct from (excluded.muted, excluded.pinned);
  get diagnostics written = row_count;
  next := case when lc is null then p_after else lc::text || ',' || lu::text end;
  done := n < p_limit;
end $$;

-- 12) 조직 고정: 방 설정 행이 없는 (사람, 옛 조직 1:1 채널 방)에 pinned 행을 만든다(방 설정 행이 있으면 11단계가 이미 반영했다).
create or replace function public._msgr2_bf_target_prefs(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  insert into public.msgr2_prefs (room_id, user_id, pinned)
  select distinct r.id, t.user_id, true
    from public.msgr_target_prefs t
    join public.msgr_channel_members cm on cm.member_kind = 'user' and cm.member_id = t.user_id
    join public.msgr_channels c on c.id = cm.channel_id and c.org_id = t.org_id and c.kind = 'dm'
    join public.msgr2_rooms r on r.id = c.id
   where t.pinned and public._msgr2_bf_target_pin(r.id, t.user_id)
     and not exists (select 1 from public.msgr_channel_prefs cp where cp.channel_id = r.id and cp.user_id = t.user_id)
  on conflict (room_id, user_id) do nothing;
  get diagnostics written = row_count;
  done := true;
end $$;

-- 13) 대기 결재 → 결재 expired + 일 cancelled(결재 id = 일 id). 다시 실행하지 않는다 — 일 행이 끝난 상태라 본체로 가는 봉투가 없다.
create or replace function public._msgr2_bf_approvals(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_works (id, room_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, source_message_id, tier, memory, text, state, expires_at, created_at, updated_at)
  select a.id, a.channel_id, cr.agent_id, cr.owner_user_id, 'user', coalesce(src.author_user_id, cr.owner_user_id), coalesce(src.author_user_id, cr.owner_user_id),
         src.id, 'guest', r.memory, left(a.action, 20000), 'cancelled', a.created_at, a.created_at, a.created_at
    from public.msgr_crew_approvals a
    join public.msgr2_rooms r on r.id = a.channel_id
    join public.msgr_crews cr on cr.id = a.crew_id and cr.agent_id is not null
    left join public.msgr2_messages src on src.id = coalesce(a.source_msg_id, a.dm_source_msg_id) and src.room_id = a.channel_id
   where a.status = 'pending'
  on conflict (id) do nothing;
  get diagnostics written = row_count;
  insert into public.msgr2_approvals (id, work_id, room_id, action, risk, summary, card_message_id, state, expires_at, created_at)
  select a.id, a.id, a.channel_id, a.action, a.risk, coalesce(nullif(a.reason, ''), a.action), card.id, 'expired', a.created_at, a.created_at
    from public.msgr_crew_approvals a
    join public.msgr2_works w on w.id = a.id
    left join public.msgr2_messages card on card.id = a.message_id and card.room_id = a.channel_id
   where a.status = 'pending'
  on conflict (id) do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

-- 14) 글 identity를 최댓값+1로(옛·새 글 id 중 큰 값 — 옮기지 않은 옛 id와도 겹치지 않게). 이미 그 위면 쓰지 않는다.
create or replace function public._msgr2_bf_identity(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare seq text := pg_get_serial_sequence('public.msgr2_messages', 'id'); top bigint; cur bigint; called boolean;
begin
  written := 0; done := true;
  top := greatest(coalesce((select max(id) from public.msgr2_messages), 0), coalesce((select max(id) from public.msgr_messages), 0));
  execute format('select last_value, is_called from %s', seq) into cur, called;
  if top > 0 and (cur < top or (cur = top and not called)) then perform setval(seq, top, true); written := 1; end if;
  next := top::text;
end $$;

-- ── 4. 입구 ─────────────────────────────────────────────────────────────────────
-- 한 번 부르기 = 그 작업의 한 묶음. 반환 {ok, job, generation, written, checkpoint, done} | {ok:false, code}.
-- code: busy(다른 실행기가 잡고 있다) · stale_generation(세대가 바뀌었다 — 처음부터 다시) · previous_step_pending(앞 단계가 안 끝났다).
-- 예외: msgr2_backfill_no_progress(묶음이 끝나지 않았는데 체크포인트가 그대로) · 단계 함수의 거부(agent_ids_missing·agent_id_conflict·room_without_space).
create or replace function public.msgr2_backfill_run(p_job text, p_gen int default null, p_worker text default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare j public.msgr2_backfill_jobs; r record;
begin
  perform public._msgr2_bf_begin();
  select * into j from public.msgr2_backfill_jobs where name = p_job for update skip locked;
  if not found then
    if exists (select 1 from public.msgr2_backfill_jobs where name = p_job) then return jsonb_build_object('ok', false, 'code', 'busy', 'job', p_job); end if;
    raise exception 'msgr2_backfill_unknown_job: %', p_job using errcode = '22023';
  end if;
  if p_gen is not null and p_gen <> j.generation then
    return jsonb_build_object('ok', false, 'code', 'stale_generation', 'job', p_job, 'generation', j.generation); end if;
  if exists (select 1 from public.msgr2_backfill_jobs b where b.step < j.step and b.done_at is null) then
    return jsonb_build_object('ok', false, 'code', 'previous_step_pending', 'job', p_job); end if;
  if j.done_at is not null then
    return jsonb_build_object('ok', true, 'job', p_job, 'generation', j.generation, 'written', 0, 'checkpoint', j.checkpoint, 'done', true); end if;
  execute format('select * from public.%I($1, $2)', '_msgr2_bf_' || j.name) into r using j.checkpoint, j.batch_limit;
  -- 끝나지 않았는데 체크포인트가 그대로면 같은 묶음을 끝없이 다시 읽는다 — 이 묶음을 되돌리고 멈춘다(실행기가 무한히 돌지 않게)
  if not r.done and r.next is not distinct from j.checkpoint then
    raise exception 'msgr2_backfill_no_progress: % at %', p_job, coalesce(j.checkpoint, '처음') using errcode = '55000'; end if;
  update public.msgr2_backfill_jobs set checkpoint = r.next, done_at = case when r.done then now() end, runs = runs + 1,
         rows_written = rows_written + r.written, claimed_by = left(p_worker, 80), claimed_at = now(), updated_at = now()
   where name = p_job;
  return jsonb_build_object('ok', true, 'job', p_job, 'generation', j.generation, 'written', r.written, 'checkpoint', r.next, 'done', r.done);
end $$;

-- 모든 작업을 처음 상태로(스위치 직전 두 번째 실행·되돌림 뒤 다시 실행). 세대 +1 — 돌고 있던 실행기는 다음 부르기에서 stale_generation으로 멈춘다.
-- 새 표 행은 건드리지 않는다(멱등이라 다시 돌아도 바뀐 행만 쓴다).
create or replace function public.msgr2_backfill_restart() returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare g int;
begin
  perform public._msgr2_bf_begin();
  update public.msgr2_backfill_jobs set generation = generation + 1, checkpoint = null, done_at = null, verified_at = null, runs = 0, rows_written = 0,
         claimed_by = null, claimed_at = null, updated_at = now();
  select max(generation) into g from public.msgr2_backfill_jobs;
  return g;
end $$;

-- ── 5. 검증(6절 2단계 확인 칸) ──────────────────────────────────────────────────
-- missing: 옛 행 중 새 표에 짝이 없는 수(표마다). rooms_mismatch: 방별 (id, md5(body)) 묶음 해시가 다른 방 수. sample_mismatch: 무작위 p_sample글 중 옮긴 값이 다른 글 수.
-- old_counts: 옛 표 행 수(실행 전후로 같아야 한다 — 런북이 실행 전 값과 대조한다). 모두 0이면 ok이고 모든 작업 행에 verified_at을 찍는다.
-- 첨부 서명 URL 20개 열기는 SQL로 못 한다 — 런북 4단계(맥 one, Storage API).
create or replace function public.msgr2_backfill_verify(p_sample int default 200) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare miss jsonb; rooms_bad bigint; sample_bad bigint; ok boolean; oc jsonb;
begin
  if auth.uid() is not null then raise exception 'msgr2_backfill_service_only' using errcode = '42501'; end if;
  miss := jsonb_build_object(
    'agents', (select count(*) from public.msgr_agents a where not exists (select 1 from public.msgr2_agents v where v.id = a.id)),
    'spaces_team', (select count(*) from public.msgr_orgs o where not exists (select 1 from public.msgr2_spaces s where s.id = o.id and s.kind = 'team')),
    'spaces_personal', (select count(*) from (select created_by u from public.msgr_channels where org_id is null union select user_id from public.msgr_org_members) x
                          where not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')),
    'space_members', (select count(*) from public.msgr_org_members m where not exists (select 1 from public.msgr2_space_members v
                        where v.space_id = m.org_id and v.user_id = m.user_id and v.role = m.role and v.removed_at is not distinct from m.removed_at and v.expires_at is not distinct from m.expires_at)),
    'seats', (select count(*) from public.msgr_crews c where c.org_id is not null and not exists (select 1 from public.msgr2_agent_seats s where s.agent_id = c.agent_id and s.space_id = c.org_id and s.removed_at is null)),
    'rooms', (select count(*) from public.msgr_channels c where not exists (select 1 from public.msgr2_rooms r where r.id = c.id)),
    'room_members', (select count(*) from public._msgr2_bf_room_members_src() s where not exists (select 1 from public.msgr2_room_members v
                       where (v.room_id, v.member_kind, v.member_id) = (s.room_id, s.member_kind, s.member_id) and v.removed_at is null)),
    'messages', (select count(*) from public.msgr_messages m where not exists (select 1 from public.msgr2_messages v where v.id = m.id)),
    'attachments', (select count(*) from public.msgr_attachments a where not exists (select 1 from public.msgr2_attachments v where v.message_id = a.message_id and v.storage_path = 'msgr/' || a.storage_path)),
    'reads', (select count(*) from public.msgr_reads x where not exists (select 1 from public.msgr2_reads v where v.room_id = x.channel_id and v.user_id = x.user_id and v.last_read_id >= x.last_read_id)),
    'reactions', (select count(*) from public.msgr_reactions x where not exists (select 1 from public.msgr2_reactions v where (v.message_id, v.user_id, v.emoji) = (x.message_id, x.user_id, x.emoji))),
    'prefs', (select count(*) from public.msgr_channel_prefs x where not exists (select 1 from public.msgr2_prefs v where v.room_id = x.channel_id and v.user_id = x.user_id and v.muted = x.muted and (v.pinned or not x.pinned))),
    'approvals', (select count(*) from public.msgr_crew_approvals a where a.status = 'pending' and not exists (select 1 from public.msgr2_approvals v where v.id = a.id and v.state = 'expired')),
    'identity', (select case when coalesce((select max(id) from public.msgr_messages), 0) = 0 then 0
                     when (select last_value from pg_sequences where schemaname = 'public' and sequencename = split_part(pg_get_serial_sequence('public.msgr2_messages', 'id'), '.', 2))
                          >= greatest(coalesce((select max(id) from public.msgr2_messages), 0), (select max(id) from public.msgr_messages)) then 0 else 1 end));
  -- 방별 (id, md5(body)) — 옛 채널 글과 같은 방의 v2 글 중 옛 id인 것
  select count(*) into rooms_bad from (
    select o.channel_id, md5(string_agg(o.id::text || ':' || md5(o.body), ',' order by o.id)) h from public.msgr_messages o group by o.channel_id) old
    full join (
    select v.room_id, md5(string_agg(v.id::text || ':' || md5(v.body), ',' order by v.id)) h from public.msgr2_messages v
     where exists (select 1 from public.msgr_messages o where o.id = v.id) group by v.room_id) nw on nw.room_id = old.channel_id
   where old.h is distinct from nw.h;
  select count(*) into sample_bad from (select * from public.msgr_messages order by random() limit greatest(1, least(coalesce(p_sample, 200), 10000))) o
    left join public.msgr2_messages v on v.id = o.id
   where v.id is null or (v.room_id, v.body, v.created_at, v.edited_at, v.deleted_at, coalesce(v.author_user_id, '00000000-0000-0000-0000-000000000000'))
         is distinct from (o.channel_id, o.body, o.created_at, o.edited_at, o.deleted_at,
                           coalesce(case when o.author_kind = 'user' then o.author_user_id end, '00000000-0000-0000-0000-000000000000'))
      or v.reply_to is distinct from coalesce(o.reply_to, o.thread_root);
  oc := jsonb_build_object('msgr_orgs', (select count(*) from public.msgr_orgs), 'msgr_org_members', (select count(*) from public.msgr_org_members),
    'msgr_channels', (select count(*) from public.msgr_channels), 'msgr_channel_members', (select count(*) from public.msgr_channel_members),
    'msgr_crews', (select count(*) from public.msgr_crews), 'msgr_agents', (select count(*) from public.msgr_agents),
    'msgr_messages', (select count(*) from public.msgr_messages), 'msgr_attachments', (select count(*) from public.msgr_attachments),
    'msgr_reads', (select count(*) from public.msgr_reads), 'msgr_reactions', (select count(*) from public.msgr_reactions),
    'msgr_channel_prefs', (select count(*) from public.msgr_channel_prefs), 'msgr_target_prefs', (select count(*) from public.msgr_target_prefs),
    'msgr_crew_approvals', (select count(*) from public.msgr_crew_approvals));
  ok := rooms_bad = 0 and sample_bad = 0 and not exists (select 1 from jsonb_each_text(miss) e where e.value <> '0');
  if ok then update public.msgr2_backfill_jobs set verified_at = now(), updated_at = now(); end if;
  return jsonb_build_object('ok', ok, 'missing', miss, 'rooms_mismatch', rooms_bad, 'sample_mismatch', sample_bad, 'sample', p_sample, 'old_counts', oc);
end $$;

-- ── 6. 실행 권한 — 서비스(service_role·postgres)만 ─────────────────────────────
revoke all on function public._msgr2_bf_begin(), public._msgr2_bf_uuid(text), public._msgr2_bf_room_shape(uuid),
  public._msgr2_bf_room_members_src(), public._msgr2_bf_target_pin(uuid, uuid),
  public._msgr2_bf_agents(text, int), public._msgr2_bf_spaces(text, int), public._msgr2_bf_space_members(text, int), public._msgr2_bf_seats(text, int),
  public._msgr2_bf_rooms(text, int), public._msgr2_bf_room_members(text, int), public._msgr2_bf_message_keys(text, int), public._msgr2_bf_messages(text, int), public._msgr2_bf_attachments(text, int),
  public._msgr2_bf_reads(text, int), public._msgr2_bf_reactions(text, int), public._msgr2_bf_prefs(text, int), public._msgr2_bf_target_prefs(text, int),
  public._msgr2_bf_approvals(text, int), public._msgr2_bf_identity(text, int),
  public.msgr2_backfill_run(text, int, text), public.msgr2_backfill_restart(), public.msgr2_backfill_verify(int)
  from public, anon, authenticated;
grant execute on function public.msgr2_backfill_run(text, int, text), public.msgr2_backfill_restart(), public.msgr2_backfill_verify(int) to service_role;
