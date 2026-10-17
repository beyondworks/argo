-- 되돌림: supabase/migrations/20261018051000_msgr2_personal_files.sql(U8 후속 — 옛 개인 방 첨부 p/<방>/…를 v2 판정으로)을 걷어 낸다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 세 함수를 원래 본문으로 되돌린다: _msgr2_storage_room·_msgr2_storage_write(U2b 20261018010000), msgr2_insert_stamp(U1 20261017151000).
-- 데이터는 바꾸지 않는다. 되돌리면 'p/…' 객체는 다시 옛 정책에만 기댄다(v2 방 멤버가 못 연다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018051000_msgr2_personal_files.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
-- U2b 본문 그대로(시험이 원본 파일의 본문과 같은지 본다)
create or replace function public._msgr2_storage_room(p_name text) returns uuid
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare a text := split_part(coalesce(p_name, ''), '/', 1); b text := split_part(coalesce(p_name, ''), '/', 2); rid uuid;
begin
  if a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or b !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_name like '%..%' or p_name like '%//%' then return null; end if;
  select r.id into rid from public.msgr2_rooms r where r.id = b::uuid and r.space_id = a::uuid;
  return rid;
end $$;

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

-- U1 본문 그대로
create or replace function public.msgr2_insert_stamp() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then return new; end if;
  if tg_table_name = 'msgr2_messages' then
    new.created_at := now();
  elsif tg_table_name = 'msgr2_attachments' then
    new.created_at := now();
    if new.storage_path not like 'msgr/' || (select r.space_id::text from public.msgr2_rooms r where r.id = new.room_id) || '/' || new.room_id::text || '/%'
       or new.storage_path like '%..%' or new.storage_path like '%//%' then
      raise exception 'msgr2_attachment_path' using errcode = '42501'; end if;
  end if;
  return new;
end $$;

revoke all on function public._msgr2_storage_room(text), public._msgr2_storage_write(text) from public, anon, authenticated;
grant execute on function public._msgr2_storage_write(text) to authenticated;
revoke execute on function public.msgr2_insert_stamp() from public, anon, authenticated;
commit;
