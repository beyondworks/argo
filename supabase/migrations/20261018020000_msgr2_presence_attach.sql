-- 메신저 v2 U6b — 접속 표시 토픽 권한(v2:pr:<주인>)과 첨부 표지 방송('attach'). 총괄 결정 2026-10-18(U6a 미룸 2건).
-- 의존: U1·U3·U2·U2b(*_msgr2_realtime_storage.sql — _msgr2_send_u·_msgr2_send_s·_msgr2_room_humans·_msgr2_setting_int). 병합된 앞 파일은 고치지 않는다.
-- 원칙
--   · 접속 표시(Realtime Presence, DB 행을 쓰지 않는다): 토픽 v2:pr:<주인 uid>(약속 v1 TOPICS.presence).
--     받기 = 유효한 기기이면서 ① 본인 ② 그 주인과 같은 팀 공간의 활동 멤버 ③ 그 주인의 에이전트가 있는 방을 읽을 수 있는 사람.
--     보내기(track) = 그 주인 본인의 runner·resident 기기만. 옛 토픽(pr:·u:·org:·dm:) 정책은 건드리지 않는다.
--   · 첨부 표지: 글 방송(msg)에는 첨부가 없다 — 사람 글의 첨부는 글을 넣은 뒤 msgr2_attachment_add로 붙고, 에이전트 결과의 첨부도 글 행 다음에 들어간다.
--     그래서 첨부 행이 생길 때 방의 사람에게 'attach' {attachment}를 보낸다(받는 쪽 요청 0). 받는 사람 집합·큰 open 방(v2:s:)·백필 우회는 글 방송과 같다.

-- ── 1. 접속 표시 토픽 권한 ──────────────────────────────────────────────────────
create or replace function public._msgr2_rt_presence_ok(p_topic text, p_op text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); owner uuid;
begin
  if uid is null or p_topic is null or p_topic !~* '^v2:pr:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  owner := split_part(p_topic, ':', 3)::uuid;
  if p_op = 'track' then
    return owner = uid and coalesce(public._msgr2_device_kind() in ('runner', 'resident'), false);
  end if;
  if not public._msgr2_device_ok() then return false; end if;
  if owner = uid then return true; end if;
  -- 같은 팀 공간의 활동 멤버(둘 다)
  if exists (select 1 from public.msgr2_space_members a join public.msgr2_space_members b on b.space_id = a.space_id
               join public.msgr2_spaces s on s.id = a.space_id and s.kind = 'team' and s.deleted_at is null
              where a.user_id = uid and b.user_id = owner
                and a.removed_at is null and (a.expires_at is null or a.expires_at > now())
                and b.removed_at is null and (b.expires_at is null or b.expires_at > now())) then
    return true;
  end if;
  -- 그 주인의 에이전트가 있는 방을 읽을 수 있다(개인 공간의 친구 방 등)
  return exists (select 1 from public.msgr2_room_members m join public.msgr2_agents ag on ag.id = m.member_id
                  where m.member_kind = 'agent' and m.removed_at is null and ag.owner_user_id = owner
                    and coalesce((public.msgr2_access(m.room_id)).read, false));
end $$;
revoke all on function public._msgr2_rt_presence_ok(text, text) from public, anon;
grant execute on function public._msgr2_rt_presence_ok(text, text) to authenticated;

drop policy if exists msgr2_presence_recv on realtime.messages;
create policy msgr2_presence_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'presence' and public._msgr2_rt_presence_ok((select realtime.topic()), 'recv'));
drop policy if exists msgr2_presence_track on realtime.messages;
create policy msgr2_presence_track on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'presence' and public._msgr2_rt_presence_ok((select realtime.topic()), 'track'));

-- ── 2. 첨부 표지 방송 ───────────────────────────────────────────────────────────
-- 방의 사람에게 한 가지 사건을 보낸다 — 글 방송(msgr2_on_message_broadcast)과 같은 받는 사람·같은 큰 방 규칙.
create or replace function public._msgr2_fanout(p_room uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select count(*) into n from public._msgr2_room_humans(p_room);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_setting_int('msgr2_fanout_max', 50) then
    perform public._msgr2_send_s(s.id, p_event, p_payload);
    for u in select h from public._msgr2_room_humans(p_room) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, p_event, p_payload);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(p_room) loop perform public._msgr2_send_u(u, p_event, p_payload); end loop;
  end if;
end $$;

create or replace function public.msgr2_on_attachment_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b text;
begin
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if; -- 이전 백필은 방송하지 않는다(글 방송과 같다)
  if position('/' in new.storage_path) < 2 then return null; end if;
  b := split_part(new.storage_path, '/', 1);
  perform public._msgr2_fanout(new.room_id, 'attach', jsonb_build_object('attachment', jsonb_build_object(
    'id', new.id, 'message_id', new.message_id, 'room_id', new.room_id, 'name', new.name, 'mime', new.mime, 'bytes', new.bytes,
    'bucket', b, 'path', substr(new.storage_path, char_length(b) + 2))));
  return null;
end $$;
drop trigger if exists msgr2_on_attachment_broadcast on public.msgr2_attachments;
create trigger msgr2_on_attachment_broadcast after insert on public.msgr2_attachments for each row execute function public.msgr2_on_attachment_broadcast();

revoke all on function public._msgr2_fanout(uuid, text, jsonb), public.msgr2_on_attachment_broadcast() from public, anon, authenticated;

-- ── 3. 일 카드가 읽는 열(U6 ②) ─────────────────────────────────────────────────
-- 카드는 일을 시킨 글 바로 아래에 그리고(source_message_id), 취소 단추는 지시한 사람·주인에게만 보인다(root_user_id). 넘김은 부모 일을 가리킨다(parent_work_id).
-- 행 읽기는 그대로 msgr2_works_select(그 방을 읽을 수 있을 때). 지시문(text)·리스 기기(lease_device)·세대는 열지 않는다.
grant select (source_message_id, root_user_id, parent_work_id) on public.msgr2_works to authenticated;

notify pgrst, 'reload schema';
