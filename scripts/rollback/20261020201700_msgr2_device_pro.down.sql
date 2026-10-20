-- 되돌림: 20261020201700_msgr2_device_pro.sql — 기기 등록을 20261020200100 정의(Pro 확인 없음)로 되돌린다. 데이터는 건드리지 않는다.
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
  min_v text; srv_min int; srv_max int; ugen int; bumped timestamptz; sess_at timestamptz;
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

  select g.gen, g.bumped_at into ugen, bumped from public.msgr2_user_gen g where g.user_id = me;
  ugen := coalesce(ugen, 0);
  select * into d from public.msgr2_devices where session_id = sid;
  if not found then
    -- 새 행: GoTrue에 살아 있는 내 세션이어야 하고, app은 로그인 10분 안, 세대를 올린 뒤 로그인한 세션이어야 한다.
    select s.created_at into sess_at from auth.sessions s where s.id = sid and s.user_id = me;
    if not found or sess_at is null or (p_kind = 'app' and sess_at < now() - interval '10 minutes') then
      raise exception 'device_login_required' using errcode = '42501';
    end if;
    if bumped is not null and sess_at < bumped then raise exception 'device_revoked' using errcode = '42501'; end if;
    insert into public.msgr2_devices (user_id, kind, app, app_version, link_v, runners, session_id, push_token, gen, expires_at, registered_at)
    values (me, p_kind, p_app, p_app_version, v_link, v_runners, sid, p_push_token, ugen, now() + interval '30 days', now())
    on conflict (session_id) do nothing
    returning * into d;
    if d.id is not null then
      wrote := true;
      -- 보존 규칙(DB 위생 4): 새 기기를 만들 때만, 내 행 중 60일 넘게 등록이 없고 세션도 사라진 행을 지운다.
      delete from public.msgr2_devices o
       where o.user_id = me and o.id <> d.id and o.registered_at < now() - interval '60 days'
         and not exists (select 1 from auth.sessions s where s.id = o.session_id);
      if p_push_token is not null then
        update public.msgr2_devices o set push_token = null where o.push_token = p_push_token and o.id <> d.id;
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
  if wrote and p_push_token is not null and p_push_token is distinct from d.push_token then
    update public.msgr2_devices o set push_token = null where o.push_token = p_push_token and o.id <> d.id;
  end if;
  return jsonb_build_object('device_id', d.id, 'kind', d.kind, 'expires_at', coalesce(new_exp, d.expires_at), 'wrote', wrote);
end $$;
revoke all on function public.msgr2_device_register(text, text, text, int, int, text[], text) from public, anon;
grant execute on function public.msgr2_device_register(text, text, text, int, int, text[], text) to authenticated;
