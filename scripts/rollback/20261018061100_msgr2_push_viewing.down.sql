-- 되돌림: supabase/migrations/20261018061100_msgr2_push_viewing.sql("보는 중" 판정·엣지 호출 시간 상한)을 20261018030000 정의로 되돌린다. 표는 만들지 않았다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 20261018030000을 되돌리기 전에 먼저 실행한다.
-- 엣지 msgr2-push도 같이 되돌릴 때는 3초 기다림이 없는 판(이 PR 이전 index.ts)을 배포한다 — 이 파일만 되돌려도 알림은 나간다(60초 판정으로 빠지는 사람이 늘 뿐).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018061100_msgr2_push_viewing.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
create or replace function public.msgr2_push_recipients(p_message bigint)
  returns table (user_id uuid, push_token text)
  language sql stable security definer set search_path = public, pg_temp as $$
  with m as (
    select g.id, g.room_id, g.author_user_id from public.msgr2_messages g
     where g.id = p_message and g.deleted_at is null and public._msgr2_push_target(g.kind, g.meta)
  ), rm as (
    select r.id, r.kind, s.id as space_id, s.kind as space_kind from m
      join public.msgr2_rooms r on r.id = m.room_id
      join public.msgr2_spaces s on s.id = r.space_id and s.deleted_at is null
  ), cand as (
    select mm.member_id as u from rm join public.msgr2_room_members mm on mm.room_id = rm.id and mm.member_kind = 'user' and mm.removed_at is null
    union
    select sm.user_id from rm join public.msgr2_space_members sm on sm.space_id = rm.space_id and sm.removed_at is null
     where rm.space_kind = 'team' and rm.kind = 'open'
  )
  select d.user_id, d.push_token
    from m cross join cand c
    join public.msgr2_devices d on d.user_id = c.u and d.kind = 'app' and d.push_token is not null
     and d.revoked_at is null and d.expires_at > now()
     and d.gen = coalesce((select ug.gen from public.msgr2_user_gen ug where ug.user_id = d.user_id), 0)
   where c.u is distinct from m.author_user_id
     and (public._msgr2_access_for(m.room_id, c.u)).read
     and not exists (select 1 from public.msgr2_prefs p where p.room_id = m.room_id and p.user_id = c.u and p.muted)
     and not exists (select 1 from public.msgr2_reads rd where rd.room_id = m.room_id and rd.user_id = c.u and rd.updated_at > now() - interval '60 seconds')
$$;
revoke all on function public.msgr2_push_recipients(bigint) from public, anon, authenticated;
grant execute on function public.msgr2_push_recipients(bigint) to service_role;
create or replace function public.msgr2_push_enqueue() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if new.deleted_at is not null or not public._msgr2_push_target(new.kind, new.meta) then return new; end if;
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return new; end if; -- 이전(U8) 백필: 옛 글 수백만 건에 알림을 보내지 않는다
  if public._msgr2_paused() then return new; end if;
  select value into url from public.msgr_settings where key = 'msgr2_push_url';
  if url is null or url = '' then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(), body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 5000);
  return new;
exception when others then return new;
end $$;
revoke all on function public.msgr2_push_enqueue() from public, anon, authenticated;
commit;
