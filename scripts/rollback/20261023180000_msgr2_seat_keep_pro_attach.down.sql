-- 되돌림: supabase/migrations/20261023180000_msgr2_seat_keep_pro_attach.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: msgr2_seat_ensure를 지우고, msgr2_attachment_add·_msgr2_storage_write를 직전 본문(20261020200200·20261020200800)으로 되돌린다. 표·행은 바꾸지 않았다.
-- 앱이 msgr2_seat_ensure를 쓰기 시작한 뒤라면 되돌림 뒤 방에 넣기가 함수 없음으로 실패한다 — 앱을 먼저 되돌리거나 함께 되돌린다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261023180000_msgr2_seat_keep_pro_attach.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr2_seat_ensure(uuid, uuid);
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

create or replace function public._msgr2_storage_write(p_name text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare rid uuid := public._msgr2_storage_room(p_name); dv record; full_path text := 'msgr/' || p_name;
begin
  if rid is null or auth.uid() is null or public._msgr2_paused() then return false; end if;
  if split_part(p_name, '/', 1) = 'p' then return false; end if; -- 옛 개인 방 파일은 읽기 전용(덮어쓰지 않는다)
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
revoke all on function public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;
commit;
