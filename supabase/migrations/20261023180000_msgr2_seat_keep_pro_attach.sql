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
                       or exists (select 1 from jsonb_array_elements(posts) p where not ((p->>'agent')::uuid = any (w.meeting_agents)) or (p->>'round')::int > w.meeting_rounds)
                       or exists (select 1 from jsonb_array_elements(posts) p where not exists ( -- S1: 글쓴이는 이 본체 주인의 에이전트만
                                    select 1 from public.msgr2_agents g where g.id = (p->>'agent')::uuid and g.owner_user_id = uid)))) then
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

-- ── b. 대화(방) 삭제(재공개 전 검수 b, 총괄 결정 2026-10-23 "실제 삭제") ──────────────────────────
-- 원인: v2 앱의 방 삭제는 msgr2_rooms 직접 delete라 권한이 없어 거부됐다(F7 1번). v2 표는 FK 연쇄 삭제가 없다.
-- 처방: 정의자 RPC 두 개 + Storage 지우기 정책. 앱 순서 = msgr2_room_delete_files(지울 수 있는지 + 파일 목록) → Storage API remove → msgr2_room_delete.
--   파일 목록이 삭제와 같은 판정(_msgr2_room_delete_check)을 먼저 본다 — 지우지 못할 방의 파일을 먼저 지우지 않게. 그 사이 일이 시작되면 삭제가 work_active로 거부되고 파일만 지워진다(창이 짧아 받아들인다).
--   누가 지우나(v1 20261006170000과 같은 규칙): 1:1(direct) = 방에 있는 참가자 누구나. 그 밖의 방 = 관리(팀 owner·admin, 개인 공간 주인)
--   또는 만든 사람이면서 지금 방에 있음. 읽을 수 없는 방(남의 방)은 못 지운다.
--   막는 경우: 진행 중인 일(offered·accepted·running·awaiting_approval, 만료·멈춤 판정 뒤)이 있으면 'work_active' — 실행 중인 본체가 사라진 행을 쓰지 않게.
--   지우는 행: 반응·대기·푸시 기록·결재·일 사건·효과·일 파일·일·첨부·글·토픽·읽음·설정·카운터·방 멤버·방, 같은 id의 옛 msgr_channels(옛 글·첨부·멤버는 옛 FK cascade).
--   옛 표를 같이 지우는 이유: 백필(msgr2_backfill_run·restart)이 다시 돌면 옛 채널에서 방·글을 되살린다. 옛 앱의 목록에도 남지 않게(v1 삭제와 같은 결과).
--   일지(msgr_journal_entries)·신고(msgr_reports)는 지우지 않는다(DB 위생 1: 기억 데이터). 글 연결과 신고의 방 연결은 비우고(옛 FK on delete set null과 같다),
--   일지의 방 id는 비울 수 없는 열이라 남긴다 — v1은 일지까지 cascade로 지웠지만 여기서는 남긴다(지운 방은 아무도 읽을 수 없어 방 권한으로 걸러진다).
--   반응 지우기 속도 제한(msgr2_rate_guard)은 이 함수 안에서만 건너뛴다(트랜잭션 한정 표지 msgr2.room_drop). 표지를 위조해도 반응 지우기 속도 제한만 풀린다(권한 판정 아님).
--   동시성: 방 행을 for update로 잡는다 — 그 방에 글·일을 넣는 쪽(FK의 key share)이 기다렸다가 방이 없어 실패한다.
-- 부하: 사용자가 누를 때만. 주기 작업·폴링 없음. 방 하나의 행 수만큼 지운다.

-- 판정: 이 사람이 이 방을 지울 수 있나(파일 목록·삭제·Storage 지우기가 같이 쓴다)
create or replace function public._msgr2_room_deletable(p_room uuid, p_uid uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; a public.msgr2_access_t; in_room boolean;
begin
  if p_uid is null or p_room is null then return false; end if;
  select * into r from public.msgr2_rooms where id = p_room;
  if not found then return false; end if;
  a := public._msgr2_access_for(p_room, p_uid);
  if not coalesce(a.read, false) then return false; end if;
  in_room := exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id = p_uid and m.removed_at is null);
  if r.kind = 'direct' then return in_room; end if;
  return coalesce(a.manage, false) or (r.created_by = p_uid and in_room);
end $$;
revoke all on function public._msgr2_room_deletable(uuid, uuid) from public, anon, authenticated;

-- 지울 수 있는지 미리 본다: 거부 코드 | null(지울 수 있음). 파일 목록과 삭제가 같이 쓴다 — 지우지 못할 방의 파일을 먼저 지우지 않게.
create or replace function public._msgr2_room_delete_check(p_room uuid, p_uid uuid) returns text
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public._msgr2_room_deletable(p_room, p_uid) then return 'forbidden'; end if;
  if public._msgr2_migration_window() then return 'migration'; end if;
  if exists (select 1 from public.msgr2_works w where w.room_id = p_room
              and public._msgr2_effective_state(w.state, w.expires_at, w.lease_until, w.has_result) in ('offered', 'accepted', 'running', 'awaiting_approval')) then
    return 'work_active';
  end if;
  return null;
end $$;
revoke all on function public._msgr2_room_delete_check(uuid, uuid) from public, anon, authenticated;

-- 지울 파일 목록: 첨부·일 파일 중 경로가 이 방을 가리키는 것만(버킷 접두어 'msgr/'는 뗀다 — v2 행은 붙이고 이전된 옛 행은 안 붙인다).
-- 다른 방 경로를 가리키는 행은 돌려주지 않는다(그 방의 파일을 지우지 않게). 반환: {ok, paths} | 거부({ok:false, code}).
create or replace function public.msgr2_room_delete_files(p_room uuid) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); why text := public._msgr2_room_delete_check(p_room, uid);
begin
  if why is not null then return public._msgr2_rej(why); end if;
  return jsonb_build_object('ok', true, 'paths', coalesce((select jsonb_agg(distinct p order by p) from (
      select regexp_replace(a.storage_path, '^msgr/', '') p from public.msgr2_attachments a where a.room_id = p_room
      union all
      select regexp_replace(f.storage_path, '^msgr/', '') from public.msgr2_work_files f where f.room_id = p_room) x
    where public._msgr2_storage_room(p) = p_room), '[]'::jsonb));
end $$;
revoke all on function public.msgr2_room_delete_files(uuid) from public, anon;
grant execute on function public.msgr2_room_delete_files(uuid) to authenticated;

create or replace function public.msgr2_room_delete(p_room uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); r public.msgr2_rooms; tell uuid[]; x uuid; n bigint; why text;
begin
  select * into r from public.msgr2_rooms where id = p_room for update;
  if not found then return public._msgr2_rej('forbidden'); end if;
  why := public._msgr2_room_delete_check(p_room, uid);
  if why is not null then return public._msgr2_rej(why); end if;
  if public._msgr2_people() then
    perform public._msgr2_rate('room_archive', 'minute', public._msgr2_clamp('msgr2_limit_room_archive_min', 10, 30)); -- 보관과 같은 상한을 나눠 쓴다
  end if;
  tell := array(select public._msgr2_room_humans(p_room));
  perform set_config('msgr2.room_drop', p_room::text, true);
  -- 일지·신고는 남기고 연결만 비운다
  if to_regclass('public.msgr_journal_entries') is not null then
    update public.msgr_journal_entries set source_msg_id = null where source_msg_id in (select id from public.msgr2_messages where room_id = p_room);
    -- channel_id는 비울 수 없는 열이라 그대로 둔다(옛 FK는 cascade였지만 이전 때 떼어 냈다 — 일지는 기억 데이터라 지우지 않는다. 읽는 쪽은 방 권한으로 거른다)
  end if;
  if to_regclass('public.msgr_reports') is not null then
    update public.msgr_reports set message_id = null where message_id in (select id from public.msgr2_messages where room_id = p_room);
    update public.msgr_reports set channel_id = null where channel_id = p_room;
  end if;
  delete from public.msgr2_reactions where message_id in (select id from public.msgr2_messages where room_id = p_room);
  delete from public.msgr2_msg_waits where room_id = p_room;
  delete from public.msgr2_push_sent where message_id in (select id from public.msgr2_messages where room_id = p_room);
  delete from public.msgr2_push_gate where room_id = p_room;
  delete from public.msgr2_approvals where room_id = p_room or work_id in (select id from public.msgr2_works where room_id = p_room);
  delete from public.msgr2_work_events where work_id in (select id from public.msgr2_works where room_id = p_room);
  delete from public.msgr2_effects where work_id in (select id from public.msgr2_works where room_id = p_room);
  delete from public.msgr2_work_files where room_id = p_room or work_id in (select id from public.msgr2_works where room_id = p_room);
  update public.msgr2_works set parent_work_id = null where room_id <> p_room and parent_work_id in (select id from public.msgr2_works where room_id = p_room);
  delete from public.msgr2_works where room_id = p_room;
  delete from public.msgr2_attachments where room_id = p_room;
  delete from public.msgr2_messages where room_id = p_room; -- rule-ok: 방 주인·참가자가 누른 대화 삭제(v1 msgr_channels 삭제와 같은 결과, 총괄 결정 2026-10-23 "실제 삭제", 유건 "승인할테니까 지우라고 하고"). 운영 정리 아님
  get diagnostics n = row_count;
  delete from public.msgr2_topics where room_id = p_room;
  delete from public.msgr2_reads where room_id = p_room;
  delete from public.msgr2_prefs where room_id = p_room;
  delete from public.msgr2_room_counters where room_id = p_room;
  delete from public.msgr2_room_members where room_id = p_room;
  delete from public.msgr2_rooms where id = p_room;
  if to_regclass('public.msgr_channels') is not null then
    delete from public.msgr_channels where id = p_room; -- 옛 글·첨부·멤버·반응은 옛 FK cascade(v1 deleteChannel과 같은 길)
  end if;
  perform set_config('msgr2.room_drop', '', true);
  foreach x in array tell loop
    perform public._msgr2_send_u(x, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', p_room, 'removed', true));
  end loop;
  return jsonb_build_object('ok', true, 'messages', n);
end $$;
revoke all on function public.msgr2_room_delete(uuid) from public, anon;
grant execute on function public.msgr2_room_delete(uuid) to authenticated;

-- 반응 지우기 속도 제한: 방 삭제 안에서는 건너뛴다(본문은 20261020201600 그대로 + 첫 갈래 한 줄)
create or replace function public.msgr2_rate_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_people() then return coalesce(new, old); end if;
  if tg_table_name = 'msgr2_reactions' then
    if tg_op = 'DELETE' and coalesce(current_setting('msgr2.room_drop', true), '') <> '' then return old; end if; -- b: 방 삭제(msgr2_room_delete) 안
    perform public._msgr2_rate('reactions', 'minute', public._msgr2_clamp('msgr2_limit_reactions_min', 60, 120));
  elsif tg_op = 'INSERT' then -- msgr2_rooms
    perform public._msgr2_rate('room_create', 'minute', public._msgr2_clamp('msgr2_limit_room_create_min', 10, 30));
    perform public._msgr2_rate('room_create', 'day', public._msgr2_clamp('msgr2_limit_room_create_day', 200, 500));
  elsif new.archived_at is distinct from old.archived_at then
    perform public._msgr2_rate('room_archive', 'minute', public._msgr2_clamp('msgr2_limit_room_archive_min', 10, 30));
  end if;
  return coalesce(new, old);
end $$;

-- Storage 지우기: v2 경로(이 방의 파일)는 그 방을 지울 수 있는 사람(앱 기기)만. v2 경로가 아니면 거짓(허용 정책이 옛 경로를 열지 않게).
create or replace function public._msgr2_storage_delete(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name);
begin
  return rid is not null and public._msgr2_device_ok() and public._msgr2_device_app() and public._msgr2_room_deletable(rid, auth.uid());
end $$;
revoke all on function public._msgr2_storage_delete(text) from public, anon;
grant execute on function public._msgr2_storage_delete(text) to authenticated; -- 정책 식이 사용자 권한으로 부른다(_msgr2_storage_gate와 같다)
-- 제한 정책 판정: 본문은 20261020200300 그대로 + 'delete' 갈래
create or replace function public._msgr2_storage_gate(p_name text, p_op text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if public._msgr2_storage_room(p_name) is null then return true; end if;
  return case p_op when 'select' then public._msgr2_storage_read(p_name) when 'write' then public._msgr2_storage_write(p_name)
    when 'delete' then public._msgr2_storage_delete(p_name) else false end;
end $$;
-- 허용 정책: 옛 msgr_files_delete(조직 관리자)만 있어 1:1 참가자·개인 공간 방(p/…)은 지울 수 없었다. v2 경로에만 걸린다(옛 경로 판정은 그대로).
drop policy if exists msgr2_files_delete on storage.objects;
create policy msgr2_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'msgr' and public._msgr2_storage_delete(name));

-- ── F7. v2에서 직접 쓰기가 거부되던 화면 동작의 서버 함수(재공개 전 검수 F7, 총괄 결정 2026-10-23 "전부 결함으로 고친다") ─────────
-- 원인: 앱 v2 어댑터가 옛 표 쓰기(msgr_channels·msgr_org_members·msgr_messages update)를 v2 표 직접 쓰기로 보냈고, v2 표에는 고치기 권한이 없다(20261020200000~).
--   화면에서 보관·설정 저장·방 기억·내 표시 이름·내 글 고치기/지우기가 모두 permission denied로 끝났다(조사: 공유 노트 f7-v2-direct-writes.md).
-- 처방: 주인·권한을 확인하는 최소 정의자 RPC. 멤버 역할·내보내기는 이미 있는 msgr2_set_member_role·msgr2_space_member_remove를 앱이 부른다(서버 변경 없음).
--   권한(v1과 같거나 더 좁게):
--     방 보관·기억 켜기/끄기: 1:1 = 방에 있는 참가자, 그 밖 = 방 삭제와 같은 판정(관리 또는 만든 사람이면서 방에 있음 — _msgr2_room_deletable)
--     방 이름: 1:1이 아닌 방만, 같은 판정. 주제(topic)·채널 관리자·제외 목록은 v2에 없다(앱이 보내지 않는다)
--     내 표시 이름: 그 공간의 활동 멤버 본인 행만(1~40자, 빈 값 = 지움)
--     글 고치기: 내가 쓴 사람 글(text)이고 지워지지 않았고 그 방에 쓸 수 있을 때. 글 지우기: 내가 쓴 사람 글이고 그 방을 읽을 수 있을 때(v1 msgr_messages_update = 글쓴이만)
--   모두 앱 기기만(_msgr2_need_app). 값이 같으면 쓰지 않는다(쓰기 0). 보관 속도 제한은 기존 트리거(msgr2_rate_guard archived_at)가 그대로 센다.
-- 부하: 사용자가 누를 때만. 주기 작업 없음.

create or replace function public.msgr2_room_set(p_room uuid, p_name text default null, p_memory boolean default null, p_archive boolean default null) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); r public.msgr2_rooms; nm text := btrim(p_name); ok boolean; n int;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  if not found then return public._msgr2_rej('forbidden'); end if;
  ok := case when r.kind = 'direct'
             then exists (select 1 from public.msgr2_room_members m where m.room_id = r.id and m.member_kind = 'user' and m.member_id = uid and m.removed_at is null)
                  and coalesce((public._msgr2_access_for(r.id, uid)).read, false)
             else public._msgr2_room_deletable(r.id, uid) end;
  if not ok then return public._msgr2_rej('forbidden'); end if;
  if p_archive is not null and p_archive is distinct from true then return public._msgr2_rej('bad_request'); end if; -- 보관 되돌리기는 앱에 없다
  if p_name is not null and (r.kind = 'direct' or char_length(nm) not between 1 and 80) then return public._msgr2_rej('bad_request'); end if;
  if r.archived_at is not null and (p_name is not null or p_memory is not null) then return public._msgr2_rej('archived'); end if;
  update public.msgr2_rooms set name = coalesce(nm, name), memory = coalesce(p_memory, memory),
         archived_at = case when p_archive then coalesce(archived_at, now()) else archived_at end
   where id = r.id
     and (name, memory, archived_at is not null) is distinct from (coalesce(nm, name), coalesce(p_memory, memory), coalesce(p_archive, archived_at is not null));
  get diagnostics n = row_count;
  if n > 0 then
    perform public._msgr2_send_u(x, 'rooms', jsonb_build_object('space_id', r.space_id, 'room_id', r.id)) from public._msgr2_room_humans(r.id) x;
  end if;
  return jsonb_build_object('ok', true, 'changed', n > 0);
end $$;
revoke all on function public.msgr2_room_set(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.msgr2_room_set(uuid, text, boolean, boolean) to authenticated;

create or replace function public.msgr2_space_display_name_set(p_space uuid, p_name text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); nm text := nullif(btrim(coalesce(p_name, '')), ''); n int;
begin
  if nm is not null and char_length(nm) > 40 then return public._msgr2_rej('bad_request'); end if;
  if not exists (select 1 from public.msgr2_space_members m where m.space_id = p_space and m.user_id = uid and m.removed_at is null and (m.expires_at is null or m.expires_at > now())) then
    return public._msgr2_rej('forbidden'); end if;
  update public.msgr2_space_members set display_name = nm where space_id = p_space and user_id = uid and display_name is distinct from nm;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'changed', n > 0);
end $$;
revoke all on function public.msgr2_space_display_name_set(uuid, text) from public, anon;
grant execute on function public.msgr2_space_display_name_set(uuid, text) to authenticated;

create or replace function public.msgr2_message_edit(p_id bigint, p_body text) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); m public.msgr2_messages;
begin
  select * into m from public.msgr2_messages where id = p_id for update;
  if not found or m.author_kind <> 'user' or m.author_user_id is distinct from uid or m.kind <> 'text' or m.deleted_at is not null
     or not coalesce((public._msgr2_access_for(m.room_id, uid)).write, false) then return public._msgr2_rej('forbidden'); end if;
  if p_body is null or btrim(p_body) = '' then return public._msgr2_rej('bad_request'); end if;
  if p_body is distinct from m.body then
    update public.msgr2_messages set body = p_body, edited_at = now() where id = m.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.msgr2_message_edit(bigint, text) from public, anon;
grant execute on function public.msgr2_message_edit(bigint, text) to authenticated;

create or replace function public.msgr2_message_delete(p_id bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); m public.msgr2_messages;
begin
  select * into m from public.msgr2_messages where id = p_id for update;
  if not found or m.author_kind <> 'user' or m.author_user_id is distinct from uid
     or not coalesce((public._msgr2_access_for(m.room_id, uid)).read, false) then return public._msgr2_rej('forbidden'); end if;
  if m.deleted_at is null then
    update public.msgr2_messages set body = '', deleted_at = now() where id = m.id; -- 행은 남긴다(v1과 같다 — 지운 표시만)
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.msgr2_message_delete(bigint) from public, anon;
grant execute on function public.msgr2_message_delete(bigint) to authenticated;

-- ── S1·S3(재공개 전 검수 ① 보안, 우선순위 마지막) ──────────────────────────────────────────
-- S1 사람 채팅 켬: 친구가 내 회의방에 자기 에이전트를 넣고 내가 둘 다 멘션하면, 회의 일이 내 본체로 가고 posts에 친구 에이전트를 글쓴이로 보내도 통과했다.
--    처방 두 겹: 회의 대표는 글쓴이의 에이전트를 먼저 고르고(없으면 첫 참가자 — 종전), 참가자를 대표와 같은 주인의 에이전트로 거른다(_msgr2_user_offers, 본문은 20261020201500 그대로 + 네 줄),
--    msgr2_link_send work.result posts의 글쓴이가 이 본체 주인의 에이전트인지 본다(위 link_send 본문). 같은 주인의 회의는 종전대로.
-- S3 v2 팀에서 내보낸(또는 나간) 사람이 같은 id의 옛 조직 멤버 행(removed_at null)으로 옛 조직 문서(msgr_org_docs — v2도 쓰는 표)·옛 채널을 계속 읽었다.
--    처방: _msgr2_space_drop이 옛 멤버 행도 닫는다(본문은 20261020200600 그대로 + 세 줄). 옛 표가 없는 DB(v2만)에서는 건너뛴다.
--    손님 기한 끝(expires_at)은 시각으로 끝나 이 함수를 지나지 않는다 — 옛 판정도 expires_at을 보는지는 별도 확인(미룸).
-- 부하: 사람 글 1개당 회의 참가자 주인 비교(최대 5행), 공간에서 빠질 때 옛 행 1행 고치기.
create or replace function public._msgr2_user_offers(m public.msgr2_messages) returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[]; v_meeting boolean; parts uuid[]; k int := 0; w uuid;
begin
  if m.deleted_at is not null or m.author_kind <> 'user' then return 0; end if;
  select r.meeting into v_meeting from public.msgr2_rooms r where r.id = m.room_id;
  if coalesce(v_meeting, false) then
    select array_agg(q.member_id order by q.added_at, q.member_id) into parts from (
      select mm.member_id, mm.added_at from public.msgr2_room_members mm join public.msgr2_agents g on g.id = mm.member_id and g.status = 'active' and g.hosting = 'local'
       where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null
         and (cardinality(m.mentions) = 0 or mm.member_id = any (m.mentions))
       order by mm.added_at, mm.member_id limit public._msgr2_clamp('msgr2_meeting_agents', 5, 5)) q;
    if cardinality(parts) > 0 then -- S1: 대표는 글쓴이의 에이전트를 먼저(없으면 첫 참가자), 참가자는 대표와 같은 주인의 에이전트만 — 대표 주인의 본체가 남의 에이전트 이름으로 글을 쓰지 않게
      parts := array(select x from unnest(parts) with ordinality u(x, o)
                      order by (select g.owner_user_id from public.msgr2_agents g where g.id = x) is distinct from m.author_user_id, o);
      parts := array(select x from unnest(parts) with ordinality u(x, o)
                      where (select g.owner_user_id from public.msgr2_agents g where g.id = x) = (select g.owner_user_id from public.msgr2_agents g where g.id = parts[1]) order by o);
      w := public._msgr2_make_offer_x(m.room_id, m.topic_id, parts[1], 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0, parts);
      if w is not null then k := 1; end if;
    end if;
    return k;
  end if;
  if cardinality(m.mentions) > 0 then
    select array_agg(distinct mm.member_id) into targets from public.msgr2_room_members mm
      where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null and mm.member_id = any (m.mentions);
  elsif (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'user' and mm.removed_at is null and mm.member_id <> m.author_user_id) = 0
        and (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null) = 1 then
    select array_agg(mm.member_id) into targets from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null;
  end if;
  foreach ag in array coalesce(targets, '{}') loop
    w := public._msgr2_make_offer(m.room_id, m.topic_id, ag, 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0);
    if w is not null then k := k + 1; end if;
  end loop;
  return k;
end $$;

create or replace function public._msgr2_space_drop(p_space uuid, p_uid uuid) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare prev text;
begin
  update public.msgr2_space_members set removed_at = now() where space_id = p_space and user_id = p_uid and removed_at is null;
  if to_regclass('public.msgr_org_members') is not null then -- S3: 같은 id의 옛 조직 멤버 행도 닫는다(옛 문서·옛 채널 판정이 이 행을 본다)
    prev := current_setting('argo.msgr_account_delete', true);
    -- 스스로 나갈 때: 옛 보호 트리거(msgr_member_self_guard)가 본인에게 허용하는 전이는 이 표지가 있을 때 "본인 행 removed_at null → 값"뿐이다(msgr_delete_me와 같은 길).
    -- 이 한 줄 동안만 켜고 되돌린다. 역할·기한 바꾸기는 표지가 있어도 막힌다(그 트리거 첫 줄).
    perform set_config('argo.msgr_account_delete', '1', true);
    update public.msgr_org_members set removed_at = now() where org_id = p_space and user_id = p_uid and removed_at is null;
    perform set_config('argo.msgr_account_delete', coalesce(prev, ''), true);
  end if;
  perform public._msgr2_space_close(p_space, p_uid);
  perform public._msgr2_send_u(p_uid, 'spaces', jsonb_build_object('space_id', p_space, 'removed', true));
end $$;


-- ── I-1·자리 범위(재공개 전 검수 2차, 총괄 2026-10-23) ─────────────────────────────────────────
-- I-1 c절에서 _msgr2_bf_agents가 자리 없는 'bot-'+12자 행을 건너뛰자, msgr2_backfill_verify의 missing.agents가 그 행을 빠진 것으로 세어
--    런북(restart → run → verify)이 ok:false로 멈췄다(검수 PG 재현). verify의 agents 칸에 같은 조건을 넣는다. 본문은 20261020201500 그대로 + 그 한 줄.
-- 자리 범위: 파견 해제한(removed) 에이전트의 사용 범위를 바꾸면 msgr2_set_seat upsert가 removed_at = null로 되살려 조용히 다시 파견됐다.
--    범위만 바꾸는 함수 msgr2_seat_scope(에이전트, 공간, 범위, 명단)를 둔다: 활동 중인 자리만 고치고, 빠졌거나 없는 자리는 msgr2_seat_not_found.
--    새 앱(#1152)의 범위 저장은 이 함수를 쓰고, 앱은 파견 안 된 에이전트에는 범위 단추를 숨긴다(두 겹).
--    msgr2_set_seat은 바꾸지 않는다 — 이미 설치된 v2 앱은 그 함수로 다시 파견하고(되살림이 의도), 그 앱의 범위 저장은 원래 v2_unsupported로 실패했다.
create or replace function public.msgr2_backfill_verify(p_sample int default 200) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare miss jsonb; rooms_bad bigint; sample_bad bigint; ok boolean; oc jsonb;
begin
  if auth.uid() is not null then raise exception 'msgr2_backfill_service_only' using errcode = '42501'; end if;
  miss := jsonb_build_object(
    'agents', (select count(*) from public.msgr_agents a where not exists (select 1 from public.msgr2_agents v where v.id = a.id)
                 and not (a.slug ~ '^bot-[0-9a-f]{12}$' and not exists (select 1 from public.msgr_crews c where c.agent_id = a.id))), -- c: 백필이 건너뛰는 옛 봇은 빠진 것으로 세지 않는다(_msgr2_bf_agents와 같은 조건)
    'spaces_team', (select count(*) from public.msgr_orgs o where public._msgr2_org_in_msgr(o.id) and not exists (select 1 from public.msgr2_spaces s where s.id = o.id and s.kind = 'team')),
    'spaces_personal', (select count(*) from (select created_by u from public.msgr_channels where org_id is null union select user_id from public.msgr_org_members where public._msgr2_org_in_msgr(org_id)) x
                          where not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')),
    'space_members', (select count(*) from public.msgr_org_members m where public._msgr2_org_in_msgr(m.org_id) and not exists (select 1 from public.msgr2_space_members v
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


create or replace function public.msgr2_seat_scope(p_agent uuid, p_space uuid, p_allow text, p_users uuid[] default '{}') returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); cur public.msgr2_agent_seats; us uuid[];
begin
  if uid is null or not public._msgr2_device_ok() or not public._msgr2_device_app() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if;
  if p_allow not in ('all', 'list', 'owner') then raise exception 'msgr2_bad_allow' using errcode = '22023'; end if;
  if not exists (select 1 from public.msgr2_agents where id = p_agent and owner_user_id = uid)
     or not exists (select 1 from public.msgr2_spaces where id = p_space and kind = 'team' and deleted_at is null)
     or not exists (select 1 from public.msgr2_space_members where space_id = p_space and user_id = uid and role in ('owner', 'admin', 'member') and removed_at is null and (expires_at is null or expires_at > now())) then
    raise exception 'msgr2_forbidden' using errcode = '42501'; end if;
  select * into cur from public.msgr2_agent_seats where agent_id = p_agent and space_id = p_space for update;
  if cur.agent_id is null or cur.removed_at is not null then raise exception 'msgr2_seat_not_found' using errcode = 'P0002'; end if; -- 빠진 자리는 되살리지 않는다(파견은 msgr2_seat_ensure)
  us := case when p_allow = 'list' then coalesce((select array_agg(distinct u order by u) from unnest(coalesce(p_users, '{}')) u where u is not null), '{}') else '{}' end;
  if (cur.allow, cur.allow_users) is not distinct from (p_allow, us) then return 'kept'; end if;
  update public.msgr2_agent_seats set allow = p_allow, allow_users = us where agent_id = p_agent and space_id = p_space;
  return 'saved';
end $$;
revoke all on function public.msgr2_seat_scope(uuid, uuid, text, uuid[]) from public, anon;
grant execute on function public.msgr2_seat_scope(uuid, uuid, text, uuid[]) to authenticated;
