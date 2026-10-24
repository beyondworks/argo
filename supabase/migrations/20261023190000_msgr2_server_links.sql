-- 메신저 v2 — VPS 서버 연결 이식(2026-10-23 유건 "기존꺼 그냥 가져다 붙이기만 하면 되잖아", 총괄 결정: Hermes 먼저, 결재·첨부·예약 미러는 1단계 제외).
-- v1 흐름(20260923120000_msgr_server_links.sql)을 그대로 옮기고 꼭 바꿔야 하는 것만 바꿨다.
--   그대로: 1회용 코드(argo_link_ + 48 hex) → 서버 스크립트(integrations/server-connect/connect.py)가 에이전트 목록 + 토큰 sha256만 보고(코드당 한 번)
--          → 앱에서 고른 에이전트만 연결 → 스크립트가 승인 목록을 읽고 플러그인 설치 → 결과 보고. 토큰 원문은 서버의 에이전트 설정에만 있다.
--   바뀜 ① 주인: 조직(msgr_orgs·관리자) → 사람 한 명(owner_user_id). v2 개인 공간에는 v1 조직이 없을 수 있다. 앱 기기 + Pro만 만들고 고른다(20261020201700과 같은 관문).
--        ② 승인 결과: v1 msgr_bots·msgr_crews → v2 msgr2_agents(hosting 'bot', ws_id 'vps:<호스트>', slug '~bot.<종류>.<id>') + msgr2_bots(토큰 해시).
--           v2 앱은 msgr2_agents만 읽는다. 개인 공간 자리는 행 없이 늘 있다(20261020200000 D3) — 자리 행을 만들지 않는다.
--        ③ 봇이 받고 답하는 길: v1 봇 RPC(msgr_bot_*)는 v1 표(msgr_messages·msgr_channels·msgr_executions)를 읽고 써서 v2 앱에 안 보인다.
--           Hermes가 대화에 쓰는 것만 v2 표 위에 둔다: msgr2_bot_me / msgr2_bot_updates(일 받기) / msgr2_bot_finish(최종 답) / msgr2_bot_send(같은 일의 보충 글).
--           엣지 함수 msgr-bot이 토큰 접두(argo_bot_v2)로 이 RPC를 부르고, 그 밖의 토큰은 지금의 중단 응답(DB 0)을 그대로 준다.
--        ④ 만료 60분 → 15분(코드가 새면 남의 서버가 먼저 보고할 수 있다 — 창을 줄인다). 승인하면 스크립트가 설치를 끝낼 15분을 다시 준다.
--        ⑤ 봇의 보통 글(msgr2_bot_send)은 그 봇이 1시간 안에 일을 받은 방에만(아무 방에나 쓰는 길을 막는다).
-- 일 만들기: 봇 일(kind 'bot')은 주인 본체가 'bot' 기능을 알렸을 때만 만들었다(20261020201400 _msgr2_make_offer_x 165행 → _msgr2_runner_has).
--   VPS 봇에는 본체가 없으므로 _msgr2_runner_has만 다시 정의한다: 'bot'이면 주인에게 살아 있는 VPS 봇 토큰이 있어도 참(본문은 직전 정의 그대로 + 한 줄).
--   _msgr2_make_offer_x는 고치지 않는다(Pro·분당 6회·방·토픽·하루 상한·lite 판정 그대로 적용). 대가: 주인의 PC 봇(본체 중계)이 꺼져 있고 VPS 봇이 있으면
--   PC 봇 일도 만들어지고(안내 대신) 30분 뒤 만료로 보인다 — 본체는 모르는 에이전트의 offer를 무시한다(packages/agent-link/link.mjs 143행).
-- 연결 해제: msgr2_bot_revoke(에이전트) = 토큰 폐기 + 에이전트 retired + 방 멤버·파견 자리 닫기 + 열린 일 취소. 글(기억 데이터)은 지우지 않는다.
--   같은 서버를 다시 연결하면 msgr2_server_link_get이 "이번 보고에 없는 이 서버의 봇"(missing)을 알려 주고, 승인 때 고르면(p_retire) 같은 방법으로 은퇴시킨다.
--   (원인 기록: v1은 자리만 지우고 msgr_agents 행을 남겨 v2 백필이 이름 = slug·active로 옮겼다 — 20261020200700 184·194행. 여기서는 행을 남기지 않고 retired로 닫는다.)
-- 부하(봇 1개, 쉬는 동안): Hermes 롱폴 50초마다 엣지 호출 1회(분당 1.2) × 그 안에서 5초마다 msgr2_bot_updates(분당 12회 읽기). 쓰기 0 —
--   last_seen_at은 10분 넘게 지났을 때만 쓴다(분당 0.1). 일이 있을 때만 일 행 1개를 accepted로 바꾼다. 연결 중에만: 앱 2초 · 스크립트 3초마다 상태 읽기(최대 15분).
-- 지우는 SQL: 만든 사람의 하루 지난 연결 행(링크 흔적, 기억 데이터 아님 — v1 31행과 같음)만.
-- 되돌림: scripts/rollback/20261023190000_msgr2_server_links.down.sql · 시험: test/msgr2-server-links-pg.test.mjs

create extension if not exists pgcrypto;

-- ── 표 ──────────────────────────────────────────────────────────────────────────
create table if not exists public.msgr2_server_links (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,                                   -- sha256(hex). 원문은 만들 때 1회 반환
  status text not null default 'waiting' check (status in ('waiting', 'reported', 'approved', 'done')),
  host text,
  agents jsonb not null default '[]'::jsonb,                        -- [{kind,id,name,default,token_hash,token_hint}] — 앱에는 해시를 주지 않는다(msgr2_server_link_get)
  approved jsonb not null default '[]'::jsonb,                      -- [{kind,id,agent_id,reused}]
  results jsonb not null default '[]'::jsonb,                       -- [{kind,id,ok,detail}]
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes'
);
create index if not exists msgr2_server_links_owner on public.msgr2_server_links (owner_user_id, created_at desc);

create table if not exists public.msgr2_bots (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references public.msgr2_agents (id),
  owner_user_id uuid not null,
  kind text not null check (kind in ('hermes', 'openclaw')),
  host text not null,
  ext_id text not null,                                             -- 서버 안의 에이전트 id(헤르메스 프로필·오픈클로 에이전트)
  token_hash text not null unique,
  token_hint text not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz
);
create unique index if not exists msgr2_bots_live_agent on public.msgr2_bots (agent_id) where revoked_at is null;
create index if not exists msgr2_bots_owner on public.msgr2_bots (owner_user_id) where revoked_at is null;
-- 봇 받기(5초마다)의 스캔 범위 — 그 에이전트의 열린 일만(끝난 일이 쌓여도 읽는 양이 늘지 않게, DB 위생 3)
create index if not exists msgr2_works_bot_open on public.msgr2_works (agent_id, created_at) where not has_result and state in ('offered', 'accepted', 'running');

-- 두 표 모두 RPC로만 다룬다(정책 없음 = 클라이언트 직접 읽기·쓰기 0). 토큰 해시가 다른 기기에 보이지 않게.
alter table public.msgr2_server_links enable row level security;
alter table public.msgr2_bots enable row level security;
revoke all on public.msgr2_server_links from public, anon, authenticated;
revoke all on public.msgr2_bots from public, anon, authenticated;

create or replace function public._msgr2_hash(t text) returns text
  language sql immutable set search_path = public, pg_temp as $$ select encode(sha256(convert_to(coalesce(t, ''), 'utf8')), 'hex') $$;
revoke all on function public._msgr2_hash(text) from public, anon, authenticated;

-- ── 일 만들기 관문(한 줄) ──────────────────────────────────────────────────────────
create or replace function public._msgr2_runner_has(p_owner uuid, p_feature text) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr2_devices d
                  where d.user_id = p_owner and d.kind in ('runner', 'resident') and d.revoked_at is null and d.expires_at > now()
                    and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0)
                    and p_feature = any (d.features))
      or (p_feature = 'bot' and exists (select 1 from public.msgr2_bots b where b.owner_user_id = p_owner and b.revoked_at is null)) $$;
revoke all on function public._msgr2_runner_has(uuid, text) from public, anon, authenticated;

-- ── 연결 해제(내부) ────────────────────────────────────────────────────────────────
-- 토큰 폐기 + 에이전트 retired + 방 멤버·파견 자리 닫기 + 열린 일 취소. 이미 닫힌 것은 쓰지 않는다. 글은 그대로 둔다.
create or replace function public._msgr2_bot_retire(p_agent uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int; k int;
begin
  update public.msgr2_bots set revoked_at = now() where agent_id = p_agent and revoked_at is null;
  get diagnostics n = row_count;
  update public.msgr2_agents set status = 'retired', updated_at = now() where id = p_agent and hosting = 'bot' and status <> 'retired';
  get diagnostics k = row_count; n := n + k;
  update public.msgr2_room_members set removed_at = now() where member_kind = 'agent' and member_id = p_agent and removed_at is null;
  update public.msgr2_agent_seats set removed_at = now() where agent_id = p_agent and removed_at is null;
  update public.msgr2_works set state = 'cancelled', updated_at = now()
   where agent_id = p_agent and state in ('offered', 'accepted', 'running', 'awaiting_approval');
  return n > 0;
end $$;
revoke all on function public._msgr2_bot_retire(uuid) from public, anon, authenticated;

-- ── 1) 앱: 연결 코드 만들기 ─────────────────────────────────────────────────────────
create or replace function public.msgr2_server_link_create() returns jsonb
  language plpgsql volatile security definer set search_path = public, extensions, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); code text; lid uuid;
begin
  perform public._msgr2_need_live();
  if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
  delete from public.msgr2_server_links where owner_user_id = uid and expires_at < now() - interval '1 day'; -- 오래된 흔적(v1과 같음)
  if (select count(*) from public.msgr2_server_links where owner_user_id = uid and created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'msgr2_rate' using errcode = '42501'; -- 10분에 10개 — 누름 반복으로 행이 쌓이지 않게
  end if;
  code := 'argo_link_' || encode(gen_random_bytes(24), 'hex');
  insert into public.msgr2_server_links (owner_user_id, code_hash) values (uid, public._msgr2_hash(code)) returning id into lid;
  return jsonb_build_object('link_id', lid, 'code', code);
end $$;
revoke all on function public.msgr2_server_link_create() from public, anon;
grant execute on function public.msgr2_server_link_create() to authenticated;

-- 코드 → 살아 있는 연결 행(내부 전용)
create or replace function public._msgr2_server_link_by_code(p_code text) returns public.msgr2_server_links
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.msgr2_server_links where code_hash = public._msgr2_hash(p_code) and expires_at > now()
$$;
revoke all on function public._msgr2_server_link_by_code(text) from public, anon, authenticated;

-- ── 2) 서버 스크립트(anon, 코드가 자격): 목록 보고 — 코드당 한 번(v1 검수 #688 MEDIUM 그대로) ──────────────
create or replace function public.msgr2_server_link_report(code text, host text, agents jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare l public.msgr2_server_links := public._msgr2_server_link_by_code(code); a jsonb; n int := 0;
begin
  if l.id is null then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'waiting' then raise exception 'msgr_link_used'; end if;
  if coalesce(host, '') !~ '^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$' then raise exception 'msgr_link_bad_agents' using detail = 'host'; end if;
  if jsonb_typeof(agents) is distinct from 'array' or jsonb_array_length(agents) > 50 then raise exception 'msgr_link_bad_agents'; end if;
  for a in select * from jsonb_array_elements(agents) loop
    n := n + 1;
    if coalesce(a->>'kind', '') not in ('hermes', 'openclaw')
      or coalesce(a->>'id', '') !~ '^[A-Za-z0-9._-]{1,64}$'
      or length(btrim(coalesce(a->>'name', ''))) not between 1 and 80 or coalesce(a->>'name', '') ~ '[\n\r]'
      or coalesce(a->>'token_hash', '') !~ '^[0-9a-f]{64}$'
      or coalesce(a->>'token_hint', '') !~ '^argo_bot_v2[0-9a-f]{3}$' then
      raise exception 'msgr_link_bad_agents' using detail = 'agent ' || n;
    end if;
  end loop;
  update public.msgr2_server_links set status = 'reported', host = msgr2_server_link_report.host,
    agents = (select coalesce(jsonb_agg(jsonb_build_object('kind', e->>'kind', 'id', e->>'id', 'name', btrim(e->>'name'), 'default', coalesce((e->>'default')::boolean, false),
      'token_hash', e->>'token_hash', 'token_hint', e->>'token_hint')), '[]'::jsonb) from jsonb_array_elements(msgr2_server_link_report.agents) e)
    where id = l.id;
end $$;
revoke all on function public.msgr2_server_link_report(text, text, jsonb) from public;
grant execute on function public.msgr2_server_link_report(text, text, jsonb) to anon, authenticated;

-- ── 3) 앱: 진행 상태 읽기(쓰기 0). p_link가 없으면 내가 시작한 진행 중 연결(보고됨·승인됨) 중 최근 1개 — 다시 들어왔을 때 잇는다(v1 6282행) ──
-- 해시는 주지 않는다. missing = 이번 보고에 없는 이 서버의 내 봇(재연결 때 정리 제안).
create or replace function public.msgr2_server_link_get(p_link uuid default null) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); l public.msgr2_server_links;
begin
  if p_link is null then
    select * into l from public.msgr2_server_links where owner_user_id = uid and status in ('reported', 'approved') and expires_at > now()
     order by created_at desc limit 1;
  else
    select * into l from public.msgr2_server_links where id = p_link and owner_user_id = uid;
  end if;
  if l.id is null then return null; end if;
  return jsonb_build_object('link_id', l.id, 'status', l.status, 'host', l.host, 'approved', l.approved, 'results', l.results,
    'expires_at', to_char(l.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expired', l.status <> 'done' and l.expires_at <= now(),
    'agents', (select coalesce(jsonb_agg(jsonb_build_object('kind', e->>'kind', 'id', e->>'id', 'name', e->>'name', 'default', (e->>'default')::boolean)), '[]'::jsonb)
                 from jsonb_array_elements(l.agents) e),
    'missing', case when l.status = 'reported' then (
      select coalesce(jsonb_agg(jsonb_build_object('agent_id', b.agent_id, 'kind', b.kind, 'id', b.ext_id, 'name', coalesce(nullif(g.display_name, ''), b.ext_id)) order by g.display_name), '[]'::jsonb)
        from public.msgr2_bots b join public.msgr2_agents g on g.id = b.agent_id
       where b.owner_user_id = uid and b.host = l.host and b.revoked_at is null
         and not exists (select 1 from jsonb_array_elements(l.agents) e where e->>'kind' = b.kind and e->>'id' = b.ext_id)) else '[]'::jsonb end);
end $$;
revoke all on function public.msgr2_server_link_get(uuid) from public, anon;
grant execute on function public.msgr2_server_link_get(uuid) to authenticated;

-- ── 4) 앱: 고른 에이전트를 연결. 같은 서버·같은 에이전트면 새 행 없이 토큰만 교체(v1 96~100행). p_retire = 정리할 이 서버의 봇(missing에서 고른 것) ──
create or replace function public.msgr2_server_link_approve(p_link uuid, p_picks jsonb, p_retire uuid[] default '{}') returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); l public.msgr2_server_links; p jsonb; a jsonb; ag uuid; b public.msgr2_bots; out jsonb := '[]'::jsonb; x uuid;
begin
  perform public._msgr2_need_live();
  if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
  select * into l from public.msgr2_server_links where id = p_link and owner_user_id = uid for update;
  if l.id is null or l.expires_at <= now() then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'reported' then raise exception 'msgr_link_used'; end if;
  if jsonb_typeof(p_picks) is distinct from 'array' or jsonb_array_length(p_picks) = 0 then raise exception 'msgr_link_no_picks'; end if;
  for p in select * from jsonb_array_elements(p_picks) loop
    select e into a from jsonb_array_elements(l.agents) e where e->>'kind' = p->>'kind' and e->>'id' = p->>'id';
    if a is null then raise exception 'msgr_link_no_picks' using detail = 'unknown agent'; end if;
    if out @> jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id')) then continue; end if; -- 같은 에이전트 두 번 고름
    insert into public.msgr2_agents as t (owner_user_id, ws_id, slug, display_name, hosting, status)
    values (uid, 'vps:' || l.host, '~bot.' || (a->>'kind') || '.' || (a->>'id'), left(a->>'name', 80), 'bot', 'active')
    on conflict (owner_user_id, ws_id, slug) do update set display_name = excluded.display_name, hosting = 'bot', status = 'active', updated_at = now()
      where (t.display_name, t.hosting, t.status) is distinct from (excluded.display_name, 'bot', 'active');
    select id into ag from public.msgr2_agents where owner_user_id = uid and ws_id = 'vps:' || l.host and slug = '~bot.' || (a->>'kind') || '.' || (a->>'id');
    select * into b from public.msgr2_bots where agent_id = ag and revoked_at is null for update;
    if b.id is not null then
      update public.msgr2_bots set token_hash = a->>'token_hash', token_hint = a->>'token_hint', rotated_at = now() where id = b.id;
    else
      insert into public.msgr2_bots (agent_id, owner_user_id, kind, host, ext_id, token_hash, token_hint)
      values (ag, uid, a->>'kind', l.host, a->>'id', a->>'token_hash', a->>'token_hint');
    end if;
    out := out || jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id', 'agent_id', ag, 'reused', b.id is not null));
  end loop;
  -- 정리: 이 서버(같은 호스트)의 내 봇 중 이번에 고르지 않은 것만
  foreach x in array coalesce(p_retire, '{}') loop
    if exists (select 1 from public.msgr2_bots b2 where b2.agent_id = x and b2.owner_user_id = uid and b2.host = l.host and b2.revoked_at is null)
       and not (out @> jsonb_build_array(jsonb_build_object('agent_id', x))) then
      perform public._msgr2_bot_retire(x);
    end if;
  end loop;
  update public.msgr2_server_links set status = 'approved', approved = out, expires_at = greatest(expires_at, now() + interval '15 minutes') where id = l.id;
  return out;
end $$;
revoke all on function public.msgr2_server_link_approve(uuid, jsonb, uuid[]) from public, anon;
grant execute on function public.msgr2_server_link_approve(uuid, jsonb, uuid[]) to authenticated;

-- ── 5) 서버 스크립트(anon): 승인 여부 — 승인된 (종류, id)만(토큰 없음) ──────────────────────────────
create or replace function public.msgr2_server_link_status(code text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare l public.msgr2_server_links := public._msgr2_server_link_by_code(code);
begin
  if l.id is null then raise exception 'msgr_link_invalid'; end if;
  return jsonb_build_object('status', l.status, 'approved',
    case when l.status in ('approved', 'done') then (select coalesce(jsonb_agg(jsonb_build_object('kind', e->>'kind', 'id', e->>'id')), '[]'::jsonb) from jsonb_array_elements(l.approved) e) else '[]'::jsonb end);
end $$;
revoke all on function public.msgr2_server_link_status(text) from public;
grant execute on function public.msgr2_server_link_status(text) to anon, authenticated;

-- ── 6) 서버 스크립트(anon): 설치 결과 → done ───────────────────────────────────────────────
create or replace function public.msgr2_server_link_done(code text, results jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare l public.msgr2_server_links := public._msgr2_server_link_by_code(code);
begin
  if l.id is null then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'approved' then raise exception 'msgr_link_used'; end if;
  if jsonb_typeof(results) is distinct from 'array' or jsonb_array_length(results) > 50 then raise exception 'msgr_link_bad_agents'; end if;
  update public.msgr2_server_links set status = 'done',
    results = (select coalesce(jsonb_agg(jsonb_build_object('kind', left(e->>'kind', 16), 'id', left(e->>'id', 64), 'ok', coalesce((e->>'ok')::boolean, false), 'detail', left(coalesce(e->>'detail', ''), 300))), '[]'::jsonb) from jsonb_array_elements(msgr2_server_link_done.results) e)
    where id = l.id;
end $$;
revoke all on function public.msgr2_server_link_done(text, jsonb) from public;
grant execute on function public.msgr2_server_link_done(text, jsonb) to anon, authenticated;

-- ── 7) 앱: 연결된 서버 에이전트 목록(쓰기 0)·연결 해제 ─────────────────────────────────────────
create or replace function public.msgr2_bots_mine() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app();
begin
  return (select coalesce(jsonb_agg(jsonb_build_object('agent_id', b.agent_id, 'kind', b.kind, 'host', b.host, 'name', coalesce(nullif(g.display_name, ''), b.ext_id),
      'last_seen_at', to_char(b.last_seen_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'created_at', to_char(b.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      order by b.host, g.display_name), '[]'::jsonb)
    from public.msgr2_bots b join public.msgr2_agents g on g.id = b.agent_id where b.owner_user_id = uid and b.revoked_at is null);
end $$;
revoke all on function public.msgr2_bots_mine() from public, anon;
grant execute on function public.msgr2_bots_mine() to authenticated;

create or replace function public.msgr2_bot_revoke(p_agent uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app();
begin
  if not exists (select 1 from public.msgr2_bots b where b.agent_id = p_agent and b.owner_user_id = uid and b.revoked_at is null) then
    raise exception 'msgr2_forbidden' using errcode = '42501';
  end if;
  return public._msgr2_bot_retire(p_agent);
end $$;
revoke all on function public.msgr2_bot_revoke(uuid) from public, anon;
grant execute on function public.msgr2_bot_revoke(uuid) to authenticated;

-- ── 8) 봇 런타임(anon, 토큰이 자격 — v1 msgr_bot_*와 같은 방식). 오류 이름은 엣지 함수가 v1과 같은 HTTP로 바꾼다(msgr_bot_unauthorized = 401 등) ──
create or replace function public._msgr2_bot_auth(p_token text) returns public.msgr2_bots
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.msgr2_bots;
begin
  select bb.* into b from public.msgr2_bots bb join public.msgr2_agents g on g.id = bb.agent_id
   where bb.token_hash = public._msgr2_hash(p_token) and bb.revoked_at is null and g.status = 'active';
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  -- 접속 시각은 10분 넘게 지났을 때만 쓴다(유휴 쓰기 ≈ 0, 표시 기준 "N분 전"은 10분 단위로 충분)
  update public.msgr2_bots set last_seen_at = now() where id = b.id and (last_seen_at is null or last_seen_at < now() - interval '10 minutes');
  return b;
end $$;
revoke all on function public._msgr2_bot_auth(text) from public, anon, authenticated;

create or replace function public.msgr2_bot_me(p_token text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.msgr2_bots := public._msgr2_bot_auth(p_token); g public.msgr2_agents;
begin
  select * into g from public.msgr2_agents where id = b.agent_id;
  return jsonb_build_object('bot_id', b.id, 'agent_id', g.id, 'name', coalesce(nullif(g.display_name, ''), b.ext_id), 'kind', b.kind, 'status', g.status);
end $$;
revoke all on function public.msgr2_bot_me(text) from public;
grant execute on function public.msgr2_bot_me(text) to anon, authenticated;

-- 일 받기: 이 봇 에이전트의 offered 일(만료 전)을 accepted로 잡고(리스 15분, lease_device = 봇 행 id) 텔레그램 모양으로 준다.
-- 이미 이 봇이 잡았지만 답하지 않은 일 중 리스가 살아 있고 update_id > p_after인 것도 다시 준다(봇이 받은 뒤 죽은 경우). 일이 없으면 쓰기 0.
-- update_id = 일의 원문 글 id(source_message_id): 사람 글, 또는 다른 에이전트가 넘긴 결과 글(넘김 일도 원문이 있어 봇에게 간다). 회의 일에는 봇이 참가하지 않는다(20261020201400 124행).
-- 주인이 그 방을 더는 읽을 수 없거나 팀 공간의 활동 멤버가 아니면(빠짐·손님 기한 끝) 주지 않는다 — 본체 따라잡기(msgr2_link_pending)·S2(_msgr2_owner_active, 20261023180000)와 같은 판정.
create or replace function public.msgr2_bot_updates(p_token text, p_after bigint default 0, p_lim int default 1) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.msgr2_bots := public._msgr2_bot_auth(p_token); uid uuid; out jsonb := '[]'::jsonb; w public.msgr2_works; n int := 0; lim int := least(greatest(coalesce(p_lim, 1), 1), 10);
begin
  if public._msgr2_paused() then return out; end if;
  select owner_user_id into uid from public.msgr2_agents where id = b.agent_id;
  if not public._msgr2_pro_ok(uid) then raise exception 'msgr_bot_plan_required'; end if;
  for w in select * from public.msgr2_works x
            where x.agent_id = b.agent_id and x.source_message_id is not null and not x.has_result
              and ((x.state = 'offered' and x.expires_at > now())
                   or (x.state in ('accepted', 'running') and x.lease_device = b.id and x.lease_until > now() and x.source_message_id > coalesce(p_after, 0)))
              and coalesce((public._msgr2_access_for(x.room_id, uid)).read, false) and public._msgr2_owner_active(x.room_id, uid) -- 본체 경로 S2(20261023180000)와 같이
            order by x.created_at, x.id limit lim for update skip locked loop
    if w.state = 'offered' then
      update public.msgr2_works set state = 'accepted', lease_device = b.id, lease_gen = lease_gen + 1, lease_until = now() + interval '15 minutes', updated_at = now()
       where id = w.id;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('update_id', w.source_message_id, 'message', jsonb_build_object(
      'message_id', w.source_message_id, 'execution_attempt', w.id, 'text', w.text,
      'date', extract(epoch from (select m.created_at from public.msgr2_messages m where m.id = w.source_message_id))::bigint,
      'chat', jsonb_build_object('id', w.room_id, 'name', (select r.name from public.msgr2_rooms r where r.id = w.room_id),
        'kind', case when not exists (select 1 from public.msgr2_room_members m where m.room_id = w.room_id and m.removed_at is null
                                        and not ((m.member_kind = 'user' and m.member_id = uid) or (m.member_kind = 'agent' and m.member_id = b.agent_id)))
                     then 'dm' else 'public' end),
      'from', jsonb_build_object('id', w.from_id, 'name', ''))));
    n := n + 1;
  end loop;
  return out;
end $$;
revoke all on function public.msgr2_bot_updates(text, bigint, int) from public;
grant execute on function public.msgr2_bot_updates(text, bigint, int) to anon, authenticated;

-- 최종 답: 이 봇이 잡은 일에 한 번. 같은 일을 다시 보내면(봇의 보관함 재시도) 쓰기 없이 첫 글 id를 돌려준다.
-- 주인이 그 방을 더는 읽을 수 없으면 받지 않는다(방에서 빠진 뒤 답이 방에 들어가던 결함, #1154 검수 I-1). 리스(15분)는 다시 주기에만 쓴다 —
-- 봇 쪽에서 연장할 길이 없어 15분 넘는 작업의 답을 버리게 된다(재검수). 대신 일이 만들어진 지 24시간이 지난 답만 거부한다.
-- 글 모양은 본체 경로(msgr2_link_send work.result 비회의 갈래, 20261020201400 425~426행)와 같다: agent 글 + meta.work, 일 done·has_result, 연속 답장 +1.
create or replace function public.msgr2_bot_finish(p_token text, p_attempt uuid, p_text text) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.msgr2_bots := public._msgr2_bot_auth(p_token); w public.msgr2_works; mid bigint;
begin
  select * into w from public.msgr2_works where id = p_attempt for update;
  if w.id is null or w.agent_id <> b.agent_id then raise exception 'msgr_execution_not_owner'; end if;
  if w.has_result then
    select id into mid from public.msgr2_messages where work_id = w.id and author_kind = 'agent' order by id limit 1;
    return mid;
  end if;
  if w.state not in ('accepted', 'running') or w.lease_device is distinct from b.id or w.created_at <= now() - interval '24 hours' then raise exception 'msgr_execution_not_owner'; end if;
  if not coalesce((public._msgr2_access_for(w.room_id, w.owner_user_id)).read, false) or not public._msgr2_owner_active(w.room_id, w.owner_user_id) then raise exception 'msgr_execution_forbidden'; end if;
  if length(coalesce(p_text, '')) not between 1 and 20000 then raise exception 'msgr_bot_bad_body'; end if;
  if public._msgr2_paused() then raise exception 'service_paused'; end if;
  insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
  values (w.room_id, w.topic_id, 'agent', w.agent_id, 'text', p_text, jsonb_build_object('work', w.id), w.id) returning id into mid;
  update public.msgr2_works set state = 'done', has_result = true, updated_at = now() where id = w.id;
  perform public._msgr2_bump_streak(w.room_id);
  return mid;
end $$;
revoke all on function public.msgr2_bot_finish(text, uuid, text) from public;
grant execute on function public.msgr2_bot_finish(text, uuid, text) to anon, authenticated;

-- 보충 글(파일 실패 안내·주소 등, 어댑터의 execution_attempt 없는 sendMessage): 이 봇이 아직 멤버이고 1시간 안에 일을 받은 방에만.
create or replace function public.msgr2_bot_send(p_token text, p_room uuid, p_text text) returns bigint
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare b public.msgr2_bots := public._msgr2_bot_auth(p_token); mid bigint;
begin
  if not exists (select 1 from public.msgr2_room_members m where m.room_id = p_room and m.member_kind = 'agent' and m.member_id = b.agent_id and m.removed_at is null)
     or not exists (select 1 from public.msgr2_works x where x.room_id = p_room and x.agent_id = b.agent_id and x.lease_device = b.id and x.created_at > now() - interval '1 hour') then
    raise exception 'msgr_bot_not_member';
  end if;
  if not coalesce((public._msgr2_access_for(p_room, b.owner_user_id)).read, false) or not public._msgr2_owner_active(p_room, b.owner_user_id) then raise exception 'msgr_bot_not_member'; end if; -- 주인이 그 방을 더는 못 읽으면(검수 I-1과 같은 판정)
  if length(coalesce(p_text, '')) not between 1 and 20000 then raise exception 'msgr_bot_bad_body'; end if;
  if public._msgr2_paused() then raise exception 'service_paused'; end if;
  insert into public.msgr2_messages (room_id, author_kind, author_agent_id, kind, body, meta)
  values (p_room, 'agent', b.agent_id, 'text', p_text, '{}'::jsonb) returning id into mid;
  perform public._msgr2_bump_streak(p_room);
  return mid;
end $$;
revoke all on function public.msgr2_bot_send(text, uuid, text) from public;
grant execute on function public.msgr2_bot_send(text, uuid, text) to anon, authenticated;
