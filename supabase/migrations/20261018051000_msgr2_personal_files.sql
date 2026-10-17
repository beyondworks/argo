-- 메신저 v2 U8 후속 — 옛 개인 방 첨부(버킷 msgr의 p/<채널>/<글>/<파일>)를 이전된 개인 방(같은 id)의 v2 판정으로 읽는다(총괄 지시, 2026-10-18; 설계 6절 "파일은 옮기지 않는다").
-- 문제: 백필은 옛 개인 첨부를 storage_path 'msgr/p/<채널>/…'로 옮긴다. 그런데 v2 Storage 판정 _msgr2_storage_room(U2b)은 '<공간>/<방>/…' 모양만 v2 방으로 보므로,
--   'p/<방>/…'은 v2 정책으로 열리지 않고 옛 정책(옛 채널 멤버십 + 옛 판정)에만 기댄다 — 옛 표가 동결된 뒤 v2 사람(v2 방 멤버)이 열 길이 없다.
-- 바꾼 것
--   1) _msgr2_storage_room: 'p/<방 id>/…'도 그 방이 개인 공간의 방이면 v2 방으로 본다(그 밖은 U2b 본문 그대로).
--      → v2 읽기 = 그 방을 읽는 사람(msgr2_access, 기기 확인 포함). 문지기(restrictive) 정책도 v2 판정을 따른다. 옛 정리 후보(msgr_storage_sweep_list)에서도 빠진다.
--   2) _msgr2_storage_write: 'p/…' 경로는 쓰지 않는다(옛 파일 덮어쓰기 금지 — 읽기 전용). 그 밖은 U2b 본문 그대로. v2 새 첨부는 늘 'msgr/<공간>/<방>/…'(업로드 슬롯·msgr2_attachment_add).
--   3) msgr2_insert_stamp(U1 :345 경로 검사): 사람 문맥에서도 'msgr/p/<방 id>/…'를 그 방이 개인 공간의 방일 때 허용한다(서비스 문맥 백필은 원래 검사를 건너뛴다).
--      사람이 첨부 행을 직접 넣는 권한은 없으므로(U1 권한) 이 칸은 서버 함수가 옮긴 경로를 다시 쓸 때만 쓰인다.
-- 영향: 'p/…' 객체는 이 파일 뒤로 그 개인 방이 v2에 있을 때만 v2 판정이 적용된다(백필 전에는 방이 없어 옛 정책 그대로). 옛 앱은 중단 상태라 읽기 경로가 바뀌어도 쓰는 사람이 없다.
-- 시험: test/msgr2-backfill-pg.test.mjs "개인 방 첨부" · 되돌림 scripts/rollback/20261018051000_msgr2_personal_files.down.sql

create or replace function public._msgr2_storage_room(p_name text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a text := split_part(coalesce(p_name, ''), '/', 1); b text := split_part(coalesce(p_name, ''), '/', 2); rid uuid;
begin
  if p_name like '%..%' or p_name like '%//%' then return null; end if;
  -- 옛 개인 방 첨부: p/<방>/… — 그 방이 개인 공간의 방일 때만(이전된 개인 방, 같은 id)
  if a = 'p' and b ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select r.id into rid from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id where r.id = b::uuid and s.kind = 'personal';
    return rid;
  end if;
  if a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or b !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  select r.id into rid from public.msgr2_rooms r where r.id = b::uuid and r.space_id = a::uuid;
  return rid;
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

create or replace function public.msgr2_insert_stamp() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'msgr2_messages' then
    new.created_at := now();
  elsif tg_table_name = 'msgr2_attachments' then
    new.created_at := now();
    if (new.storage_path not like 'msgr/' || (select r.space_id::text from public.msgr2_rooms r where r.id = new.room_id) || '/' || new.room_id::text || '/%'
        and not (new.storage_path like 'msgr/p/' || new.room_id::text || '/%'
                 and exists (select 1 from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id where r.id = new.room_id and s.kind = 'personal')))
       or new.storage_path like '%..%' or new.storage_path like '%//%' then
      raise exception 'msgr2_attachment_path' using errcode = '42501'; end if;
  end if;
  return new;
end $$;

revoke all on function public._msgr2_storage_room(text), public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;
revoke execute on function public.msgr2_insert_stamp() from public, anon, authenticated;
