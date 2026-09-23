-- VPS 서버 연결(유건 지시 2026-09-23): Hostinger·Oracle·AWS 같은 VPS에 상주하는 게이트웨이(헤르메스·오픈클로)의 에이전트 전원을
-- 명령 한 줄로 메신저에 붙인다. 앱이 1회용 연결 코드를 만들고 → 사용자가 서버 콘솔의 브라우저 터미널에 명령 한 줄을 붙여넣으면
-- 서버 스크립트(msgr-bot 엣지 함수 /connect)가 에이전트 목록을 보고하고 → 관리자가 앱에서 고른 에이전트만 봇이 된다.
-- 토큰 원문은 서버에 오지 않는다: 스크립트가 에이전트마다 토큰을 만들어 자기 .env에만 쓰고, 여기는 sha256만 받는다(msgr_bots와 같은 해시).
-- 같은 서버의 같은 에이전트를 다시 연결하면 새 봇을 만들지 않고 그 봇의 토큰만 교체한다 — external_id = 'vps:<호스트명>:<종류>:<id>'.
create table if not exists public.msgr_server_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,                                   -- sha256(hex) — 원문은 만들 때 1회 반환
  status text not null default 'waiting' check (status in ('waiting', 'reported', 'approved', 'done')),
  host text,                                                        -- 서버가 보고한 호스트명(표시·external_id)
  agents jsonb not null default '[]'::jsonb,                        -- [{kind,id,name,default,token_hash,token_hint}]
  approved jsonb not null default '[]'::jsonb,                      -- [{kind,id,bot_id}]
  results jsonb not null default '[]'::jsonb,                       -- 서버 설치 결과 [{kind,id,ok,detail}]
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '60 minutes'
);
create index if not exists msgr_server_links_org on public.msgr_server_links (org_id);
alter table public.msgr_server_links enable row level security;
drop policy if exists msgr_server_links_select on public.msgr_server_links;
create policy msgr_server_links_select on public.msgr_server_links for select to authenticated using (public.msgr_is_admin(org_id)); -- 쓰기 정책 없음: RPC만
grant select on public.msgr_server_links to authenticated;

-- 1) 관리자: 연결 코드 만들기
create or replace function public.msgr_server_link_create(org uuid) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare code text; lid uuid;
begin
  if auth.uid() is null or public.msgr_is_admin(org) is not true then raise exception 'msgr_admin_only'; end if;
  if public.msgr_org_locked(org) then raise exception 'msgr_org_locked'; end if;
  delete from public.msgr_server_links where org_id = org and expires_at < now() - interval '1 day'; -- 오래된 흔적 정리
  code := 'argo_link_' || encode(gen_random_bytes(24), 'hex');
  insert into public.msgr_server_links (org_id, created_by, code_hash) values (org, auth.uid(), public.msgr_bot_hash(code)) returning id into lid;
  return jsonb_build_object('link_id', lid, 'code', code);
end $$;
revoke all on function public.msgr_server_link_create(uuid) from public;
grant execute on function public.msgr_server_link_create(uuid) to authenticated;

-- 코드 → 살아 있는 연결 행(내부 전용)
create or replace function public.msgr_server_link_by_code(code text) returns public.msgr_server_links
  language sql stable security definer set search_path = public, pg_temp as $$
  select * from public.msgr_server_links where code_hash = public.msgr_bot_hash(coalesce(code, '')) and expires_at > now()
$$;
revoke all on function public.msgr_server_link_by_code(text) from public;

-- 2) 서버 스크립트(anon, 코드가 자격): 에이전트 목록 보고 — 코드당 한 번. 다시 받으면 코드를 본 누군가가 관리자가 보는 목록·토큰 해시를
--    자기 것으로 바꿔 승인받을 수 있었다(검수 #688 MEDIUM). 스크립트를 다시 돌리려면 앱에서 새 명령을 만든다.
create or replace function public.msgr_server_link_report(code text, host text, agents jsonb) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.msgr_server_links := public.msgr_server_link_by_code(code); a jsonb; n int := 0;
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
      or coalesce(a->>'token_hint', '') !~ '^argo_bot_[0-9a-f]{3}$' then
      raise exception 'msgr_link_bad_agents' using detail = 'agent ' || n;
    end if;
  end loop;
  update public.msgr_server_links set status = 'reported', host = msgr_server_link_report.host,
    agents = (select coalesce(jsonb_agg(jsonb_build_object('kind', e->>'kind', 'id', e->>'id', 'name', btrim(e->>'name'), 'default', coalesce((e->>'default')::boolean, false),
      'token_hash', e->>'token_hash', 'token_hint', e->>'token_hint')), '[]'::jsonb) from jsonb_array_elements(msgr_server_link_report.agents) e)
    where id = l.id;
end $$;
revoke all on function public.msgr_server_link_report(text, text, jsonb) from public;
grant execute on function public.msgr_server_link_report(text, text, jsonb) to anon, authenticated;

-- 3) 관리자: 고른 에이전트를 봇으로. 같은 서버·같은 에이전트의 살아 있는 봇이 있으면 토큰(해시)만 교체한다.
create or replace function public.msgr_server_link_approve(link uuid, picks jsonb) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare l public.msgr_server_links; p jsonb; a jsonb; ext text; b public.msgr_bots; made jsonb; out jsonb := '[]'::jsonb;
begin
  select * into l from public.msgr_server_links where id = link for update;
  if l.id is null or auth.uid() is null or public.msgr_is_admin(l.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  if l.expires_at <= now() then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'reported' then raise exception 'msgr_link_used'; end if;
  if jsonb_typeof(picks) is distinct from 'array' or jsonb_array_length(picks) = 0 then raise exception 'msgr_link_no_picks'; end if;
  for p in select * from jsonb_array_elements(picks) loop
    select e into a from jsonb_array_elements(l.agents) e where e->>'kind' = p->>'kind' and e->>'id' = p->>'id';
    if a is null then raise exception 'msgr_link_no_picks' using detail = 'unknown agent'; end if;
    if out @> jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id')) then continue; end if; -- 같은 에이전트 두 번 고름
    ext := 'vps:' || l.host || ':' || (a->>'kind') || ':' || (a->>'id');
    select * into b from public.msgr_bots where org_id = l.org_id and external_id = ext and revoked_at is null;
    if b.id is not null then
      update public.msgr_bots set token_hash = a->>'token_hash', token_hint = a->>'token_hint', rotated_at = now() where id = b.id;
      perform public.msgr_audit(l.org_id, 'bot.rotate', 'bot', b.id::text, jsonb_build_object('via', 'server_link', 'link', l.id));
      out := out || jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id', 'bot_id', b.id, 'reused', true));
    else
      made := public.msgr_bot_create(l.org_id, a->>'kind', a->>'name', null, ext); -- 크루·봇·감사는 기존 경로 그대로. 원문 토큰은 버리고 서버가 만든 해시로 바꾼다
      update public.msgr_bots set token_hash = a->>'token_hash', token_hint = a->>'token_hint' where id = (made->>'bot_id')::uuid;
      out := out || jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id', 'bot_id', made->>'bot_id', 'reused', false));
    end if;
  end loop;
  update public.msgr_server_links set status = 'approved', approved = out where id = l.id;
  return out;
end $$;
revoke all on function public.msgr_server_link_approve(uuid, jsonb) from public;
grant execute on function public.msgr_server_link_approve(uuid, jsonb) to authenticated;

-- 4) 서버 스크립트(anon): 승인 여부 조회 — 승인된 에이전트 목록만(토큰 없음)
create or replace function public.msgr_server_link_status(code text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.msgr_server_links := public.msgr_server_link_by_code(code);
begin
  if l.id is null then raise exception 'msgr_link_invalid'; end if;
  return jsonb_build_object('status', l.status, 'approved',
    case when l.status in ('approved', 'done') then (select coalesce(jsonb_agg(jsonb_build_object('kind', e->>'kind', 'id', e->>'id')), '[]'::jsonb) from jsonb_array_elements(l.approved) e) else '[]'::jsonb end);
end $$;
revoke all on function public.msgr_server_link_status(text) from public;
grant execute on function public.msgr_server_link_status(text) to anon, authenticated;

-- 5) 서버 스크립트(anon): 설치 결과 보고 → done
create or replace function public.msgr_server_link_done(code text, results jsonb) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare l public.msgr_server_links := public.msgr_server_link_by_code(code);
begin
  if l.id is null then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'approved' then raise exception 'msgr_link_used'; end if;
  if jsonb_typeof(results) is distinct from 'array' or jsonb_array_length(results) > 50 then raise exception 'msgr_link_bad_agents'; end if;
  update public.msgr_server_links set status = 'done',
    results = (select coalesce(jsonb_agg(jsonb_build_object('kind', left(e->>'kind', 16), 'id', left(e->>'id', 64), 'ok', coalesce((e->>'ok')::boolean, false), 'detail', left(coalesce(e->>'detail', ''), 300))), '[]'::jsonb) from jsonb_array_elements(msgr_server_link_done.results) e)
    where id = l.id;
end $$;
revoke all on function public.msgr_server_link_done(text, jsonb) from public;
grant execute on function public.msgr_server_link_done(text, jsonb) to anon, authenticated;
