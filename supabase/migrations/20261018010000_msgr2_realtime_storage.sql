-- 메신저 v2 U2b — 사람 쪽 실시간 표지(u:<uid>·s:<space>), Realtime 토픽 권한, Storage 버킷 msgr의 v2 경로 정책, 누적 표 보존 규칙.
-- 설계 2026-10-17 4절(방송), 6절 함정(누적 표·Storage), D15. 총괄 지시 2026-10-17(U2 미룸 5건 → U2b).
-- 의존: U1(*_msgr2_space.sql), U3(*_msgr2_device.sql — msgr2_devices·msgr2_user_gen·_msgr2_device_ok/_kind), U2(*_msgr2_work.sql).
-- 원칙
--   · 방송은 realtime.send(private) 한 곳(_msgr2_send_u·_msgr2_send_s)에서. 실패해도 글·기록은 남는다(앱은 재접속 때 msgr2_catch_up으로 따라잡는다).
--   · 글 1개 = 방의 사람 수만큼 u:<uid> 방송(본문 4KB 이하면 글째, 넘으면 id·room_id만). 사람이 50명을 넘는 팀 open 방은 s:<space> 한 번.
--     글을 고치거나 지우면 같은 id로 다시 보낸다(U5가 갱신으로 받는다).
--   · 토픽 권한(realtime.messages select 정책): u:<본인> = 유효한 기기, w:<본인> = runner·resident 기기, s:<공간> = 그 팀 공간의 owner·admin·member + 유효한 기기,
--     wk:<일> = 그 일의 방을 읽을 수 있는 사람. 보내기(insert) 정책은 두지 않는다 — 앱·본체는 받기만 하고 서버만 보낸다.
--   · Storage(버킷 msgr, 이름 = <공간>/<방>/…): 읽기 = 그 방을 읽을 수 있는 사람(msgr2_access) 또는 그 방에 진행 중인 일의 리스를 쥔 runner 기기.
--     쓰기·덮어쓰기 = msgr2_attachment_add(내 글)·msgr2_link_upload_slot(내 리스)이 만든 경로만. 지우기 정책 없음. storage.objects를 SQL로 지우지 않는다.
--     옛 메신저 정책(msgr_files_*)과 옛 용량 제한 정책(msgr_files_storage_limit, restrictive insert)은 그대로다 — 옛 정책은 이 경로에서 거짓이고, 용량 제한은 v2 업로드에도 걸린다.
--   · 보존(DB 위생 4): 끝난 일의 봉투 기록(msgr2_work_events)과 일 없는 agent.sync 기록은 30일 뒤 지운다. 일·승인·효과·글은 지우지 않는다(일 행은 글·토픽이 가리키고, 글은 기억 데이터).
-- 지우는 SQL은 보존 함수의 msgr2_work_events 하나뿐이다.

-- ── 1. 방송 보조 ────────────────────────────────────────────────────────────────
create or replace function public._msgr2_send_u(p_uid uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(p_payload, p_event, 'u:' || p_uid::text, true);
exception when others then null;
end $$;
create or replace function public._msgr2_send_s(p_space uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(p_payload, p_event, 's:' || p_space::text, true);
exception when others then null;
end $$;

-- 방의 사람(받을 사람) — msgr2_access가 read를 주는 사람과 같은 집합: 활동 중인 사람 방 멤버(팀이면 활동 중인 공간 멤버인 사람만) ∪ 팀 open 방의 owner·admin·member.
create or replace function public._msgr2_room_humans(p_room uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select m.member_id from public.msgr2_room_members m join public.msgr2_rooms r on r.id = m.room_id join public.msgr2_spaces s on s.id = r.space_id
   where m.room_id = p_room and m.member_kind = 'user' and m.removed_at is null and s.deleted_at is null
     and (s.kind = 'personal' or exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = m.member_id
                                          and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())))
  union
  select sm.user_id from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id join public.msgr2_space_members sm on sm.space_id = s.id
   where r.id = p_room and s.kind = 'team' and s.deleted_at is null and r.kind = 'open' and sm.role in ('owner', 'admin', 'member')
     and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())
$$;

-- 방송할 글 모양(catch_up 항목과 같은 열). 4KB를 넘으면 body·meta를 빼고 id·room_id 등 머리만(U5가 그 글 하나만 읽는다).
create or replace function public._msgr2_msg_payload(m public.msgr2_messages) returns jsonb
  language plpgsql stable set search_path = public, pg_temp as $$
declare j jsonb;
begin
  j := jsonb_build_object('id', m.id, 'room_id', m.room_id, 'topic_id', m.topic_id, 'author_kind', m.author_kind, 'author_user_id', m.author_user_id,
    'author_agent_id', m.author_agent_id, 'kind', m.kind, 'reply_to', m.reply_to, 'client_msg_id', m.client_msg_id, 'work_id', m.work_id,
    'created_at', m.created_at, 'edited_at', m.edited_at, 'deleted_at', m.deleted_at);
  if m.deleted_at is not null then return jsonb_build_object('message', j); end if;
  if octet_length((j || jsonb_build_object('body', m.body, 'meta', m.meta))::text) <= 4096 then
    j := j || jsonb_build_object('body', m.body, 'meta', m.meta);
  end if;
  return jsonb_build_object('message', j);
end $$;

-- ── 2. 글 방송(u:<uid> 'msg', 큰 open 방은 s:<space> 'msg') ─────────────────────
create or replace function public.msgr2_on_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid; p jsonb;
begin
  if tg_op = 'UPDATE' and (new.body, new.meta, new.edited_at, new.deleted_at) is not distinct from (old.body, old.meta, old.edited_at, old.deleted_at) then return null; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  p := public._msgr2_msg_payload(new);
  select count(*) into n from public._msgr2_room_humans(new.room_id);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_setting_int('msgr2_fanout_max', 50) then
    perform public._msgr2_send_s(s.id, 'msg', p);
  else
    for u in select * from public._msgr2_room_humans(new.room_id) loop perform public._msgr2_send_u(u, 'msg', p); end loop;
  end if;
  return null;
end $$;
drop trigger if exists msgr2_on_message_broadcast on public.msgr2_messages;
create trigger msgr2_on_message_broadcast after insert or update on public.msgr2_messages for each row execute function public.msgr2_on_message_broadcast();

-- ── 3. 중단·기기 폐기 방송 ──────────────────────────────────────────────────────
-- 중단 스위치(msgr_settings key msgr2_paused)가 켜지거나 꺼지면 유효한 앱 기기를 가진 사람마다 u:<uid> 'pause' {paused, since}.
create or replace function public.msgr2_on_pause_setting() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare u uuid; p jsonb;
begin
  if coalesce(new.key, old.key) <> 'msgr2_paused' then return null; end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return null; end if;
  p := case when tg_op = 'DELETE' or coalesce(new.value, '') = '' then jsonb_build_object('paused', false)
            else jsonb_build_object('paused', true, 'since', new.value) end;
  for u in select distinct d.user_id from public.msgr2_devices d
            where d.kind = 'app' and d.revoked_at is null and d.expires_at > now()
              and d.gen = coalesce((select g.gen from public.msgr2_user_gen g where g.user_id = d.user_id), 0) loop
    perform public._msgr2_send_u(u, 'pause', p);
  end loop;
  return null;
end $$;
do $$ begin
  if to_regclass('public.msgr_settings') is not null then
    drop trigger if exists msgr2_on_pause_setting on public.msgr_settings;
    create trigger msgr2_on_pause_setting after insert or update or delete on public.msgr_settings for each row execute function public.msgr2_on_pause_setting();
  end if;
end $$;

-- 사용자 세대를 올리면(모든 기기 무효) u:<uid> 'device_revoked' {all:true}. 기기 하나 폐기는 U3 msgr2_device_revoke가 {device_id}로 보낸다.
create or replace function public.msgr2_on_user_gen() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and new.gen is not distinct from old.gen then return null; end if;
  if tg_op = 'INSERT' and new.gen = 0 then return null; end if;
  perform public._msgr2_send_u(new.user_id, 'device_revoked', jsonb_build_object('all', true));
  return null;
end $$;
drop trigger if exists msgr2_on_user_gen on public.msgr2_user_gen;
create trigger msgr2_on_user_gen after insert or update on public.msgr2_user_gen for each row execute function public.msgr2_on_user_gen();

-- ── 4. Realtime 토픽 권한(받기만) ───────────────────────────────────────────────
create or replace function public._msgr2_rt_topic_ok(p_topic text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); k text; v_id uuid; w public.msgr2_works;
begin
  if uid is null or p_topic is null or p_topic !~ '^(u|w|s|wk):[0-9a-fA-F-]{36}$' then return false; end if;
  k := split_part(p_topic, ':', 1); v_id := split_part(p_topic, ':', 2)::uuid;
  if k = 'u' then return v_id = uid and public._msgr2_device_ok(); end if;
  if k = 'w' then return v_id = uid and coalesce(public._msgr2_device_kind() in ('runner', 'resident'), false); end if;
  if k = 's' then
    return public._msgr2_device_ok() and exists (select 1 from public.msgr2_spaces s join public.msgr2_space_members sm on sm.space_id = s.id
      where s.id = v_id and s.kind = 'team' and s.deleted_at is null and sm.user_id = uid and sm.role in ('owner', 'admin', 'member')
        and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now()));
  end if;
  select * into w from public.msgr2_works x where x.id = v_id;
  return found and coalesce((public.msgr2_access(w.room_id)).read, false);
end $$;
revoke all on function public._msgr2_rt_topic_ok(text) from public, anon;
grant execute on function public._msgr2_rt_topic_ok(text) to authenticated;
drop policy if exists msgr2_realtime_recv on realtime.messages;
create policy msgr2_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and public._msgr2_rt_topic_ok((select realtime.topic())));

-- ── 5. Storage 버킷 msgr의 v2 경로 ──────────────────────────────────────────────
-- 이름에서 (공간, 방)을 꺼내 그 방이 그 공간의 방인지까지 본다. 모양이 아니면 null(옛 메신저 경로 <조직>/<채널>/…는 방이 없어 거짓).
create or replace function public._msgr2_storage_room(p_name text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a text := split_part(coalesce(p_name, ''), '/', 1); b text := split_part(coalesce(p_name, ''), '/', 2); rid uuid;
begin
  if a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or b !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_name like '%..%' or p_name like '%//%' then return null; end if;
  select r.id into rid from public.msgr2_rooms r where r.id = b::uuid and r.space_id = a::uuid;
  return rid;
end $$;

-- 읽기: 그 방을 읽을 수 있는 사람, 또는 그 방에 진행 중인(리스가 살아 있는) 일의 리스를 쥔 runner·resident 기기(offer 첨부를 받는 본체).
create or replace function public._msgr2_storage_read(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record;
begin
  if rid is null or auth.uid() is null then return false; end if;
  if coalesce((public.msgr2_access(rid)).read, false) then return true; end if;
  select * into dv from public._msgr2_my_device();
  if dv.code is not null or dv.kind not in ('runner', 'resident') then return false; end if;
  return exists (select 1 from public.msgr2_works w where w.room_id = rid and w.owner_user_id = auth.uid() and w.lease_device = dv.id
                   and w.lease_until > now() and w.state in ('accepted', 'running', 'awaiting_approval'));
end $$;

-- 쓰기: 서버가 정한 경로만 — 내 사람 글의 첨부 행(msgr2_attachment_add) 또는 내 리스의 업로드 슬롯(msgr2_link_upload_slot).
create or replace function public._msgr2_storage_write(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record; full_path text := 'msgr/' || p_name;
begin
  if rid is null or auth.uid() is null or public._msgr2_paused() then return false; end if;
  if public._msgr2_device_ok() and coalesce((public.msgr2_access(rid)).write, false) and exists (
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
revoke all on function public._msgr2_storage_room(text), public._msgr2_storage_read(text), public._msgr2_storage_write(text) from public, anon;
grant execute on function public._msgr2_storage_read(text), public._msgr2_storage_write(text) to authenticated;

drop policy if exists msgr2_files_select on storage.objects;
create policy msgr2_files_select on storage.objects for select to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_read(name) else false end);
drop policy if exists msgr2_files_insert on storage.objects;
create policy msgr2_files_insert on storage.objects for insert to authenticated
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end);
-- 다시 올리기(upsert)는 같은 경로 덮어쓰기 — 같은 판정
drop policy if exists msgr2_files_update on storage.objects;
create policy msgr2_files_update on storage.objects for update to authenticated
  using (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end)
  with check (case when bucket_id = 'msgr' then public._msgr2_storage_write(name) else false end);

-- ── 6. 보존(DB 위생 4) ──────────────────────────────────────────────────────────
-- 끝난 일(done·failed·cancelled, 또는 기한이 지난 offered)의 봉투 기록과 일 없는 agent.sync 기록 중 30일 지난 것. 지울 행이 없으면 쓰기 0.
-- 진행 중인 일(stalled 포함)의 기록은 남긴다 — 늦은 결과·중복 판정에 쓴다.
create or replace function public.msgr2_retention_prune() returns integer
  language sql volatile security definer set search_path = public, pg_temp as $$
  with d as (
    delete from public.msgr2_work_events e
     where e.created_at < now() - interval '30 days'
       and (e.work_id is null or exists (select 1 from public.msgr2_works w where w.id = e.work_id
              and (w.state in ('done', 'failed', 'cancelled') or (w.state = 'offered' and w.expires_at < now() - interval '30 days'))))
    returning 1)
  select count(*)::int from d
$$;
revoke all on function public.msgr2_retention_prune() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr2-retention-prune', '23 3 * * *', $c$select public.msgr2_retention_prune()$c$);
  end if;
end $$;

-- ── 7. 실행 권한 ────────────────────────────────────────────────────────────────
revoke all on function public._msgr2_send_u(uuid, text, jsonb), public._msgr2_send_s(uuid, text, jsonb), public._msgr2_room_humans(uuid),
  public._msgr2_msg_payload(public.msgr2_messages), public.msgr2_on_message_broadcast(), public.msgr2_on_pause_setting(), public.msgr2_on_user_gen()
  from public, anon, authenticated;

notify pgrst, 'reload schema';
