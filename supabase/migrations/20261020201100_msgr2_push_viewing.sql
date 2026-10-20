-- 메신저 v2 휴대폰 알림 "보는 중" 판정을 바꾼다(U7 후속, 총괄 배정 2026-10-18). 정의만 바꾼다 — 표·열·주기 호출을 더하지 않는다.
-- 고치는 결함: 20261018030000의 "최근 60초 안에 그 방 읽음(msgr2_reads.updated_at)이 갱신됐으면 보는 중"은, 방을 읽고 곧바로 폰을 잠근 사람에게
--   그 뒤 60초 동안 오는 글의 알림을 전부 뺐다. 읽음은 값이 커질 때만 쓰므로(msgr2_mark_read) 보는 동안 주기적으로 갱신되지도 않는다.
-- 새 판정: 받는 사람이 "이 글"을 읽음으로 올렸고(last_read_id >= 글 id), 그 갱신이 글이 생긴 뒤(updated_at >= 글 created_at)면 보는 중이다.
--   앱은 방이 화면에 보이고 초점이 있을 때 새 글이 그려지면 바로 읽음을 올린다(apps/messenger/src/App.jsx Channel의 mark — 지연·묶음 없음).
--   엣지(msgr2-push)는 글이 생긴 뒤 3초(VIEW_WAIT_MS)까지 기다린 다음 이 함수를 부른다 → 3초 안에 읽음이 올라오지 않은 사람은 보는 중이 아니다.
--   created_at 조건: 이전(U8) 백필은 옛 읽음 시각을 그대로 넣는다(서비스 문맥) — 옛 id가 새 글 id 이상이어도 글보다 먼저 찍힌 갱신은 보는 중으로 치지 않는다.
--   mark_read는 그 방의 마지막 글 id를 넘지 않게 쓰므로 last_read_id >= 글 id인 사람 갱신은 그 글이 있은 뒤에만 생긴다(같은 DB 시계).
-- 트리거의 엣지 호출 시간 상한 5초 → 20초: 엣지가 3초 기다리고 재시도(1초 → 3초)까지 하면 5초를 넘는다. 호출 수는 그대로(글당 1번).
-- 되돌림: scripts/rollback/20261018061100_msgr2_push_viewing.down.sql(20261018030000 정의로)

create or replace function public.msgr2_push_recipients(p_message bigint)
  returns table (user_id uuid, push_token text)
  language sql stable security definer set search_path = public, pg_temp as $$
  with m as (
    select g.id, g.room_id, g.author_user_id, g.created_at from public.msgr2_messages g
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
     and not exists (select 1 from public.msgr2_reads rd where rd.room_id = m.room_id and rd.user_id = c.u
                      and rd.last_read_id >= m.id and rd.updated_at >= m.created_at)
$$;
revoke all on function public.msgr2_push_recipients(bigint) from public, anon, authenticated;
grant execute on function public.msgr2_push_recipients(bigint) to service_role;

-- 20261018030000 정의에서 timeout_milliseconds만 5000 → 20000
create or replace function public.msgr2_push_enqueue() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if new.deleted_at is not null or not public._msgr2_push_target(new.kind, new.meta) then return new; end if;
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return new; end if; -- 이전(U8) 백필: 옛 글 수백만 건에 알림을 보내지 않는다
  if public._msgr2_paused() then return new; end if;
  select value into url from public.msgr_settings where key = 'msgr2_push_url';
  if url is null or url = '' then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(), body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 20000);
  return new;
exception when others then return new;
end $$;
revoke all on function public.msgr2_push_enqueue() from public, anon, authenticated;
