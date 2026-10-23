-- 메신저 재공개 전 검수(2026-10-23, origin/main 2d3c9891) F1 서버·F4.
-- F1 에이전트 사용 범위 보존: 앱이 에이전트를 팀 방에 넣을 때마다 msgr2_set_seat(p_allow 'all')을 불러, 주인이 정한 범위('나만'·'지정한 사람')가
--    'all'로 덮어써졌다(팀 멤버 누구나 주인 PC·요금제로 일을 시킬 수 있게 됨, 0.1.63 대비 권한 회귀). 범위 판정(_msgr2_make_offer 등)은 그대로 맞다.
--    msgr2_seat_ensure(에이전트, 공간): 자리가 없으면 'all'로 만들고, 있으면 범위를 그대로 둔다(빠졌던 자리는 되살리되 범위는 보존).
--    검사는 msgr2_set_seat와 같다(앱 기기·내 에이전트·그 팀 공간의 손님 아닌 활동 멤버). 같은 값이면 쓰지 않는다(쓰기 0).
--    범위를 바꾸는 길은 종전대로 msgr2_set_seat(주인만, allow·users)이다 — 앱(사용 범위 시트)이 이것을 부르게 고친다(메신저 PR).
-- F4 Pro가 끝난 계정: Pro일 때 등록한 기기(기기 갱신은 Pro를 보지 않는다 — 갑자기 끊기지 않게)로 옛 글에 첨부를 계속 올릴 수 있었다.
--    msgr2_attachment_add와 _msgr2_storage_write의 사람 갈래에 _msgr2_pro_ok(auth.uid())를 더한다(관문 스위치 msgr2_pro_gate=off면 통과 — 종전 판정과 같음).
--    본문은 직전 정의(20261020200200·20261020200800) 그대로이고 그 한 줄만 다르다. 에이전트(본체 기기) 갈래·읽기는 바꾸지 않는다.
-- c(이름 없는 옛 봇 재생성 막기): 맨 아래 _msgr2_bf_agents 절.
-- 되돌림: scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql · 시험: test/msgr2-seat-keep-pro-attach-pg.test.mjs

create or replace function public.msgr2_seat_ensure(p_agent uuid, p_space uuid) returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur public.msgr2_agent_seats;
begin
  if uid is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr2_agents where id = p_agent and owner_user_id = uid)
     or not exists (select 1 from public.msgr2_spaces where id = p_space and kind = 'team' and deleted_at is null)
     or not exists (select 1 from public.msgr2_space_members where space_id = p_space and user_id = uid and role in ('owner', 'admin', 'member') and removed_at is null and (expires_at is null or expires_at > now())) then
    raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  select * into cur from public.msgr2_agent_seats where agent_id = p_agent and space_id = p_space for update;
  if cur.agent_id is null then
    insert into public.msgr2_agent_seats (agent_id, space_id, allow, allow_users, added_by) values (p_agent, p_space, 'all', '{}', uid)
    on conflict (agent_id, space_id) do nothing;
    return 'created';
  end if;
  if cur.removed_at is not null then
    update public.msgr2_agent_seats set removed_at = null where agent_id = p_agent and space_id = p_space; -- 범위(allow·allow_users)는 그대로
    return 'restored';
  end if;
  return 'kept';
end $$;
revoke all on function public.msgr2_seat_ensure(uuid, uuid) from public, anon;
grant execute on function public.msgr2_seat_ensure(uuid, uuid) to authenticated;

create or replace function public.msgr2_attachment_add(p_message bigint, p_index int, p_name text, p_mime text, p_bytes bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; sp uuid; nm text; obj text; aid bigint;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if; -- S5: 본체(runner) 세션이 사람 글에 첨부하지 못한다
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if; -- Pro가 끝난 계정의 옛 기기(F4)
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

create or replace function public._msgr2_storage_write(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record; full_path text := 'msgr/' || p_name;
begin
  if rid is null or auth.uid() is null or public._msgr2_paused() then return false; end if;
  if split_part(p_name, '/', 1) = 'p' then return false; end if; -- 옛 개인 방 파일은 읽기 전용(덮어쓰지 않는다)
  if public._msgr2_device_ok() and public._msgr2_pro_ok(auth.uid()) and coalesce((public.msgr2_access(rid)).write, false) and exists ( -- 사람 갈래는 Pro만(F4)
       select 1 from public.msgr2_attachments a join public.msgr2_messages m on m.id = a.message_id
        where a.storage_path = full_path and a.room_id = rid and m.author_kind = 'user' and m.author_user_id = auth.uid() and m.deleted_at is null) then
    return true;
  end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_work_files f join public.msgr2_works w on w.id = f.work_id
                  where f.storage_path = full_path and f.room_id = rid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                    and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval')
                    and public._msgr2_owner_active(w.room_id, auth.uid())); -- S2: 주인이 팀 공간에서 빠졌으면 리스로 쓰지 못한다
end $$;
revoke all on function public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;

-- c 이름 없는 옛 봇이 백필로 다시 생기지 않게(유건 사용 검수 2026-10-23 "정체모를 이상한 이름의 봇들이 너무 많은데").
--    10/16에 지운 VPS 봇(msgr_bot_create — slug 'bot-'+16진 12자)의 자리(msgr_crews)는 없고 msgr_agents 행만 남아, 백필 1단계가 "이름 = slug, active"로 옮겼다
--    (맥 one 운영 읽기: 유건 계정 45개, 자리·일·글 0). 운영 행 삭제는 맥 one이 따로 한다. 백필은 msgr2_backfill_run·restart(service_role)로 다시 돌 수 있으므로,
--    다시 돌아도 같은 행을 되살리지 않게 _msgr2_bf_agents가 **자리가 하나도 없는 'bot-'+12자 행만** 건너뛴다. 자리가 없는 보통 에이전트(검수 #1084)는 종전대로 옮긴다.
--    본문은 20261020200700 그대로이고 where 한 줄만 다르다. 이미 옮긴 msgr2_agents 행은 바꾸지 않는다(지우지 않는다).
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
   where a.slug !~ '^bot-[0-9a-f]{12}$' or exists (select 1 from public.msgr_crews c where c.agent_id = a.id) -- 자리를 지운 옛 VPS 봇(msgr_bot_create 'bot-'+12자)은 옮기지 않는다(20261023180000)
  on conflict (id) do update set display_name = excluded.display_name, role_text = excluded.role_text, face = excluded.face,
    hosting = excluded.hosting, status = excluded.status, updated_at = now()
  where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from (excluded.display_name, excluded.role_text, excluded.face, excluded.hosting, excluded.status);
  get diagnostics written = row_count;
  done := true;
end $$;

-- ── 보안(재공개 전 검수 ① 보안, 임시 PG 재현) ─────────────────────────────────────
-- S4 본체·폐기 기기 세션으로 계정 삭제가 되던 것: 지금 세션이 기기 행이 있는 앱이 아닌 세션(runner·resident) 또는 폐기·만료·세대 지난 기기면 거부한다.
--    기기 행이 없는 세션(옛 v1 앱 0.1.63·웹)은 종전대로 통과한다 — 재공개 전 설치본에서 계정 삭제가 막히지 않게. 기기 폐기 때 그 로그인 세션도 끊는다(msgr2_device_revoke).
-- S5 본체(runner) 세션이 사람 글을 직접 넣던 것: 사람 글 넣기 정책·msgr2_attachment_add·msgr2_message_ready에 _msgr2_device_app()(앱 기기만). 본체의 에이전트 글은 msgr2_link_send(서버 함수)라 무관하다.
-- S2 팀 공간에서 내보낸(또는 손님 기한이 끝난) 주인의 본체가 진행 중인 일로 계속 쓰고 읽던 것: msgr2_link_send·msgr2_link_upload_slot·_msgr2_rt_send_ok·Storage 리스 갈래(읽기·쓰기)에서
--    _msgr2_owner_active(방, 주인)을 본다 — 방의 공간이 팀이면 주인이 그 공간의 활동 멤버(기한 안)여야 한다. 거부는 'work_closed'(본체는 그 일을 끝낸다).
--    방에서만 빠진 주인(공간에는 남음)은 종전대로 리스를 쥔 그 일 동안 쓰고 읽는다(#1076 설계, test/msgr2-realtime-storage-pg.test.mjs 'Storage — 방을 못 읽는 주인의 runner').
--    처음 판(방 읽기 권한으로 판정)은 이 경우까지 막아 회귀였다(PG 시험으로 확인).
-- 3  사람 채팅 꺼짐(lite)에서 Pro가 끝난 계정의 사람 글: msgr2_lite_guard가 lite일 때도 Pro를 본다(사람 채팅 켬은 종전대로).
create or replace function public._msgr2_owner_active(p_room uuid, p_uid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.deleted_at is null and (s.kind <> 'team' or exists (
             select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = p_uid and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())))
      from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id where r.id = p_room), false)
$$;
revoke all on function public._msgr2_owner_active(uuid, uuid) from public, anon, authenticated;
create or replace function public._msgr2_session_untrusted() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr2_devices d
                  where d.session_id = public._msgr2_session_id() and d.user_id = auth.uid()
                    and (d.kind <> 'app' or d.revoked_at is not null or d.expires_at <= now()
                         or d.gen <> coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0)))
$$;
revoke all on function public._msgr2_session_untrusted() from public, anon;
grant execute on function public._msgr2_session_untrusted() to authenticated, service_role;

do $do$ begin
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    execute $w$
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_session_untrusted() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if; -- S4: 본체·폐기 기기 세션은 계정을 지우지 못한다
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 계정 삭제를 잠시 막는다(스위치 직후 다시 열린다)'; end if;
  return public._msgr_delete_me_body();
end $f$
$w$;
    revoke all on function public.msgr_delete_me() from public, anon;
    grant execute on function public.msgr_delete_me() to authenticated;
  end if;
end $do$;

drop policy if exists msgr2_messages_insert on public.msgr2_messages;
create policy msgr2_messages_insert on public.msgr2_messages for insert to authenticated with check (
  author_kind = 'user' and author_user_id = (select auth.uid()) and author_agent_id is null and kind = 'text'
  and deleted_at is null and edited_at is null and meta = '{}'::jsonb
  and (reply_to is null or (select public._msgr2_msg_in_room(reply_to, room_id)))
  and (select (public.msgr2_access(room_id)).write)
  and (select public._msgr2_device_app())); -- S5: 앱 기기만(본체 세션은 사람 글을 넣지 못한다)

create or replace function public.msgr2_link_send(p_env jsonb) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  uid uuid := auth.uid(); dv record; c text; t text; d jsonb; w public.msgr2_works; ev public.msgr2_work_events; ns record;
  st text; same boolean; v_until timestamptz := now() + make_interval(secs => public._msgr2_setting_int('msgr2_lease_s', 600));
  lg int; mid bigint; x jsonb; slots uuid[]; n int; agents jsonb := '[]'::jsonb; v_late boolean; meta jsonb; ecode text; ap_exp timestamptz;
  feats text[]; posts jsonb; np int; nwid uuid;
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
    if not public._msgr2_pro_ok(uid) then return public._msgr2_rej('pro_required'); end if; -- A+ 메신저 Pro 전용(약속 v1.1)
    -- 저장은 정해진 필드만 골라 담는다(화이트리스트) — 본체가 bot.url·키를 실어 보내도 서버에 남지 않는다. 봇은 hosting='bot'만 기록
    perform public.msgr2_agent_sync(coalesce((select jsonb_agg(jsonb_build_object('ws_id', a->>'ws', 'slug', a->>'slug', 'display_name', a->>'name',
      'role_text', a->>'role', 'face', case when jsonb_typeof(a->'face_hash') = 'string' then jsonb_build_object('hash', a->>'face_hash') end,
      'hosting', case when a->>'kind' = 'bot' then 'bot' else 'local' end))
      from jsonb_array_elements(d->'agents') a), '[]'::jsonb));
    -- 기능 알림(v1.1). 없으면 v1.0 본체 = 빈 목록. 값이 바뀔 때만 쓴다(쉬는 동안 쓰기 0)
    select coalesce(array_agg(distinct f order by f), '{}') into feats from jsonb_array_elements_text(coalesce(d->'features', '[]'::jsonb)) f;
    update public.msgr2_devices set features = feats where id = dv.id and features is distinct from feats;
    select coalesce(jsonb_agg(jsonb_build_object('ws', g.ws_id, 'slug', g.slug, 'id', g.id) order by g.ws_id, g.slug), '[]'::jsonb) into agents
      from public.msgr2_agents g join jsonb_array_elements(d->'agents') a on g.ws_id = a->>'ws' and g.slug = a->>'slug' where g.owner_user_id = uid;
    insert into public.msgr2_work_events (work_id, sender, seq, type, envelope_id, device_id, envelope)
    values (null, 'runner', (p_env->>'seq')::bigint, t, (p_env->>'id')::uuid, dv.id, p_env - 'data'); -- 목록 본문은 에이전트 표에 있다
    return jsonb_build_object('ok', true, 'agents', agents);
  end if;

  select * into w from public.msgr2_works where id = (p_env->>'work')::uuid for update;
  if not found or w.owner_user_id <> uid or w.agent_id <> (p_env->>'agent')::uuid then return public._msgr2_rej('work_not_found'); end if;
  if not public._msgr2_owner_active(w.room_id, uid) then return public._msgr2_rej('work_closed'); end if; -- S2: 주인이 팀 공간에서 빠졌으면(내보냄·손님 기한 끝) 그 일로 쓰지 못한다(리스 연장 포함)
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
    -- A+ 회의 결과(약속 v1.1 서버 규칙): 회의가 아닌 일에 posts, 회의 일에 handoffs(posts 유무와 무관), 참가자 밖 글쓴이·라운드·개수 초과 → post_denied
    posts := coalesce(d->'posts', '[]'::jsonb); np := jsonb_array_length(posts);
    if (np > 0 and w.kind <> 'meeting') or (w.kind = 'meeting' and jsonb_array_length(d->'handoffs') > 0)
       or (np > 0 and (np > cardinality(w.meeting_agents) * w.meeting_rounds
                       or exists (select 1 from jsonb_array_elements(posts) p where not ((p->>'agent')::uuid = any (w.meeting_agents)) or (p->>'round')::int > w.meeting_rounds))) then
      return public._msgr2_rej('post_denied');
    end if;
    select coalesce(array_agg((f #>> '{}')::uuid), '{}') into slots from jsonb_array_elements(d->'files') f;
    if cardinality(slots) <> (select count(distinct s) from unnest(slots) s)
       or (select count(*) from public.msgr2_work_files wf where wf.id = any (slots) and wf.work_id = w.id) <> cardinality(slots) then
      return public._msgr2_rej('upload_slot_invalid');
    end if;
    meta := jsonb_build_object('work', w.id) || case when v_late then jsonb_build_object('mark', ns.mark) else '{}'::jsonb end;
    if np > 0 then -- 회의: 에이전트별 글(글쓴이 = post.agent, meta.round). 요약 text는 방에 넣지 않는다. 파일은 마지막 글에
      for x in select p from jsonb_array_elements(posts) with ordinality as e(p, i) order by i loop
        insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
        values (w.room_id, w.topic_id, 'agent', (x->>'agent')::uuid, 'text', x->>'text',
                meta || jsonb_build_object('meeting', true, 'round', (x->>'round')::int), w.id) returning id into mid;
      end loop;
    else
      insert into public.msgr2_messages (room_id, topic_id, author_kind, author_agent_id, kind, body, meta, work_id)
      values (w.room_id, w.topic_id, 'agent', w.agent_id, 'text', d->>'text', meta, w.id) returning id into mid;
    end if;
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
      nwid := public._msgr2_make_offer(w.room_id, w.topic_id, (x->>'agent')::uuid, 'agent', w.agent_id, w.root_user_id, x->>'text', mid, w.id, w.depth + 1);
      -- R9: 넘김을 만들 때마다 연속 답장 수를 올린다 — 결과 1개가 넘김 8개를 한꺼번에 통과시키지 못하게(앞은 반복 전 한 번만 올렸다)
      if nwid is not null then perform public._msgr2_bump_streak(w.room_id); end if;
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
    || case when t = 'work.accept' then jsonb_build_object('lease_gen', lg, 'lease_until', to_char(v_until at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'attachments', public._msgr2_attachments_of(w.source_message_id)) else '{}'::jsonb end; -- 사람 글의 첨부는 글을 넣은 뒤에 붙어 offer에 없을 수 있다
end $$;

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
  if not public._msgr2_owner_active(w.room_id, uid) then return public._msgr2_rej('work_closed'); end if; -- S2
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

create or replace function public._msgr2_rt_send_ok(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare dv record;
begin
  if auth.uid() is null or p_topic is null or p_topic !~* '^v2:wk:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_works w where w.id = split_part(p_topic, ':', 3)::uuid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                   and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval')
                   and public._msgr2_owner_active(w.room_id, auth.uid())); -- S2
end $$;

create or replace function public._msgr2_storage_read(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record;
begin
  if rid is null or auth.uid() is null then return false; end if;
  if coalesce((public.msgr2_access(rid)).read, false) then return true; end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_works w where w.room_id = rid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                   and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval')
                   and public._msgr2_owner_active(w.room_id, auth.uid())); -- S2
end $$;

create or replace function public.msgr2_message_ready(p_message bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; w public.msgr2_msg_waits; have int; ok int; k int;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if; -- S5
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into m from public.msgr2_messages where id = p_message;
  if m.id is null or m.author_kind <> 'user' or m.author_user_id <> uid then raise exception 'msgr2_message_not_found' using errcode = '42501'; end if;
  if exists (select 1 from public.msgr2_msg_waits x where x.author_user_id = uid and x.message_id <> p_message) then perform public._msgr2_flush_waits(null, uid); end if; -- 폴백 ②
  select * into w from public.msgr2_msg_waits where message_id = p_message for update;
  if w.message_id is null then return jsonb_build_object('ok', true, 'offers', 0); end if; -- 이미 만들었다(또는 기다림 없는 글)
  select count(*), count(*) filter (where exists (select 1 from storage.objects o
           where o.bucket_id = split_part(a.storage_path, '/', 1) and o.name = substr(a.storage_path, position('/' in a.storage_path) + 1)))
    into have, ok from public.msgr2_attachments a where a.message_id = m.id;
  if have < m.files_expected or ok < have then raise exception 'msgr2_attachment_missing' using errcode = '22023', detail = format('%s/%s', ok, m.files_expected); end if;
  delete from public.msgr2_msg_waits where message_id = p_message;
  k := public._msgr2_user_offers(m);
  return jsonb_build_object('ok', true, 'offers', k);
end $$;

create or replace function public.msgr2_lite_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s public.msgr2_spaces; r public.msgr2_rooms; n int; lite boolean; people boolean;
begin
  if uid is null then return new; end if; -- 서비스·이전 문맥
  lite := public._msgr2_lite(); people := public._msgr2_people();
  if not lite and not people and tg_table_name <> 'msgr2_room_members' then return new; end if;

  if tg_table_name = 'msgr2_spaces' then
    if lite and new.kind <> 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people and new.kind = 'team' and not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_space_invites' then
    if lite then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_space_invites i where i.created_by = uid and i.created_at > now() - interval '1 day';
      if n >= public._msgr2_clamp('msgr2_limit_invites_day', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'invites_day'; end if;
    end if;
    return new; -- 받는 사람의 요금제는 보지 않는다(수락 때 공간 멤버 관문)
  end if;

  if tg_table_name = 'msgr2_space_members' then
    if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if; -- 들어오기·되살리기만
    if people and exists (select 1 from public.msgr2_spaces x where x.id = new.space_id and x.kind = 'team') then -- 개인 공간(주인 1행)은 관문 밖
      if not public._msgr2_pro_ok(new.user_id) then
        raise exception '%', case when new.user_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
      end if;
      select count(*) into n from public.msgr2_space_members m
       where m.space_id = new.space_id and m.removed_at is null and m.user_id <> new.user_id and (m.expires_at is null or m.expires_at > now());
      if n >= public._msgr2_clamp('msgr2_limit_space_members', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'space_members'; end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_messages' then
    if new.author_kind <> 'user' then return new; end if;
    if lite and not public._msgr2_lite_room_ok(new.room_id) then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if not people and not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if; -- 사람 채팅 꺼짐(lite)에서도 Pro가 끝난 계정의 옛 기기는 사람 글을 쓰지 못한다(관문 off면 통과)
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.author_kind = 'user' and m.author_user_id = uid and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_user_msg_min', 30, 120) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'user_messages'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.room_id = new.room_id and m.author_kind = 'user' and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_room_msg_min', 60, 300) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_messages'; end if;
    end if;
    return new;
  end if;

  -- msgr2_room_members: 새로 넣거나 빠졌던 멤버를 되살릴 때
  if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  if people and new.member_kind = 'user' then
    if not public._msgr2_pro_ok(new.member_id) then
      raise exception '%', case when new.member_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
    end if;
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'user' and m.removed_at is null and m.member_id <> new.member_id;
    if n >= public._msgr2_clamp('msgr2_limit_room_members', 50, 50) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_members'; end if;
  end if;
  if lite then
    if s.kind is distinct from 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if new.member_kind = 'user' then
      if new.member_id <> s.owner_user_id then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
      return new;
    end if;
    if not exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.owner_user_id = s.owner_user_id) then
      raise exception 'msgr2_lite_only' using errcode = '42501';
    end if;
  end if;
  if new.member_kind = 'agent' then
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id <> new.member_id;
    if r.meeting then -- 회의방 상한은 lite와 상관없이 늘
      if exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.hosting = 'bot') then
        raise exception 'msgr2_meeting_no_bot' using errcode = '22023';
      end if;
      if n >= public._msgr2_clamp('msgr2_meeting_agents', 5, 5) then raise exception 'msgr2_meeting_full' using errcode = '22023'; end if;
    elsif lite and n >= 1 then
      raise exception 'msgr2_lite_only' using errcode = '42501'; -- lite: 회의방이 아닌 방은 에이전트 1명(1:1)
    end if;
  end if;
  return new;
end $$;

create or replace function public.msgr2_device_revoke(p_device uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); t public.msgr2_devices%rowtype;
begin
  if not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  select * into t from public.msgr2_devices where id = p_device and user_id = me;
  if not found then raise exception 'msgr2_device_not_found' using errcode = '42501'; end if;
  if t.revoked_at is not null then return false; end if;
  update public.msgr2_devices set revoked_at = now() where id = t.id and revoked_at is null;
  -- S4: 그 기기의 로그인 세션도 끊는다 — 폐기한 기기(세션 파일을 가진 본체 포함)가 옛 RPC(계정 삭제 등)를 계속 부르지 못하게. 권한이 없거나 표가 없으면(시험 판) 건너뛴다
  begin
    if to_regclass('auth.sessions') is not null then execute 'delete from auth.sessions where id = $1' using t.session_id; end if;
  exception when insufficient_privilege or undefined_table then null;
  end;
  perform realtime.send(jsonb_build_object('device_id', t.id), 'device_revoked', 'v2:u:' || me::text, true); -- 약속 v1 TOPICS.user(옛 u: 토픽과 겹치지 않게, #1076 검수)
  return true;
end $$;
