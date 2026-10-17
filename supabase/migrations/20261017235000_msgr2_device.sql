-- 메신저 v2 U3 — 기기·토큰·최소 버전(설계 2026-10-17 0절 D9·D10, 5절 "토큰: 기기·만료·폐기"·"최소 버전"·"권한 표는 에이전트가 못 바꿈").
-- 토큰 = 기기 행. Supabase 로그인 세션 하나(JWT `session_id` 클레임) = 기기 한 행이다.
--   ① 기기 행이 있고 ② 폐기되지 않았고 ③ 마지막 등록 + 30일 전이고 ④ 행의 세대(gen)가 사용자 세대와 같을 때만 _msgr2_device_ok()가 참이다.
--   v2의 모든 판정(msgr2_access·RLS·Realtime 토픽 권한)이 이 함수를 부른다(U1). 거짓이면 모든 판정이 거짓이다.
-- 만료는 읽을 때 계산한다(크론 없음). 등록은 앱 시작 때 하되 마지막 등록이 1일 넘었거나 값이 바뀌었을 때만 쓴다 — 유휴 쓰기 0.
--   클라이언트(본체·메신저 앱)는 시작할 때와 켜져 있는 동안 하루 한 번 이상 등록을 불러야 30일 만료에 걸리지 않는다(U4·U5).
-- 기기 종류: app(사람이 쓰는 메신저 앱) · runner(본체 실행기) · resident(상주 서버의 본체). 한 세션의 종류·앱은 처음 등록한 값으로 잠긴다 —
--   에이전트 셸이 본체 세션 파일(src/devicesession.mjs)을 읽어도 runner 기기라 app 전용 RPC(폐기·권한 표 변경)는 42501로 거부된다.
-- 사용자 세대(msgr2_user_gen)를 올리면 그 사용자의 모든 기기가 한 번에 무효가 된다(새로 로그인한 세션만 새 세대로 등록된다).
-- 보존: 행은 로그인 세션마다 하나씩 쌓인다. 새 기기 행을 만들 때 같은 사용자의, 60일 넘게 등록이 없고 auth.sessions에서도 사라진
--   세션의 행만 지운다(세션이 없으면 그 토큰으로 다시 등록할 수 없으므로 폐기·만료 표시를 잃어도 되살아나지 않는다). 크론 없음.
-- JWT session_id 클레임: @supabase/auth-js의 JwtPayload 타입이 필수 클레임으로 둔다. 실 GoTrue 토큰으로는 아직 확인 안 함(qbwr U0에서 확인).
-- 함수 관례(20260903120000_msgr.sql 머리말): security definer + 고정 search_path + auth.uid()·JWT 클레임만 참조, anon 실행 회수.

create table if not exists public.msgr2_user_gen (
  user_id uuid primary key references auth.users(id) on delete cascade,
  gen int not null default 0 check (gen >= 0)
);

create table if not exists public.msgr2_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('app', 'runner', 'resident')),
  app text not null check (app in ('messenger', 'desktop')),
  app_version text not null check (char_length(app_version) between 1 and 32),
  link_v int4range,                                   -- 본체가 아는 약속 버전 [min,max]. app 기기는 null
  runners text[] not null default '{}',
  session_id uuid not null unique,                    -- JWT session_id = GoTrue auth.sessions.id
  push_token text check (push_token is null or char_length(push_token) <= 4096),
  gen int not null default 0,
  expires_at timestamptz not null,                    -- 마지막 등록 + 30일. 읽을 때 now()와 비교한다
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  registered_at timestamptz not null default now(),
  check ((kind = 'app') = (app = 'messenger'))
);
create index if not exists msgr2_devices_user_idx on public.msgr2_devices (user_id, registered_at desc);

-- 표는 RPC로만 다룬다(정책 없음 = 클라이언트 직접 읽기·쓰기 0). 푸시 토큰·세션 id가 다른 기기에 보이지 않게.
alter table public.msgr2_devices enable row level security;
alter table public.msgr2_user_gen enable row level security;
revoke all on public.msgr2_devices from anon, authenticated;
revoke all on public.msgr2_user_gen from anon, authenticated;

-- JWT의 session_id. PostgREST는 request.jwt.claims(JSON)로, 옛 판은 request.jwt.claim.<이름>으로 싣는다. uuid 모양이 아니면 null.
create or replace function public._msgr2_session_id() returns uuid
  language sql stable set search_path = public, pg_temp as $$
  select case when s ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s::uuid end
    from (select coalesce(nullif(current_setting('request.jwt.claim.session_id', true), ''),
                          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'session_id') as s) c
$$;
revoke all on function public._msgr2_session_id() from public;

-- 앱 버전 문자열 → 비교용 정수 4칸('0.1.107' → {0,1,107,0}, '0.2.0-beta.1' → {0,2,0,0}). 모양이 아니면 null.
create or replace function public._msgr2_ver(v text) returns int[]
  language sql immutable set search_path = public, pg_temp as $$
  select case when v ~ '^v?[0-9]{1,9}(\.[0-9]{1,9}){0,3}([-+].*)?$'
    then (string_to_array(substring(v from '^v?([0-9]{1,9}(?:\.[0-9]{1,9}){0,3})'), '.')::int[] || array[0,0,0,0])[1:4] end
$$;
revoke all on function public._msgr2_ver(text) from public;

-- 지금 요청한 기기 행이 유효한가. U1이 같은 이름의 자리 함수(true)를 둘 수 있어 create or replace로 정의한다(시그니처 고정: () returns boolean).
create or replace function public._msgr2_device_ok() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.msgr2_devices d
     where d.session_id = public._msgr2_session_id()
       and d.user_id = auth.uid()
       and d.revoked_at is null
       and d.expires_at > now()
       and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0))
$$;
revoke all on function public._msgr2_device_ok() from public;
grant execute on function public._msgr2_device_ok() to authenticated, service_role;

-- 유효한 기기의 종류(app·runner·resident). 무효면 null. 권한 RPC 첫 줄: if _msgr2_device_kind() is distinct from 'app' then 42501.
create or replace function public._msgr2_device_kind() returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select d.kind from public.msgr2_devices d
   where d.session_id = public._msgr2_session_id()
     and d.user_id = auth.uid()
     and d.revoked_at is null
     and d.expires_at > now()
     and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0)
$$;
revoke all on function public._msgr2_device_kind() from public;
grant execute on function public._msgr2_device_kind() to authenticated, service_role;

-- 기기 등록(앱·본체 시작 때). 세션 하나 = 행 하나. 반환: {device_id, kind, expires_at, wrote}.
-- 거부: 세션 클레임 없음 42501 · 값 모양 22023 · 최소 버전 미만 app_version_unsupported · 약속 범위 밖 link_version_unsupported ·
--       폐기(행 폐기·세대 지남) device_revoked · 만료 device_expired · 종류/앱 바꾸기 42501. 거부할 때는 아무것도 쓰지 않는다.
create or replace function public.msgr2_device_register(
  p_kind text, p_app text, p_app_version text,
  p_link_min int default null, p_link_max int default null,
  p_runners text[] default null, p_push_token text default null
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  sid uuid := public._msgr2_session_id();
  v_runners text[] := coalesce(p_runners, '{}');
  v_link int4range;
  min_v text; srv_min int; srv_max int; ugen int;
  d public.msgr2_devices%rowtype;
  wrote boolean := false;
  new_exp timestamptz;
begin
  if me is null or sid is null then raise exception 'msgr2_session_required' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('app', 'runner', 'resident')
     or p_app is distinct from (case p_kind when 'app' then 'messenger' else 'desktop' end)
     or public._msgr2_ver(p_app_version) is null or char_length(p_app_version) > 32
     or cardinality(v_runners) > 16 or exists (select 1 from unnest(v_runners) r where r is null or char_length(r) not between 1 and 32)
     or (p_kind = 'app' and cardinality(v_runners) > 0)
     or char_length(p_push_token) > 4096
  then raise exception 'msgr2_device_invalid' using errcode = '22023'; end if;

  -- 약속 버전: 본체(runner·resident)는 [min,max]를 꼭 알린다. 앱은 싣지 않는다.
  if p_kind = 'app' then
    if p_link_min is not null or p_link_max is not null then raise exception 'msgr2_device_invalid' using errcode = '22023'; end if;
  else
    if p_link_min is null or p_link_max is null or p_link_min < 1 or p_link_max < p_link_min or p_link_max > 1000 then
      raise exception 'msgr2_device_invalid' using errcode = '22023';
    end if;
    v_link := int4range(p_link_min, p_link_max, '[]');
    select case when s.value ~ '^[0-9]{1,4}$' then s.value::int end into srv_min from public.msgr_settings s where s.key = 'link_min_v';
    select case when s.value ~ '^[0-9]{1,4}$' then s.value::int end into srv_max from public.msgr_settings s where s.key = 'link_max_v';
    if (srv_min is not null and p_link_max < srv_min) or (srv_max is not null and p_link_min > srv_max) then
      raise exception 'link_version_unsupported' using errcode = 'P0001';
    end if;
  end if;

  -- 최소 앱 버전(D10): 본체 'desktop'·메신저 'messenger' 키를 argo_min_app_version이 그대로 돌려준다. 값이 없으면 막지 않는다.
  min_v := public.argo_min_app_version(p_app);
  if min_v is not null and public._msgr2_ver(min_v) is not null and public._msgr2_ver(p_app_version) < public._msgr2_ver(min_v) then
    raise exception 'app_version_unsupported' using errcode = 'P0001', detail = min_v;
  end if;

  ugen := coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = me), 0);
  select * into d from public.msgr2_devices where session_id = sid;
  if not found then
    insert into public.msgr2_devices (user_id, kind, app, app_version, link_v, runners, session_id, push_token, gen, expires_at, registered_at)
    values (me, p_kind, p_app, p_app_version, v_link, v_runners, sid, p_push_token, ugen, now() + interval '30 days', now())
    on conflict (session_id) do nothing
    returning * into d;
    if d.id is not null then
      wrote := true;
      -- 보존 규칙(DB 위생 4): 새 기기를 만들 때만, 내 행 중 60일 넘게 등록이 없고 세션도 사라진 행을 지운다.
      if to_regclass('auth.sessions') is not null then
        delete from public.msgr2_devices o
         where o.user_id = me and o.id <> d.id and o.registered_at < now() - interval '60 days'
           and not exists (select 1 from auth.sessions s where s.id = o.session_id);
      end if;
      return jsonb_build_object('device_id', d.id, 'kind', d.kind, 'expires_at', d.expires_at, 'wrote', wrote);
    end if;
    select * into d from public.msgr2_devices where session_id = sid; -- 동시 등록이 먼저 만들었다
  end if;

  if d.user_id is distinct from me then raise exception 'msgr2_session_required' using errcode = '42501'; end if;
  if d.kind is distinct from p_kind or d.app is distinct from p_app then raise exception 'msgr2_device_kind_locked' using errcode = '42501'; end if;
  if d.revoked_at is not null or d.gen is distinct from ugen then raise exception 'device_revoked' using errcode = '42501'; end if;
  if d.expires_at <= now() then raise exception 'device_expired' using errcode = '42501'; end if;

  -- 1일 안에 같은 값이면 쓰지 않는다(유휴 쓰기 0 — 행 xmin 그대로, 트랜잭션 번호도 안 생긴다).
  update public.msgr2_devices u
     set app_version = p_app_version, link_v = v_link, runners = v_runners, push_token = p_push_token,
         registered_at = now(), expires_at = now() + interval '30 days'
   where u.id = d.id
     and (u.registered_at < now() - interval '1 day'
          or (u.app_version, u.link_v, u.runners, u.push_token) is distinct from (p_app_version, v_link, v_runners, p_push_token))
  returning u.expires_at into new_exp;
  wrote := found;
  return jsonb_build_object('device_id', d.id, 'kind', d.kind, 'expires_at', coalesce(new_exp, d.expires_at), 'wrote', wrote);
end $$;
revoke all on function public.msgr2_device_register(text, text, text, int, int, text[], text) from public;
grant execute on function public.msgr2_device_register(text, text, text, int, int, text[], text) to authenticated;

-- 기기 폐기(내 기기 관리 화면). 유효한 app 기기만 부른다 — runner·resident(에이전트 셸이 쥘 수 있는 세션)는 42501.
-- 다른 사용자의 기기는 없는 것과 같은 42501. 이미 폐기된 기기는 쓰지 않고 false. 폐기하면 u:<uid>로 알려 열린 소켓이 끊게 한다.
create or replace function public.msgr2_device_revoke(p_device uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); t public.msgr2_devices%rowtype;
begin
  if public._msgr2_device_kind() is distinct from 'app' then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  select * into t from public.msgr2_devices where id = p_device and user_id = me;
  if not found then raise exception 'msgr2_device_not_found' using errcode = '42501'; end if;
  if t.revoked_at is not null then return false; end if;
  update public.msgr2_devices set revoked_at = now() where id = t.id and revoked_at is null;
  perform realtime.send(jsonb_build_object('device_id', t.id), 'device_revoked', 'u:' || me::text, true);
  return true;
end $$;
revoke all on function public.msgr2_device_revoke(uuid) from public;
grant execute on function public.msgr2_device_revoke(uuid) to authenticated;

-- 내 기기 목록(유효한 기기라면 종류와 관계없이). 세션 id·푸시 토큰은 돌려주지 않는다. state는 읽을 때 계산한다.
create or replace function public.msgr2_devices_list()
  returns table (id uuid, kind text, app text, app_version text, runners text[], created_at timestamptz,
                 registered_at timestamptz, expires_at timestamptz, revoked_at timestamptz, state text, is_current boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); ugen int;
begin
  if not public._msgr2_device_ok() then raise exception 'device_revoked' using errcode = '42501'; end if;
  ugen := coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = me), 0);
  return query
    select d.id, d.kind, d.app, d.app_version, d.runners, d.created_at, d.registered_at, d.expires_at, d.revoked_at,
           case when d.revoked_at is not null or d.gen <> ugen then 'revoked' when d.expires_at <= now() then 'expired' else 'active' end,
           d.session_id = public._msgr2_session_id()
      from public.msgr2_devices d
     where d.user_id = me
     order by d.registered_at desc
     limit 200;
end $$;
revoke all on function public.msgr2_devices_list() from public;
grant execute on function public.msgr2_devices_list() to authenticated;
