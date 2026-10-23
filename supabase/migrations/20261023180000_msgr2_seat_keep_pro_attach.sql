-- 메신저 재공개 전 검수(2026-10-23, origin/main 2d3c9891) F1 서버·F4.
-- F1 에이전트 사용 범위 보존: 앱이 에이전트를 팀 방에 넣을 때마다 msgr2_set_seat(p_allow 'all')을 불러, 주인이 정한 범위('나만'·'지정한 사람')가
--    'all'로 덮어써졌다(팀 멤버 누구나 주인 PC·요금제로 일을 시킬 수 있게 됨, 0.1.63 대비 권한 회귀). 범위 판정(_msgr2_make_offer 등)은 그대로 맞다.
--    msgr2_seat_ensure(에이전트, 공간): 자리가 없으면 'all'로 만들고, 있으면 범위를 그대로 둔다(빠졌던 자리는 되살리되 범위는 보존).
--    검사는 msgr2_set_seat와 같다(앱 기기·내 에이전트·그 팀 공간의 손님 아닌 활동 멤버). 같은 값이면 쓰지 않는다(쓰기 0).
--    범위를 바꾸는 길은 종전대로 msgr2_set_seat(주인만, allow·users)이다 — 앱(사용 범위 시트)이 이것을 부르게 고친다(메신저 PR).
-- F4 Pro가 끝난 계정: Pro일 때 등록한 기기(기기 갱신은 Pro를 보지 않는다 — 갑자기 끊기지 않게)로 옛 글에 첨부를 계속 올릴 수 있었다.
--    msgr2_attachment_add와 _msgr2_storage_write의 사람 갈래에 _msgr2_pro_ok(auth.uid())를 더한다(관문 스위치 msgr2_pro_gate=off면 통과 — 종전 판정과 같음).
--    본문은 직전 정의(20261020200200·20261020200800) 그대로이고 그 한 줄만 다르다. 에이전트(본체 기기) 갈래·읽기는 바꾸지 않는다.
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
                    and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval'));
end $$;
revoke all on function public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;
