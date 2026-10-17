-- 메신저 v2 U2 — 일·약속 서버(설계 2026-10-17 0절 D5·D8·D11·D12·D13·D15, 2절, 5절 표, 7절 경우 8·9·16·17·18·20·21·22).
-- 약속 정본: packages/agent-link/contract/v1.mjs(+README). 이 파일은 그 상태 표·거부 코드·lease_gen 규칙을 서버에서 강제한다.
--   판정 순서(v1 validateEnvelope와 같음): 모양 → v 범위 → type → 크기 → 방향 → 봉투 필드 → data. 그 뒤 기기 → 중단 스위치 → 일 → 중복·seq → 상태표 → 등급.
-- 의존: U1(*_msgr2_space.sql — 표·msgr2_access·_msgr2_device_ok), U3(*_msgr2_device.sql — msgr2_devices·_msgr2_session_id·_msgr2_device_ok/_kind).
--   이 파일은 U3 뒤 버전이다. 기기 행은 읽기만 한다.
-- 원칙
--   · 본체→서버는 msgr2_link_send(envelope) 한 곳. 서버→본체 봉투(offer·cancel·approval_decision)는 msgr2_work_events에 넣고 w:<주인 uid>로 방송,
--     본체는 (재)접속 때 msgr2_link_pending()으로 따라잡는다.
--   · 만료(expired)·결과 모름(stalled)은 읽을 때 계산한다(크론 없음). 쉬는 동안 쓰기 0 — 따라잡기·조회는 행을 쓰지 않는다.
--   · 담당 기기 한 대(D8): 에이전트별 리스(msgr2_agent_leases) 10분, accept가 CAS로 잡고 일하는 동안 연장한다. 일마다 lease_gen(세대)을 둔다.
--   · 같은 기기의 늦은 result·error는 받아서 일을 끝내고 방 글 meta에 work.late를 붙인다(LATE_MARK).
--   · C0 미룸 "같은 기기의 result·effect가 세대를 보지 않음" — 세대 검사를 넣지 않는다. 계약(nextState)이 세대를 보는 것은 accept뿐이고,
--     result·effect·error는 같은 기기(리스를 마지막으로 잡은 기기)면 받는다. 재시작한 본체는 일을 메모리에 들고 있지 않아 result를 보낼 수 없고(본체 의무, U4),
--     세대를 강제하면 정상적으로 끝난 늦은 결과(work.late)를 버리게 된다. 다른 기기는 not_lease_holder로 막힌다.
--   · 시스템 글은 코드 + 값(D15) — body는 비우고 meta.code·meta 값만. 원문(오류 문구)은 싣지 않는다.
--   · 상한(D11)은 msgr_settings에서 읽고(없으면 기본값), 만료·카운터도 읽을 때 계산한다.
--   · U1 미룸 "msgr2_lock_cols의 pg_trigger_depth() > 1 통과": 서버 코드는 잠긴 열을 바꾸지 않고, msgr2_* 표에는 cascade FK가 없어 이 통과가 필요 없다 → 없앤다.
--   · U5(메신저 연결 상태 기계, #1072)와 맞춘 입구: msgr2_service_pause()·msgr2_catch_up(p_since_id)·msgr2_attachment_add(글, 순번, 이름, mime, 크기)·
--     중단 중 사람 글 거부 'service_paused'. u:<uid> 방송(msg·pause·device_revoked)은 이 파일에 없다(미룸 — PR 본문).
--   · Storage 정책(버킷 msgr의 v2 경로 쓰기·읽기)은 이 파일에 없다(미룸). 슬롯·첨부 RPC는 경로와 행만 만든다.
-- 지우는 SQL 없음. 기억 데이터(글)는 지우지 않는다.

-- ── 0. U1 보완 ──────────────────────────────────────────────────────────────────
-- 잠금 트리거: 서비스 문맥(auth.uid() 없음 — 이전 U8·운영 도구)만 통과. 다른 트리거 안의 갱신도 소속 열을 바꾸지 못한다(U1 검수 미룸 정리).
create or replace function public.msgr2_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then raise exception 'msgr2_immutable_%', col using errcode = '42501'; end if;
  end loop;
  return new;
end $$;
revoke execute on function public.msgr2_lock_cols() from public, anon, authenticated;

-- 사람 글의 멘션(에이전트 id 배열). 서버가 방 멤버인 에이전트만 본다(모르는 id는 무시). 사람이 넣는 열이라 권한을 연다.
alter table public.msgr2_messages add column if not exists mentions uuid[] not null default '{}';
alter table public.msgr2_messages add column if not exists work_id uuid; -- 에이전트·시스템 글이 어느 일의 글인가(서버만 쓴다)
grant insert (mentions) on public.msgr2_messages to authenticated;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'msgr2_messages_mentions_max') then
    alter table public.msgr2_messages add constraint msgr2_messages_mentions_max check (cardinality(mentions) <= 20);
  end if;
end $$;

-- ── 1. 표 ───────────────────────────────────────────────────────────────────────
create table if not exists public.msgr2_works (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.msgr2_rooms (id),
  topic_id uuid references public.msgr2_topics (id),
  agent_id uuid not null references public.msgr2_agents (id),
  owner_user_id uuid not null,                         -- 에이전트 주인(= 받을 본체의 사용자)
  from_kind text not null check (from_kind in ('user', 'agent')),
  from_id uuid not null,                               -- 사람 uid 또는 넘긴 에이전트 id
  root_user_id uuid not null,                          -- 사슬을 시작한 사람(넘김 권한·상한 판정)
  source_message_id bigint references public.msgr2_messages (id),
  parent_work_id uuid references public.msgr2_works (id),
  depth int not null default 0 check (depth between 0 and 64),
  tier text not null check (tier in ('owner', 'team', 'guest')),
  memory boolean not null default true,
  text text not null default '',
  state text not null default 'offered' check (state in ('offered', 'accepted', 'running', 'awaiting_approval', 'done', 'failed', 'cancelled')),
  expires_at timestamptz not null,                     -- offered의 만료(30분). 지나면 읽을 때 expired
  lease_device uuid,                                   -- 이 일의 리스를 마지막으로 잡은 기기(stalled의 "같은 기기")
  lease_gen int not null default 0,                    -- accept 성공마다 +1(이어 하기는 그대로)
  lease_until timestamptz,
  has_result boolean not null default false,
  late boolean not null default false,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists msgr2_works_agent_at on public.msgr2_works (agent_id, created_at);
create index if not exists msgr2_works_room_at on public.msgr2_works (room_id, created_at);
create index if not exists msgr2_works_topic on public.msgr2_works (topic_id) where topic_id is not null;
create index if not exists msgr2_works_owner_at on public.msgr2_works (owner_user_id, created_at);
create index if not exists msgr2_works_live on public.msgr2_works (owner_user_id) where state in ('offered', 'accepted', 'running', 'awaiting_approval');

-- 봉투 기록. sender = server(서버→본체) | runner(본체→서버). 봉투 id 유일(agent.sync는 work 없이 id로만 중복 판정).
-- seq 유일 범위: 서버 쪽은 (work, seq), 본체 쪽은 (work, 기기, seq) — 약속의 "보낸 쪽"을 기기 하나로 읽는다.
--   본체마다 seq를 따로 센다(기기 A가 offer에 unsupported로 답한 뒤 기기 B가 accept해도 seq_conflict가 아니다).
create table if not exists public.msgr2_work_events (
  id bigint generated always as identity primary key,
  work_id uuid references public.msgr2_works (id),
  sender text not null check (sender in ('server', 'runner')),
  seq bigint not null check (seq >= 0),               -- 약속 v1 int = 안전 정수(≤ 2^53-1)
  type text not null,
  envelope_id uuid not null unique,
  device_id uuid,
  envelope jsonb not null,
  created_at timestamptz not null default now()
);
create unique index if not exists msgr2_work_events_server_seq on public.msgr2_work_events (work_id, seq) where work_id is not null and sender = 'server';
create unique index if not exists msgr2_work_events_runner_seq on public.msgr2_work_events (work_id, device_id, seq) where work_id is not null and sender = 'runner';
create index if not exists msgr2_work_events_work on public.msgr2_work_events (work_id, id);

-- 에이전트별 담당 기기(D8). 일이 있을 때만 쓰고 쉬면 저절로 만료된다(쓰기 0).
create table if not exists public.msgr2_agent_leases (
  agent_id uuid primary key references public.msgr2_agents (id),
  device_id uuid not null,
  lease_until timestamptz not null,
  gen int not null default 1
);

create table if not exists public.msgr2_approvals (
  id uuid primary key,                                 -- 본체가 정한 approval_id
  work_id uuid not null references public.msgr2_works (id),
  room_id uuid not null references public.msgr2_rooms (id),
  action text not null,
  risk text not null check (risk in ('low', 'medium', 'high')),
  summary text not null,
  effect_key text,
  card_message_id bigint references public.msgr2_messages (id),
  state text not null default 'pending' check (state in ('pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz not null,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists msgr2_approvals_work on public.msgr2_approvals (work_id);

-- 되돌릴 수 없는 일 기록 먼저(D13). intent는 (주인, 키)마다 한 번만. 결과를 모르면 읽을 때 unknown(일이 끝났거나 stalled인데 intent만 남음).
create table if not exists public.msgr2_effects (
  owner_user_id uuid not null,
  effect_key text not null check (char_length(effect_key) between 1 and 200),
  work_id uuid not null references public.msgr2_works (id),
  kind text,
  state text not null check (state in ('intent', 'done', 'failed')),
  at timestamptz not null default now(),
  primary key (owner_user_id, effect_key)
);
create index if not exists msgr2_effects_work on public.msgr2_effects (work_id);

-- 연속 에이전트 답장(D11 상한 8, 사람 글이 오면 0). 값이 바뀔 때만 쓴다.
create table if not exists public.msgr2_room_counters (
  room_id uuid primary key references public.msgr2_rooms (id),
  agent_streak int not null default 0,
  streak_noted boolean not null default false           -- 상한 시스템 글을 이번 연속에서 이미 남겼나(1회)
);

-- 업로드 슬롯(msgr2_link_upload_slot). 경로는 서버가 정한다: msgr/<공간>/<방>/<슬롯 uuid>/<파일 이름>.
create table if not exists public.msgr2_work_files (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.msgr2_works (id),
  room_id uuid not null references public.msgr2_rooms (id),
  name text not null check (char_length(name) between 1 and 200),
  bytes bigint not null check (bytes between 0 and 52428800),
  storage_path text not null unique,
  created_at timestamptz not null default now()
);
create index if not exists msgr2_work_files_work on public.msgr2_work_files (work_id);

-- 사람이 볼 수 있는 것: 일·승인은 그 방을 읽을 수 있으면(카드·진행 표시). 사건·리스·효과·카운터·슬롯은 RPC로만.
alter table public.msgr2_works enable row level security;
alter table public.msgr2_work_events enable row level security;
alter table public.msgr2_agent_leases enable row level security;
alter table public.msgr2_approvals enable row level security;
alter table public.msgr2_effects enable row level security;
alter table public.msgr2_room_counters enable row level security;
alter table public.msgr2_work_files enable row level security;
revoke all on public.msgr2_works, public.msgr2_work_events, public.msgr2_agent_leases, public.msgr2_approvals, public.msgr2_effects,
  public.msgr2_room_counters, public.msgr2_work_files from public, anon, authenticated;
grant select (id, room_id, topic_id, agent_id, owner_user_id, from_kind, from_id, state, expires_at, lease_until, has_result, late, error_code, created_at, updated_at)
  on public.msgr2_works to authenticated;
grant select (id, work_id, room_id, action, risk, summary, card_message_id, state, expires_at, decided_by, decided_at, created_at) on public.msgr2_approvals to authenticated;
drop policy if exists msgr2_works_select on public.msgr2_works;
create policy msgr2_works_select on public.msgr2_works for select to authenticated using ((select (public.msgr2_access(room_id)).read));
drop policy if exists msgr2_approvals_select on public.msgr2_approvals;
create policy msgr2_approvals_select on public.msgr2_approvals for select to authenticated using ((select (public.msgr2_access(room_id)).read));

-- ── 2. 보조 함수 ────────────────────────────────────────────────────────────────
-- 설정(D11) — msgr_settings(key, value)가 있으면 읽고, 없거나 값이 이상하면 기본값. 값은 운영에서 조정한다(추측값).
create or replace function public._msgr2_setting(p_key text) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  if to_regclass('public.msgr_settings') is null then return null; end if;
  execute 'select value from public.msgr_settings where key = $1' into v using p_key;
  return v;
exception when others then return null;
end $$;
create or replace function public._msgr2_setting_int(p_key text, p_default int) returns int
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text := public._msgr2_setting(p_key);
begin
  if v ~ '^[0-9]{1,9}$' then return v::int; end if;
  return p_default;
end $$;

-- 지금 요청한 기기(U3 msgr2_devices). 반환: (id, kind, runners, code) — code는 무효 사유(device_unknown·device_revoked·device_expired) 또는 null.
create or replace function public._msgr2_my_device(out id uuid, out kind text, out runners text[], out code text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare d record; ugen int;
begin
  select * into d from public.msgr2_devices x where x.session_id = public._msgr2_session_id() and x.user_id = auth.uid();
  if not found then code := 'device_unknown'; return; end if;
  ugen := coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0);
  if d.revoked_at is not null or d.gen <> ugen then code := 'device_revoked'; return; end if;
  if d.expires_at <= now() then code := 'device_expired'; return; end if;
  id := d.id; kind := d.kind; runners := d.runners; code := null;
end $$;

-- 방송(w:<uid>) — 실패해도 일·사건 기록은 남는다(본체는 재접속 때 msgr2_link_pending으로 따라잡는다). realtime 스키마가 없는 곳(시험)에서도 그대로.
create or replace function public._msgr2_send_w(p_uid uuid, p_env jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('envelope', p_env), coalesce(p_env->>'type', 'event'), 'w:' || p_uid::text, true);
exception when others then null;
end $$;

-- 일의 지금 상태(읽을 때 계산, D7): offered가 기한을 넘기면 expired, 일하는 중인데 리스가 끝났고 결과가 없으면 stalled.
create or replace function public._msgr2_effective_state(p_state text, p_expires timestamptz, p_lease_until timestamptz, p_has_result boolean) returns text
  language sql stable set search_path = public, pg_temp as $$
  select case
    when p_state = 'offered' and p_expires <= now() then 'expired'
    when p_state in ('accepted', 'running', 'awaiting_approval') and not p_has_result and not (p_lease_until > now()) then 'stalled'
    else p_state end
$$;

-- 시스템 글(D15): 본문은 비우고 meta.code + 값. 원문은 싣지 않는다.
create or replace function public._msgr2_system_msg(p_room uuid, p_topic uuid, p_work uuid, p_meta jsonb) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare mid bigint;
begin
  insert into public.msgr2_messages (room_id, topic_id, author_kind, kind, body, meta, work_id)
  values (p_room, p_topic, 'system', 'system', '', p_meta, p_work) returning id into mid;
  return mid;
end $$;

-- 서버→본체 봉투를 사건으로 남기고 방송한다. seq = 이 일의 서버 쪽 다음 번호.
create or replace function public._msgr2_server_event(p_work uuid, p_type text, p_device uuid, p_data jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare w public.msgr2_works; s bigint; env jsonb; eid uuid := gen_random_uuid();
begin
  select * into w from public.msgr2_works where id = p_work;
  select coalesce(max(seq), 0) + 1 into s from public.msgr2_work_events where work_id = p_work and sender = 'server';
  env := jsonb_build_object('v', 1, 'id', eid, 'work', p_work, 'seq', s, 'type', p_type, 'agent', w.agent_id, 'device', p_device,
    'at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'data', p_data);
  insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope) values (p_work, 'server', s, p_type, eid, p_device, env);
  perform public._msgr2_send_w(w.owner_user_id, env);
  return env;
end $$;

-- ── 3. 봉투 검사(v1 validateEnvelope와 같은 순서·같은 거부 코드, 본체→서버 type만 data까지 본다) ─────────────
-- 검사 함수는 값이 없을 때(null) 거짓을 돌려준다 — SQL의 null이 or 사슬을 통과시키지 않게.
create or replace function public._msgr2_j_uuid(j jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(j) = 'string' and (j #>> '{}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false) $$;
create or replace function public._msgr2_j_int(j jsonb, p_min numeric default 0) returns boolean language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric) and (j #>> '{}')::numeric >= p_min
     and (j #>> '{}')::numeric <= 9007199254740991 else false end $$;
create or replace function public._msgr2_j_num(j jsonb) returns boolean language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric >= 0 else false end $$;
create or replace function public._msgr2_j_str(j jsonb, p_min int, p_max int) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(j) = 'string' and char_length(j #>> '{}') between p_min and p_max, false) $$;
create or replace function public._msgr2_j_code(j jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(j) = 'string' and char_length(j #>> '{}') between 1 and 64 and (j #>> '{}') ~ '^[a-z][a-z0-9_]*$', false) $$;
create or replace function public._msgr2_j_ts(j jsonb) returns boolean language plpgsql immutable as $$
begin
  if j is null or jsonb_typeof(j) <> 'string' or (j #>> '{}') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$' then return false; end if;
  perform (j #>> '{}')::timestamptz; return true;
exception when others then return false;
end $$;
-- 있으면 규칙대로, 없으면 통과(optional), null이면 nullable일 때만
create or replace function public._msgr2_j_opt(j jsonb, p_ok boolean, p_nullable boolean default false) returns boolean language sql immutable as $$
  select j is null or (jsonb_typeof(j) = 'null' and p_nullable) or (jsonb_typeof(j) <> 'null' and p_ok) $$;

-- 거부 코드 또는 null(통과). p_min_v·p_max_v = 서버가 받는 v 범위(설정 link_min_v·link_max_v).
create or replace function public._msgr2_env_check(e jsonb, p_min_v int, p_max_v int) returns text
  language plpgsql immutable set search_path = public, pg_temp as $$
declare t text; d jsonb; x jsonb; sync boolean;
begin
  if jsonb_typeof(e) is distinct from 'object' then return 'invalid_envelope'; end if;
  if not public._msgr2_j_int(e->'v', 1) then return 'invalid_envelope'; end if;
  if (e->>'v')::numeric < p_min_v or (e->>'v')::numeric > p_max_v then return 'link_version_unsupported'; end if;
  if jsonb_typeof(e->'type') is distinct from 'string' then return 'invalid_envelope'; end if;
  t := e->>'type';
  if t not in ('work.offer', 'work.cancel', 'work.approval_decision', 'work.accept', 'work.progress', 'work.approval_request', 'work.effect',
               'work.result', 'work.error', 'agent.sync') then return 'unsupported_type'; end if;
  if octet_length(e::text) > 131072 then return 'too_large'; end if;
  if t in ('work.offer', 'work.cancel', 'work.approval_decision') then return 'wrong_direction'; end if;
  sync := t = 'agent.sync';
  -- 봉투 필드(v1: id·work·seq·agent·device·at·data — 모두 있어야 한다. agent.sync는 work가 null, agent는 null 허용)
  if not public._msgr2_j_uuid(e->'id') or not public._msgr2_j_int(e->'seq', 0) or not public._msgr2_j_uuid(e->'device') or not public._msgr2_j_ts(e->'at')
     or jsonb_typeof(e->'data') is distinct from 'object' or not (e ? 'work') or not (e ? 'agent') then return 'invalid_envelope'; end if;
  if sync then
    if jsonb_typeof(e->'work') <> 'null' then return 'invalid_envelope'; end if;
    if jsonb_typeof(e->'agent') <> 'null' and not public._msgr2_j_uuid(e->'agent') then return 'invalid_envelope'; end if;
  elsif not public._msgr2_j_uuid(e->'work') or not public._msgr2_j_uuid(e->'agent') then return 'invalid_envelope'; end if;
  d := e->'data';
  if t = 'work.accept' then
    if not public._msgr2_j_opt(d->'lease_gen', public._msgr2_j_int(d->'lease_gen', 1)) then return 'invalid_envelope'; end if;
  elsif t = 'work.progress' then
    if (d->>'stage') is null or (d->>'stage') not in ('thinking', 'tool', 'writing') or jsonb_typeof(d->'stage') <> 'string'
       or not public._msgr2_j_opt(d->'note', public._msgr2_j_str(d->'note', 0, 200)) then return 'invalid_envelope'; end if;
  elsif t = 'work.approval_request' then
    if not public._msgr2_j_uuid(d->'approval_id') or not public._msgr2_j_str(d->'action', 1, 200) or jsonb_typeof(d->'risk') is distinct from 'string'
       or (d->>'risk') not in ('low', 'medium', 'high') or not public._msgr2_j_str(d->'summary', 1, 2000)
       or not (d ? 'effect_key') or not public._msgr2_j_opt(d->'effect_key', public._msgr2_j_str(d->'effect_key', 1, 200), true)
       or not public._msgr2_j_ts(d->'expires_at') then return 'invalid_envelope'; end if;
  elsif t = 'work.effect' then
    if not public._msgr2_j_str(d->'effect_key', 1, 200) or jsonb_typeof(d->'state') is distinct from 'string' or (d->>'state') not in ('intent', 'done', 'failed')
       or not public._msgr2_j_opt(d->'kind', public._msgr2_j_code(d->'kind')) then return 'invalid_envelope'; end if;
  elsif t = 'work.result' then
    if not public._msgr2_j_str(d->'text', 0, 20000) or jsonb_typeof(d->'files') is distinct from 'array' or jsonb_array_length(d->'files') > 20
       or jsonb_typeof(d->'handoffs') is distinct from 'array' or jsonb_array_length(d->'handoffs') > 8 then return 'invalid_envelope'; end if;
    for x in select * from jsonb_array_elements(d->'files') loop if not public._msgr2_j_uuid(x) then return 'invalid_envelope'; end if; end loop;
    for x in select * from jsonb_array_elements(d->'handoffs') loop
      if jsonb_typeof(x) <> 'object' or not public._msgr2_j_uuid(x->'agent') or not public._msgr2_j_str(x->'text', 1, 4000) then return 'invalid_envelope'; end if;
    end loop;
    if d ? 'usage' and jsonb_typeof(d->'usage') not in ('object', 'null') then return 'invalid_envelope'; end if;
    if jsonb_typeof(d->'usage') = 'object' and not (
         public._msgr2_j_opt(d->'usage'->'input_tokens', public._msgr2_j_int(d->'usage'->'input_tokens', 0))
     and public._msgr2_j_opt(d->'usage'->'output_tokens', public._msgr2_j_int(d->'usage'->'output_tokens', 0))
     and public._msgr2_j_opt(d->'usage'->'cost_usd', public._msgr2_j_num(d->'usage'->'cost_usd'))
     and public._msgr2_j_opt(d->'usage'->'runner', public._msgr2_j_str(d->'usage'->'runner', 0, 64))
     and public._msgr2_j_opt(d->'usage'->'model', public._msgr2_j_str(d->'usage'->'model', 0, 200))) then return 'invalid_envelope'; end if;
  elsif t = 'work.error' then
    if not public._msgr2_j_code(d->'code') or not (d ? 'runner') or not public._msgr2_j_opt(d->'runner', public._msgr2_j_str(d->'runner', 0, 64), true)
       or not public._msgr2_j_opt(d->'retry_at', public._msgr2_j_ts(d->'retry_at'), true) then return 'invalid_envelope'; end if;
  elsif t = 'agent.sync' then
    if jsonb_typeof(d->'agents') is distinct from 'array' or jsonb_array_length(d->'agents') > 500 then return 'invalid_envelope'; end if;
    for x in select * from jsonb_array_elements(d->'agents') loop
      if jsonb_typeof(x) <> 'object' or not public._msgr2_j_str(x->'ws', 1, 200) or not public._msgr2_j_str(x->'slug', 1, 200)
         or not public._msgr2_j_str(x->'name', 1, 200) or not public._msgr2_j_str(x->'role', 0, 2000)
         or not (x ? 'face_hash') or not public._msgr2_j_opt(x->'face_hash', public._msgr2_j_str(x->'face_hash', 0, 128), true) then return 'invalid_envelope'; end if;
    end loop;
  end if;
  return null;
end $$;

-- ── 4. offer 만들기(사람 글 트리거·넘김이 부른다) ─────────────────────────────────
-- 넘김할 수 있는 동료(offer.peers[], 총괄 지시 2026-10-17). 같은 방의 활동 중인 다른 에이전트 중, 사슬을 시작한 사람(p_root_user)이
-- 그 에이전트에게 시킬 수 있는 것만(개인 공간 = 주인만, 팀 공간 = 파견 행 allow). guest 등급이면 빈 배열(D12). 이름이 비면 slug. 50개까지.
-- 넘김(result.handoffs[])을 받을 때도 이 목록으로 다시 본다 — offer에 실은 목록과 서버가 받는 넘김이 같은 규칙이다.
create or replace function public._msgr2_peers(p_room uuid, p_agent uuid, p_root_user uuid, p_tier text) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('agent', q.id, 'name', q.name, 'role', q.role) order by q.name, q.id), '[]'::jsonb) from (
    select a.id, left(coalesce(nullif(a.display_name, ''), a.slug), 200) as name, left(a.role_text, 2000) as role
      from public.msgr2_room_members m
      join public.msgr2_agents a on a.id = m.member_id and a.status = 'active'
      join public.msgr2_rooms r on r.id = m.room_id and r.archived_at is null and r.agent_policy <> 'blocked'
      join public.msgr2_spaces s on s.id = r.space_id and s.deleted_at is null
      left join public.msgr2_agent_seats st on st.agent_id = a.id and st.space_id = s.id and st.removed_at is null
     where m.room_id = p_room and m.member_kind = 'agent' and m.removed_at is null and a.id <> p_agent
       and p_tier is distinct from 'guest'
       and case when s.kind = 'personal' then a.owner_user_id = p_root_user
                else st.agent_id is not null and (st.allow = 'all' or a.owner_user_id = p_root_user or (st.allow = 'list' and p_root_user = any (st.allow_users))) end
     order by name, a.id limit 50) q
$$;

-- 반환: 만든 일 id, 또는 null(대상 아님·상한). 상한에 걸리면 시스템 글 1개(code work.limit, limit = 어느 상한).
-- 지시 권한: 개인 공간은 에이전트 주인만. 팀 공간은 그 에이전트의 파견 행(활성) 기준 allow — all = 그 방에 쓸 수 있는 사람, owner = 주인만, list = 주인 + allow_users.
-- 문맥: 그 방의 최근 글(지운 글 제외)을 새 글부터 모아 JSON 16KB를 넘기 직전까지, 시간순으로 싣는다. 등급(tier)은 방의 사람 구성(msgr2_access).
create or replace function public._msgr2_make_offer(p_room uuid, p_topic uuid, p_agent uuid, p_from_kind text, p_from_id uuid, p_root_user uuid,
  p_text text, p_source bigint, p_parent uuid, p_depth int) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  r public.msgr2_rooms; s public.msgr2_spaces; a public.msgr2_agents; seat public.msgr2_agent_seats; ctr public.msgr2_room_counters;
  wid uuid := gen_random_uuid(); tid uuid := p_topic; tier text; ctx jsonb := '[]'::jsonb; item jsonb; total int := 2; m record;
  lim text; dev uuid; ttl_s int := public._msgr2_setting_int('msgr2_offer_ttl_s', 1800);
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select * into a from public.msgr2_agents where id = p_agent;
  if r.id is null or s.deleted_at is not null or r.archived_at is not null or r.agent_policy = 'blocked' or a.id is null or a.status <> 'active' then return null; end if;
  if not exists (select 1 from public.msgr2_room_members where room_id = p_room and member_kind = 'agent' and member_id = p_agent and removed_at is null) then return null; end if;
  if s.kind = 'personal' then
    if p_root_user <> a.owner_user_id then return null; end if;
  else
    select * into seat from public.msgr2_agent_seats where agent_id = p_agent and space_id = s.id and removed_at is null;
    if seat.agent_id is null then return null; end if;
    if seat.allow = 'owner' and p_root_user <> a.owner_user_id then return null; end if;
    if seat.allow = 'list' and p_root_user <> a.owner_user_id and not (p_root_user = any (seat.allow_users)) then return null; end if;
  end if;
  -- 상한(D11): 연속 답장(에이전트가 촉발한 일만), 분당 에이전트·방, 토픽당, 주인 하루
  if p_from_kind = 'agent' then
    select * into ctr from public.msgr2_room_counters where room_id = p_room;
    if coalesce(ctr.agent_streak, 0) >= public._msgr2_setting_int('msgr2_limit_streak', 8) then
      if not coalesce(ctr.streak_noted, false) then
        update public.msgr2_room_counters set streak_noted = true where room_id = p_room;
        perform public._msgr2_system_msg(p_room, p_topic, null, jsonb_build_object('code', 'work.limit', 'limit', 'streak'));
      end if;
      return null;
    end if;
  end if;
  lim := case
    when (select count(*) from public.msgr2_works where agent_id = p_agent and created_at > now() - interval '1 minute') >= public._msgr2_setting_int('msgr2_limit_agent_min', 10) then 'agent_minute'
    when (select count(*) from public.msgr2_works where room_id = p_room and created_at > now() - interval '1 minute') >= public._msgr2_setting_int('msgr2_limit_room_min', 30) then 'room_minute'
    when p_topic is not null and (select count(*) from public.msgr2_works where topic_id = p_topic) >= public._msgr2_setting_int('msgr2_limit_topic', 30) then 'topic'
    when (select count(*) from public.msgr2_works where owner_user_id = a.owner_user_id and created_at > now() - interval '1 day') >= public._msgr2_setting_int('msgr2_limit_owner_day', 500) then 'owner_day'
  end;
  if lim is not null then
    perform public._msgr2_system_msg(p_room, p_topic, null, jsonb_build_object('code', 'work.limit', 'limit', lim, 'agent', p_agent));
    return null;
  end if;
  tier := coalesce((public.msgr2_access(p_room)).tier, 'guest'); -- 부른 사람(글쓴이·넘긴 일의 주인)이 못 읽는 방이면 가장 좁은 등급
  for m in select x.id, x.author_kind, x.author_user_id, x.author_agent_id, x.body, x.created_at from public.msgr2_messages x
             where x.room_id = p_room and x.deleted_at is null and x.kind <> 'system' and (p_source is null or x.id <> p_source)
             order by x.id desc limit 200 loop
    item := jsonb_build_object('id', m.id,
      'author', jsonb_build_object('kind', m.author_kind, 'id', coalesce(m.author_user_id, m.author_agent_id)),
      'text', left(m.body, 20000), 'at', to_char(m.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    total := total + octet_length(item::text) + 2;
    exit when total > 16384;
    ctx := jsonb_build_array(item) || ctx;
  end loop;
  if tid is null then
    insert into public.msgr2_topics (room_id, title, work_id) values (p_room, left(split_part(coalesce(p_text, ''), E'\n', 1), 40), wid) returning id into tid;
  end if;
  insert into public.msgr2_works (id, room_id, topic_id, agent_id, owner_user_id, from_kind, from_id, root_user_id, source_message_id, parent_work_id, depth, tier, memory, text, expires_at)
  values (wid, p_room, tid, p_agent, a.owner_user_id, p_from_kind, p_from_id, p_root_user, p_source, p_parent, p_depth, tier, r.memory, left(coalesce(p_text, ''), 20000),
          now() + make_interval(secs => ttl_s));
  select l.device_id into dev from public.msgr2_agent_leases l where l.agent_id = p_agent and l.lease_until > now();
  perform public._msgr2_server_event(wid, 'work.offer', dev, jsonb_build_object(
    'room', p_room, 'topic', tid, 'from', jsonb_build_object('kind', p_from_kind, 'id', p_from_id), 'text', left(coalesce(p_text, ''), 20000),
    'context', ctx, 'attachments', '[]'::jsonb, 'memory', r.memory, 'peers', public._msgr2_peers(p_room, p_agent, p_root_user, tier),
    'limits', jsonb_build_object('tier', tier, 'max_turn_s', public._msgr2_setting_int('msgr2_max_turn_s', 900), 'budget', null),
    'expires_at', to_char((now() + make_interval(secs => ttl_s)) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  return wid;
end $$;

-- 사람 글 → offer(멘션한 에이전트, 멘션이 없으면 "에이전트 1:1"(활동 중인 사람 멤버가 글쓴이 하나, 에이전트 멤버가 하나)의 그 에이전트).
-- 사람 글이 오면 연속 답장 카운터를 0으로(값이 바뀔 때만 쓴다).
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
drop trigger if exists msgr2_on_user_message on public.msgr2_messages;
create trigger msgr2_on_user_message after insert on public.msgr2_messages for each row when (new.author_kind = 'user') execute function public.msgr2_on_user_message();

-- 중단 스위치(U5): 켜져 있으면 사람 글 쓰기를 'service_paused'로 거부한다(서비스 문맥 — 이전 U8 — 은 통과).
create or replace function public.msgr2_pause_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  return new;
end $$;
drop trigger if exists msgr2_pause_guard on public.msgr2_messages;
create trigger msgr2_pause_guard before insert on public.msgr2_messages for each row when (new.author_kind = 'user') execute function public.msgr2_pause_guard();

-- 에이전트 글이면 연속 카운터 +1
create or replace function public._msgr2_bump_streak(p_room uuid) returns void
  language sql volatile security definer set search_path = public, pg_temp as $$
  insert into public.msgr2_room_counters as c (room_id, agent_streak) values (p_room, 1)
  on conflict (room_id) do update set agent_streak = c.agent_streak + 1
$$;

-- ── 5. 상태 전이(v1 nextState를 그대로 옮김 — test/msgr2-work-contract-pg가 JS와 칸마다 대조한다) ──────────────
-- p_state = _msgr2_effective_state 결과, p_same = 봉투의 기기가 이 일의 리스를 마지막으로 잡은 기기인가, p_lease_gen = 그 리스 세대.
create or replace function public._msgr2_next_state(p_state text, p_type text, p_data jsonb, p_same boolean, p_lease_gen int,
  out ok boolean, out to_state text, out mark text, out code text)
  language plpgsql immutable set search_path = public, pg_temp as $$
declare
  live text[] := array['accepted', 'running', 'awaiting_approval'];
  term text[] := array['done', 'failed', 'cancelled', 'expired'];
  tr jsonb := '{
    "offered": {"work.accept": "accepted", "work.cancel": "cancelled", "work.error": "same"},
    "accepted": {"work.accept": "same", "work.approval_request": "awaiting_approval", "work.effect": "same", "work.result": "done", "work.error": "failed", "work.cancel": "cancelled"},
    "running": {"work.accept": "same", "work.approval_request": "awaiting_approval", "work.effect": "same", "work.result": "done", "work.error": "failed", "work.cancel": "cancelled"},
    "awaiting_approval": {"work.accept": "same", "work.approval_decision": "running", "work.effect": "same", "work.error": "failed", "work.cancel": "cancelled"},
    "done": {"work.effect": "same", "work.cancel": "same"},
    "failed": {"work.effect": "same", "work.cancel": "same"},
    "cancelled": {"work.effect": "same", "work.cancel": "same", "work.error": "same"},
    "expired": {"work.cancel": "same"}
  }'::jsonb;
  nxt text; genok boolean;
begin
  ok := false;
  genok := coalesce(p_lease_gen is not null and jsonb_typeof(p_data->'lease_gen') = 'number' and (p_data->>'lease_gen')::numeric = p_lease_gen, false);
  if p_state = 'stalled' then
    if p_type = 'work.cancel' then ok := true; to_state := 'cancelled'; return; end if;
    if not p_same then code := 'not_lease_holder'; return; end if;
    if p_type = 'work.accept' then
      if genok then ok := true; to_state := 'running'; else code := 'not_lease_holder'; end if; return;
    end if;
    if p_type = 'work.effect' and (p_data->>'state') is distinct from 'intent' then ok := true; to_state := p_state; return; end if;
    if p_type = 'work.result' then ok := true; to_state := 'done'; mark := 'work.late'; return; end if;
    if p_type = 'work.error' then ok := true; to_state := 'failed'; mark := 'work.late'; return; end if;
    code := 'invalid_transition'; return;
  end if;
  if p_type = 'work.accept' and p_state = any (live) and not (p_same and genok) then code := 'lease_held'; return; end if;
  if tr->p_state is null then code := 'invalid_transition'; return; end if;
  nxt := tr->p_state->>p_type;
  if nxt is null then code := case when p_state = any (term) then 'work_closed' else 'invalid_transition' end; return; end if;
  if p_type = 'work.error' and p_state = 'offered' and (p_data->>'code') is distinct from 'unsupported' then code := 'invalid_transition'; return; end if;
  if p_type = 'work.effect' and (p_data->>'state') = 'intent' and not (p_state in ('accepted', 'running')) then
    code := case when p_state = any (term) then 'work_closed' else 'invalid_transition' end; return;
  end if;
  ok := true; to_state := case when nxt = 'same' then p_state else nxt end;
end $$;

-- guest 등급이 할 수 없는 봉투(D12, v1 tierAllows)
create or replace function public._msgr2_tier_allows(p_tier text, p_type text, p_data jsonb) returns boolean
  language sql immutable as $$
  select p_tier is distinct from 'guest' or not coalesce(
    p_type in ('work.approval_request', 'work.effect')
    or (p_type = 'work.result' and jsonb_typeof(p_data->'files') = 'array' and jsonb_array_length(p_data->'files') > 0), false)
$$;

create or replace function public._msgr2_rej(p_code text) returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'retry', p_code in ('rate_limited', 'internal')) $$;

-- v2 중단 스위치: msgr_settings 한 줄 key = 'msgr2_paused', value = 중단 시각(ISO). 옛 메신저 스위치(msgr_paused, 20261016170000)와 같은 관례이고
-- 키는 따로 둔다 — 옛 스위치는 지금 켜져 있고(2026-10-16 중단), v2는 그와 별개로 켜고 끈다. 끄기 = 그 행 삭제(설정 행이라 기억 데이터 아님).
create or replace function public._msgr2_paused() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public._msgr2_setting('msgr2_paused') <> '', false) $$;

-- 일 오류 코드 정규화(v1 normalizeWorkErrorCode)
create or replace function public._msgr2_norm_error(p_code text) returns text language sql immutable as $$
  select case when p_code in ('limit', 'no_runner', 'login', 'timeout', 'cancelled', 'unsupported', 'tier_denied', 'budget', 'internal') then p_code else 'internal' end $$;

-- ── 6. 본체 → 서버 입구 ─────────────────────────────────────────────────────────
-- 반환: {ok:true, state, duplicate?, lease_gen?, lease_until?, agents?} | {ok:false, code, retry}(v1 REJECT_CODES).
-- 거부는 예외가 아니라 값으로 돌려준다(거부 전에는 아무것도 쓰지 않는다). 같은 봉투(같은 id·seq·기기)를 다시 보내면 쓰기 없이 duplicate.
-- work.progress는 검사만 하고 기록하지 않는다(자주 오므로 쓰기 0, 화면의 "생각 중" 표시는 U5 미룸).
create or replace function public.msgr2_link_send(p_env jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); dv record; c text; t text; d jsonb; w public.msgr2_works; ev public.msgr2_work_events; ns record;
  st text; same boolean; v_until timestamptz := now() + make_interval(secs => public._msgr2_setting_int('msgr2_lease_s', 600));
  lg int; mid bigint; x jsonb; slots uuid[]; n int; agents jsonb := '[]'::jsonb; v_late boolean; meta jsonb; ecode text; ap_exp timestamptz;
begin
  c := public._msgr2_env_check(p_env, public._msgr2_setting_int('msgr2_link_min_v', 1), public._msgr2_setting_int('msgr2_link_max_v', 1));
  if c is not null then return public._msgr2_rej(c); end if;
  if uid is null then return public._msgr2_rej('device_unknown'); end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null then return public._msgr2_rej(dv.code); end if;
  if dv.kind not in ('runner', 'resident') or dv.id <> (p_env->>'device')::uuid then return public._msgr2_rej('device_unknown'); end if;
  if public._msgr2_paused() then return public._msgr2_rej('service_paused'); end if;
  t := p_env->>'type'; d := p_env->'data';

  -- 같은 봉투 다시 보내기(본체 재시도) — 쓰기 없이 같은 답
  select * into ev from public.msgr2_work_events where envelope_id = (p_env->>'id')::uuid;
  if found then
    if ev.sender = 'runner' and ev.device_id = dv.id and ev.type = t and ev.seq = (p_env->>'seq')::bigint
       and ev.work_id is not distinct from (p_env->>'work')::uuid then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    return public._msgr2_rej('seq_conflict');
  end if;

  if t = 'agent.sync' then
    perform public.msgr2_agent_sync(coalesce((select jsonb_agg(jsonb_build_object('ws_id', a->>'ws', 'slug', a->>'slug', 'display_name', a->>'name',
      'role_text', a->>'role', 'face', case when jsonb_typeof(a->'face_hash') = 'string' then jsonb_build_object('hash', a->>'face_hash') end))
      from jsonb_array_elements(d->'agents') a), '[]'::jsonb));
    select coalesce(jsonb_agg(jsonb_build_object('ws', g.ws_id, 'slug', g.slug, 'id', g.id) order by g.ws_id, g.slug), '[]'::jsonb) into agents
      from public.msgr2_agents g join jsonb_array_elements(d->'agents') a on g.ws_id = a->>'ws' and g.slug = a->>'slug' where g.owner_user_id = uid;
    insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope)
    values (null, 'runner', (p_env->>'seq')::bigint, t, (p_env->>'id')::uuid, dv.id, p_env - 'data'); -- 목록 본문은 에이전트 표에 있다
    return jsonb_build_object('ok', true, 'agents', agents);
  end if;

  select * into w from public.msgr2_works where id = (p_env->>'work')::uuid for update;
  if not found or w.owner_user_id <> uid or w.agent_id <> (p_env->>'agent')::uuid then return public._msgr2_rej('work_not_found'); end if;
  if exists (select 1 from public.msgr2_work_events e where e.work_id = w.id and e.sender = 'runner' and e.device_id = dv.id and e.seq = (p_env->>'seq')::bigint) then
    return public._msgr2_rej('seq_conflict');
  end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  same := w.lease_device is not distinct from dv.id;

  if t = 'work.progress' then
    if st in ('accepted', 'running', 'awaiting_approval') then
      return case when same then jsonb_build_object('ok', true, 'state', st) else public._msgr2_rej('not_lease_holder') end;
    end if;
    return public._msgr2_rej(case when st in ('done', 'failed', 'cancelled', 'expired') then 'work_closed' else 'invalid_transition' end);
  end if;
  -- 리스를 잡은 일에는 그 기기만(accept 제외 — accept는 상태표가 lease_held로 가른다). offered의 unsupported 답은 주인의 어느 본체든.
  if t <> 'work.accept' and w.lease_device is not null and not same and st <> 'stalled' then return public._msgr2_rej('not_lease_holder'); end if;

  select * into ns from public._msgr2_next_state(st, t, d, same, case when w.lease_gen > 0 then w.lease_gen end);
  if not ns.ok then return public._msgr2_rej(ns.code); end if;
  if not public._msgr2_tier_allows(w.tier, t, d) then return public._msgr2_rej('tier_denied'); end if;
  v_late := ns.mark is not null;

  if t = 'work.accept' then
    insert into public.msgr2_agent_leases as l (agent_id, device_id, lease_until, gen) values (w.agent_id, dv.id, v_until, 1)
    on conflict (agent_id) do update set device_id = excluded.device_id, lease_until = greatest(l.lease_until, excluded.lease_until),
      gen = l.gen + case when l.device_id = excluded.device_id then 0 else 1 end
    where l.lease_until <= now() or l.device_id = excluded.device_id;
    get diagnostics n = row_count;
    if n = 0 then return public._msgr2_rej('lease_held'); end if;
    if st = 'offered' then
      update public.msgr2_works set state = 'accepted', lease_device = dv.id, lease_gen = lease_gen + 1, lease_until = v_until, updated_at = now()
        where id = w.id returning lease_gen into lg;
    else -- 연장(같은 상태) 또는 이어 하기(stalled → running). 세대는 그대로.
      update public.msgr2_works set state = ns.to_state, lease_until = v_until, updated_at = now() where id = w.id returning lease_gen into lg;
    end if;
  elsif t = 'work.approval_request' then
    if exists (select 1 from public.msgr2_approvals where id = (d->>'approval_id')::uuid) then return public._msgr2_rej('invalid_envelope'); end if;
    ap_exp := least((d->>'expires_at')::timestamptz, now() + interval '7 days');
    mid := null;
    insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
    values (w.room_id, w.topic_id, 'agent', w.agent_id, 'card', d->>'summary',
      jsonb_build_object('code', 'approval.request', 'approval', d->>'approval_id', 'action', d->>'action', 'risk', d->>'risk',
        'expires_at', to_char(ap_exp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), w.id) returning id into mid;
    insert into public.msgr2_approvals (id, work_id, room_id, action, risk, summary, effect_key, card_message_id, expires_at)
    values ((d->>'approval_id')::uuid, w.id, w.room_id, d->>'action', d->>'risk', d->>'summary', d->>'effect_key', mid, ap_exp);
    update public.msgr2_works set state = 'awaiting_approval', updated_at = now() where id = w.id;
  elsif t = 'work.effect' then
    if d->>'state' = 'intent' then
      insert into public.msgr2_effects (owner_user_id, effect_key, work_id, kind, state) values (uid, d->>'effect_key', w.id, d->>'kind', 'intent')
      on conflict (owner_user_id, effect_key) do nothing;
      get diagnostics n = row_count;
      if n = 0 then return public._msgr2_rej('effect_exists'); end if;
    else
      update public.msgr2_effects set state = d->>'state', at = now()
        where owner_user_id = uid and effect_key = d->>'effect_key' and work_id = w.id and state = 'intent';
      get diagnostics n = row_count;
      if n = 0 then return public._msgr2_rej('effect_unknown'); end if;
    end if;
  elsif t = 'work.result' then
    select coalesce(array_agg((f #>> '{}')::uuid), '{}') into slots from jsonb_array_elements(d->'files') f;
    if cardinality(slots) <> (select count(distinct s) from unnest(slots) s)
       or (select count(*) from public.msgr2_work_files wf where wf.id = any (slots) and wf.work_id = w.id) <> cardinality(slots) then
      return public._msgr2_rej('upload_slot_invalid');
    end if;
    meta := jsonb_build_object('work', w.id) || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end;
    insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
    values (w.room_id, w.topic_id, 'agent', w.agent_id, 'text', d->>'text', meta, w.id) returning id into mid;
    insert into public.msgr2_attachments (message_id, room_id, storage_path, name, bytes)
      select mid, w.room_id, wf.storage_path, wf.name, wf.bytes from public.msgr2_work_files wf where wf.id = any (slots) order by array_position(slots, wf.id);
    update public.msgr2_works set state = 'done', has_result = true, late = v_late, updated_at = now() where id = w.id;
    perform public._msgr2_bump_streak(w.room_id);
    for x in select * from jsonb_array_elements(d->'handoffs') loop
      if w.depth + 1 > public._msgr2_setting_int('msgr2_limit_depth', 16) then
        perform public._msgr2_system_msg(w.room_id, w.topic_id, w.id, jsonb_build_object('code', 'work.limit', 'limit', 'depth', 'agent', x->>'agent'));
        exit;
      end if;
      continue when not exists (select 1 from jsonb_array_elements(public._msgr2_peers(w.room_id, w.agent_id, w.root_user_id, w.tier)) pe where pe->>'agent' = x->>'agent');
      perform public._msgr2_make_offer(w.room_id, w.topic_id, (x->>'agent')::uuid, 'agent', w.agent_id, w.root_user_id, x->>'text', mid, w.id, w.depth + 1);
    end loop;
  elsif t = 'work.error' then
    ecode := public._msgr2_norm_error(d->>'code');
    if ns.to_state = 'failed' then
      update public.msgr2_works set state = 'failed', error_code = ecode, late = v_late, updated_at = now() where id = w.id;
      perform public._msgr2_system_msg(w.room_id, w.topic_id, w.id, jsonb_build_object('code', 'work.error', 'error', ecode, 'agent', w.agent_id, 'work', w.id)
        || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end);
    end if; -- offered(unsupported)·cancelled는 기록만
  end if;

  insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope)
  values (w.id, 'runner', (p_env->>'seq')::bigint, t, (p_env->>'id')::uuid, dv.id, p_env);
  return jsonb_build_object('ok', true, 'state', ns.to_state)
    || case when t = 'work.accept' then jsonb_build_object('lease_gen', lg, 'lease_until', to_char(v_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) else '{}'::jsonb end;
end $$;

-- ── 7. 따라잡기·업로드 슬롯(쓰기 없음 / 슬롯 1행) ────────────────────────────────
-- 본체가 (재)접속 때 부른다. 받을 봉투: ① 아직 살아 있는 offer(이 기기 지정이거나 지정 없음, 다른 기기가 그 에이전트 리스를 쥐고 있지 않음)
-- ② 이 기기가 리스를 잡은 일의 cancel·approval_decision(하루 안). 본체는 봉투 id로 중복을 거른다. 행을 쓰지 않는다.
create or replace function public.msgr2_link_pending() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); dv record; envs jsonb;
begin
  if uid is null then return public._msgr2_rej('device_unknown'); end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null then return public._msgr2_rej(dv.code); end if;
  if dv.kind not in ('runner', 'resident') then return public._msgr2_rej('device_unknown'); end if;
  if public._msgr2_paused() then return public._msgr2_rej('service_paused'); end if;
  select coalesce(jsonb_agg(q.envelope order by q.id), '[]'::jsonb) into envs from (
    select e.id, e.envelope from public.msgr2_work_events e join public.msgr2_works w on w.id = e.work_id
     where w.owner_user_id = uid and w.state = 'offered' and w.expires_at > now() and cardinality(dv.runners) > 0
       and e.sender = 'server' and e.type = 'work.offer' and (e.device_id is null or e.device_id = dv.id)
       and not exists (select 1 from public.msgr2_agent_leases l where l.agent_id = w.agent_id and l.lease_until > now() and l.device_id <> dv.id)
    union all
    select e.id, e.envelope from public.msgr2_work_events e join public.msgr2_works w on w.id = e.work_id
     where w.owner_user_id = uid and w.lease_device = dv.id and w.updated_at > now() - interval '1 day'
       and e.sender = 'server' and e.type in ('work.cancel', 'work.approval_decision') and e.created_at > now() - interval '1 day'
    order by 1 limit 200) q;
  return jsonb_build_object('ok', true, 'envelopes', envs);
end $$;

-- 결과 파일 자리. 리스를 쥔 기기만, 일하는 중(accepted·running)에만, guest 등급은 안 된다. 일마다 슬롯 20개까지.
-- 경로는 서버가 정한다: 버킷 msgr 안 <공간>/<방>/<슬롯>/<이름>(첨부 행 storage_path = 'msgr/' || 그 경로). 이 경로의 Storage 쓰기 정책은 U5(첨부) 미룸.
create or replace function public.msgr2_link_upload_slot(p_work uuid, p_name text, p_bytes bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); dv record; w public.msgr2_works; st text; nm text; sid uuid := gen_random_uuid(); obj text; sp uuid;
begin
  if uid is null then return public._msgr2_rej('device_unknown'); end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null then return public._msgr2_rej(dv.code); end if;
  if dv.kind not in ('runner', 'resident') then return public._msgr2_rej('device_unknown'); end if;
  if public._msgr2_paused() then return public._msgr2_rej('service_paused'); end if;
  select * into w from public.msgr2_works where id = p_work for update;
  if not found or w.owner_user_id <> uid then return public._msgr2_rej('work_not_found'); end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  if st in ('done', 'failed', 'cancelled', 'expired') then return public._msgr2_rej('work_closed'); end if;
  if w.lease_device is distinct from dv.id or st = 'stalled' then return public._msgr2_rej('not_lease_holder'); end if;
  if st not in ('accepted', 'running') then return public._msgr2_rej('invalid_transition'); end if;
  if w.tier = 'guest' then return public._msgr2_rej('tier_denied'); end if;
  nm := regexp_replace(coalesce(p_name, ''), '[/\\[:cntrl:]]', '_', 'g');
  nm := regexp_replace(nm, '\.\.+', '_', 'g'); -- 첨부 경로 검사(U1)가 '..'을 거부한다
  if nm in ('', '.', '..') or char_length(nm) > 200 or p_bytes is null or p_bytes < 0 or p_bytes > 52428800
     or (select count(*) from public.msgr2_work_files where work_id = w.id) >= 20 then
    return public._msgr2_rej('upload_slot_invalid');
  end if;
  select r.space_id into sp from public.msgr2_rooms r where r.id = w.room_id;
  obj := sp::text || '/' || w.room_id::text || '/' || sid::text || '/' || nm;
  insert into public.msgr2_work_files (id, work_id, room_id, name, bytes, storage_path) values (sid, w.id, w.room_id, nm, p_bytes, 'msgr/' || obj);
  return jsonb_build_object('ok', true, 'slot', sid, 'bucket', 'msgr', 'path', obj);
end $$;

-- 중단 스위치 읽기(U5 시작 확인). 켜져 있으면 {paused:true, since(= 스위치 값)}, 꺼져 있으면 null. 로그인만 보면 된다(기기 등록 전에 부른다).
create or replace function public.msgr2_service_pause() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public._msgr2_paused() then jsonb_build_object('paused', true, 'since', public._msgr2_setting('msgr2_paused')) end
$$;

-- 앱(사람)이 재접속 때 부른다(U5): 내가 읽을 수 있는 방의 p_since_id 뒤 글, 방마다 최근 200개(넘으면 more — 더 오래된 글은 방을 열 때 따로 읽는다).
-- p_since_id가 null이면 방마다 최근 200개. 쓰기 없음. 중단 중이면 읽지 않고 {rooms:[], paused:true}.
-- next_since(커밋 순서 대비): 글 id는 넣을 때 정해지고 커밋은 그 뒤라, id 순서와 보이는 순서가 어긋날 수 있다(긴 트랜잭션의 작은 id가 늦게 보임).
--   그래서 다음 since는 "60초보다 오래된 글 중 가장 큰 id"까지만 올린다(created_at = 트랜잭션 시작 시각, 글 넣기 트랜잭션은 60초보다 짧다는 전제).
--   최근 60초 글은 다음 따라잡기에서 다시 오고, 앱은 id로 중복을 거른다. 앱은 since = min(next_since, 방송으로 id만 받은 글 - 1)로 쓴다.
create or replace function public.msgr2_catch_up(p_since_id bigint) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); res jsonb; nxt bigint;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if public._msgr2_paused() then return jsonb_build_object('rooms', '[]'::jsonb, 'paused', true, 'next_since', p_since_id); end if;
  with cand as (
    select r.id from public.msgr2_rooms r join public.msgr2_space_members sm on sm.space_id = r.space_id and sm.user_id = uid and sm.removed_at is null
     where r.archived_at is null
  ), readable as (select c.id from cand c where (public.msgr2_access(c.id)).read),
  pick as (
    select m.* from readable rd
    cross join lateral (select mm.* from public.msgr2_messages mm where mm.room_id = rd.id and mm.id > coalesce(p_since_id, 0) order by mm.id desc limit 201) m
  ), ranked as (select p.*, row_number() over (partition by p.room_id order by p.id desc) as rn, count(*) over (partition by p.room_id) as cnt from pick p)
  select coalesce(jsonb_agg(jsonb_build_object('room_id', g.room_id, 'more', g.more, 'messages', g.msgs)), '[]'::jsonb),
         max(g.safe)
    into res, nxt
    from (select k.room_id, bool_or(k.cnt > 200) as more,
                 jsonb_agg(jsonb_build_object('id', k.id, 'room_id', k.room_id, 'topic_id', k.topic_id, 'author_kind', k.author_kind,
                   'author_user_id', k.author_user_id, 'author_agent_id', k.author_agent_id, 'kind', k.kind,
                   'body', case when k.deleted_at is null then k.body else '' end, 'meta', case when k.deleted_at is null then k.meta else '{}'::jsonb end,
                   'reply_to', k.reply_to, 'client_msg_id', k.client_msg_id, 'work_id', k.work_id, 'created_at', k.created_at,
                   'edited_at', k.edited_at, 'deleted_at', k.deleted_at,
                   'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', at.id, 'name', at.name, 'mime', at.mime, 'bytes', at.bytes, 'storage_path', at.storage_path) order by at.id)
                     from public.msgr2_attachments at where at.message_id = k.id), '[]'::jsonb)) order by k.id) as msgs,
                 max(k.id) filter (where k.created_at < now() - interval '60 seconds') as safe
            from ranked k where k.rn <= 200 group by k.room_id) g;
  return jsonb_build_object('rooms', res, 'next_since', greatest(coalesce(p_since_id, 0), coalesce(nxt, 0)));
end $$;

-- 사람 글의 첨부 자리(U5). 사람은 첨부 표에 직접 넣지 못하므로(U1) 이 RPC가 행을 만들고 올릴 경로를 돌려준다.
-- 내 글(지우지 않은 사람 글)이고 그 방에 쓸 수 있을 때만. 경로: 버킷 msgr 안 <공간>/<방>/<글 id>/<순번>-<이름>(storage_path = 'msgr/' || 경로).
-- 같은 (글, 순번)으로 다시 부르면 행을 새로 만들지 않고 같은 경로를 돌려준다(existing true) — 다시 보내기에서 빠진 것만 채운다. 글마다 20개까지.
-- 이 경로의 Storage 쓰기·읽기 정책은 미룸(첨부 단위).
create or replace function public.msgr2_attachment_add(p_message bigint, p_index int, p_name text, p_mime text, p_bytes bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; sp uuid; nm text; obj text; aid bigint;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into m from public.msgr2_messages where id = p_message for update;
  if not found or m.author_kind <> 'user' or m.author_user_id <> uid or m.deleted_at is not null or not (select (public.msgr2_access(m.room_id)).write) then
    raise exception 'msgr2_message_not_found' using errcode = '42501';
  end if;
  nm := regexp_replace(regexp_replace(normalize(coalesce(p_name, ''), NFC), '[/\\[:cntrl:]]', '_', 'g'), '\.\.+', '_', 'g');
  if p_index is null or p_index not between 0 and 19 or nm in ('', '.') or char_length(nm) > 200 or p_bytes is null or p_bytes not between 0 and 52428800
     or (p_mime is not null and char_length(p_mime) > 200) then
    raise exception 'msgr2_bad_attachment' using errcode = '22023';
  end if;
  select r.space_id into sp from public.msgr2_rooms r where r.id = m.room_id;
  obj := sp::text || '/' || m.room_id::text || '/' || m.id::text || '/' || p_index::text || '-' || nm;
  select a.id into aid from public.msgr2_attachments a where a.message_id = m.id and a.storage_path like 'msgr/' || sp::text || '/' || m.room_id::text || '/' || m.id::text || '/' || p_index::text || '-%';
  if aid is not null then
    return jsonb_build_object('ok', true, 'attachment_id', aid, 'bucket', 'msgr', 'path', (select substr(storage_path, 6) from public.msgr2_attachments where id = aid), 'existing', true);
  end if;
  insert into public.msgr2_attachments (message_id, room_id, storage_path, name, mime, bytes) values (m.id, m.room_id, 'msgr/' || obj, nm, p_mime, p_bytes) returning id into aid;
  return jsonb_build_object('ok', true, 'attachment_id', aid, 'bucket', 'msgr', 'path', obj, 'existing', false);
end $$;

-- ── 8. 사람 쪽 RPC ──────────────────────────────────────────────────────────────
-- 일 취소: 지시한 사람(사슬의 시작) 또는 에이전트 주인. 끝난 일이면 쓰기 없이 지금 상태만 돌려준다.
create or replace function public.msgr2_work_cancel(p_work uuid) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); w public.msgr2_works; st text;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  select * into w from public.msgr2_works where id = p_work for update;
  if not found or not (select (public.msgr2_access(w.room_id)).read) or uid not in (w.root_user_id, w.owner_user_id) then
    raise exception 'msgr2_work_not_found' using errcode = '42501';
  end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  if st in ('done', 'failed', 'cancelled', 'expired') then return st; end if;
  update public.msgr2_works set state = 'cancelled', updated_at = now() where id = w.id;
  perform public._msgr2_server_event(w.id, 'work.cancel', w.lease_device, jsonb_build_object('by', jsonb_build_object('kind', 'user', 'id', uid), 'reason', 'user'));
  perform public._msgr2_system_msg(w.room_id, w.topic_id, w.id, jsonb_build_object('code', 'work.cancelled', 'by', uid, 'agent', w.agent_id));
  return 'cancelled';
end $$;

-- 승인 결정: 앱 기기 + 에이전트 주인만(D9·D13). 기한이 지났거나 이미 정했으면 쓰기 없이 지금 상태.
create or replace function public.msgr2_approval_decide(p_approval uuid, p_decision text) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); ap public.msgr2_approvals; w public.msgr2_works; st text;
begin
  if uid is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then raise exception 'msgr2_bad_decision' using errcode = '22023'; end if;
  select * into ap from public.msgr2_approvals where id = p_approval for update;
  if found then select * into w from public.msgr2_works where id = ap.work_id for update; end if;
  if ap.id is null or w.owner_user_id <> uid then raise exception 'msgr2_approval_not_found' using errcode = '42501'; end if;
  if ap.state <> 'pending' then return ap.state; end if;
  if ap.expires_at <= now() then return 'expired'; end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  if st <> 'awaiting_approval' then return st; end if;
  update public.msgr2_approvals set state = case p_decision when 'approve' then 'approved' else 'rejected' end, decided_by = uid, decided_at = now() where id = ap.id;
  update public.msgr2_works set state = 'running', updated_at = now() where id = w.id;
  perform public._msgr2_server_event(w.id, 'work.approval_decision', w.lease_device,
    jsonb_build_object('approval_id', ap.id, 'decision', p_decision, 'by', jsonb_build_object('kind', 'user', 'id', uid)));
  return case p_decision when 'approve' then 'approved' else 'rejected' end;
end $$;

-- 토픽 해결: 그 방에 쓸 수 있는 사람. 이미 해결됐으면 쓰기 없음.
create or replace function public.msgr2_topic_resolve(p_topic uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); tp public.msgr2_topics;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  select * into tp from public.msgr2_topics where id = p_topic for update;
  if not found or not (select (public.msgr2_access(tp.room_id)).write) then raise exception 'msgr2_topic_not_found' using errcode = '42501'; end if;
  if tp.status = 'resolved' then return false; end if;
  update public.msgr2_topics set status = 'resolved', resolved_by = uid, resolved_at = now() where id = tp.id;
  perform public._msgr2_system_msg(tp.room_id, tp.id, tp.work_id, jsonb_build_object('code', 'topic.resolved', 'by', uid));
  return true;
end $$;

-- 일 상태 보기(카드·"결과 모름" 표시): 읽을 때 계산한 상태 + 결과를 모르는 효과(intent만 남았는데 일이 끝났거나 stalled).
create or replace function public.msgr2_work_status(p_work uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare w public.msgr2_works; st text;
begin
  select * into w from public.msgr2_works where id = p_work;
  if not found or not (select (public.msgr2_access(w.room_id)).read) then return null; end if;
  st := public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result);
  return jsonb_build_object('work', w.id, 'state', st, 'late', w.late, 'error', w.error_code, 'has_result', w.has_result,
    'unknown_effects', case when st in ('done', 'failed', 'cancelled', 'stalled') then
      coalesce((select jsonb_agg(e.effect_key order by e.at) from public.msgr2_effects e where e.work_id = w.id and e.state = 'intent'), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- ── 9. 실행 권한 ────────────────────────────────────────────────────────────────
do $$ declare f text; begin
  foreach f in array array[
    '_msgr2_setting(text)', '_msgr2_setting_int(text, integer)', '_msgr2_my_device()', '_msgr2_send_w(uuid, jsonb)',
    '_msgr2_system_msg(uuid, uuid, uuid, jsonb)', '_msgr2_server_event(uuid, text, uuid, jsonb)',
    '_msgr2_make_offer(uuid, uuid, uuid, text, uuid, uuid, text, bigint, uuid, integer)', '_msgr2_peers(uuid, uuid, uuid, text)', '_msgr2_bump_streak(uuid)', '_msgr2_paused()',
    'msgr2_on_user_message()', 'msgr2_pause_guard()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['msgr2_link_send(jsonb)', 'msgr2_link_pending()', 'msgr2_link_upload_slot(uuid, text, bigint)', 'msgr2_catch_up(bigint)',
    'msgr2_service_pause()', 'msgr2_attachment_add(bigint, integer, text, text, bigint)',
    'msgr2_work_cancel(uuid)', 'msgr2_approval_decide(uuid, text)', 'msgr2_topic_resolve(uuid)', 'msgr2_work_status(uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;
