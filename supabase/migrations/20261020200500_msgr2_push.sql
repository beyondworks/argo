-- 메신저 v2 휴대폰 알림(U7, 설계 2026-10-17 4절·5절·8절 U7). 폰이 뒤로 가면 소켓을 닫고 푸시로 받는다.
-- 글 insert → 트리거(msgr2_push_enqueue) → pg_net → 엣지 함수 msgr2-push(supabase/functions/msgr2-push). 옛 msgr_push_*·msgr-push는 건드리지 않는다.
-- 받는 사람(msgr2_push_recipients): 그 방을 읽을 수 있는 사람(_msgr2_access_for(room, uid).read — 판정은 U1·U2 한 곳) 가운데
--   본인 아님 · 그 방을 음소거하지 않음(msgr2_prefs.muted) · 지금 그 방을 보고 있지 않음(아래 근사) · 앱 기기 행(kind 'app', 폐기·만료·세대 지남 아님)에 push_token이 있음.
--   "앱이 앞에 있지 않은 사람"의 근사: v2에는 접속 표시 표가 없다(D7 Presence는 Realtime 메모리). 대신 최근 60초 안에 그 방의 읽음(msgr2_reads.updated_at)이
--   갱신된 사람은 그 방을 보고 있는 것으로 보고 뺀다(읽음은 사람이 방을 볼 때 값이 바뀌면만 쓴다 — 쓰기 추가 0). 앱이 앞에 있지만 다른 방을 보는 사람에게는 간다
--   (앱이 전경 알림을 그린다 — 지금 메신저와 같다). 기억 안 남김 방도 알림은 보낸다(저장이 아니다).
-- 대상 글: 사람·에이전트의 text 글과 승인 요청 카드(meta.code 'approval.request'). 시스템 글·진행 카드·지운 글은 보내지 않는다.
-- 보내지 않는 때(트리거): 대상 글이 아닐 때, 이전(U8) 백필 중(서비스 문맥 + msgr2.backfill = on — U2b 방송 규칙과 같다), v2 중단 스위치(msgr2_paused), 주소 설정 없음.
-- 멱등: 엣지가 msgr2_push_sent(message_id 기본 키)를 먼저 잡는다 — 같은 글에 두 번 보내지 않는다(재생·위조 호출 포함). 보존: msgr2_push_sent 7일, pg_net 응답 1일(하루 1번 정리).
-- 키 값(APNs .p8·FCM 서비스 계정)은 엣지 시크릿에만 있다 — 이름: APNS_KEY_P8·APNS_KEY_ID·APNS_TEAM_ID·APNS_TOPIC·APNS_SANDBOX·FCM_SERVICE_ACCOUNT·PUSH_FN_SECRET.
-- 주소: msgr_settings 'msgr2_push_url'(엣지 배포 뒤 맥 one이 넣는다). 인증 헤더는 옛 msgr_push_headers()(push_secret) 그대로.
-- 되돌림: scripts/rollback/20261018030000_msgr2_push.down.sql

-- 같은 글에 한 번 — 엣지가 먼저 넣는다(경합·재생 방지). 결과 요약(sent·failed)은 끝날 때 갱신한다.
create table if not exists public.msgr2_push_sent (
  message_id bigint primary key,
  claimed_at timestamptz not null default now(),
  tokens int,
  sent int,
  failed int,
  finished_at timestamptz
);
alter table public.msgr2_push_sent enable row level security;
revoke all on public.msgr2_push_sent from public, anon, authenticated;
grant select, insert, update on public.msgr2_push_sent to service_role;

create or replace function public._msgr2_push_target(p_kind text, p_meta jsonb) returns boolean
  language sql immutable as $$ select p_kind = 'text' or (p_kind = 'card' and coalesce(p_meta->>'code', '') = 'approval.request') $$;

-- 받는 사람과 그 기기 토큰. service_role(엣지)만 부른다 — 토큰이 다른 사람에게 보이지 않게.
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

-- 글 insert → 엣지 호출 한 번({message_id}). 트리거는 대상 글·백필·중단 스위치·주소만 본다 — 받는 사람 판정은 엣지에서 한 번만 한다(받을 사람이 없으면 엣지가 0건으로 끝낸다).
-- 받는 사람을 여기서 계산하면 글 넣기가 방 크기만큼 느려진다(검수 실측 800명 open 방: 1.95ms → 173ms). 푸시 실패가 글 저장을 막지 않는다.
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
drop trigger if exists msgr2_push_after_insert on public.msgr2_messages;
create trigger msgr2_push_after_insert after insert on public.msgr2_messages for each row execute function public.msgr2_push_enqueue();

-- 보존(DB 위생 4): 알림 장부 7일, pg_net 응답 1일. 하루 1번(pg_cron이 있을 때). pg_net 자체 ttl(기본 6시간)이 먼저 지우면 두 번째 줄은 지울 것이 없다.
create or replace function public.msgr2_push_prune() returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.msgr2_push_sent where claimed_at < now() - interval '7 days';
  -- pg_net 응답 정리는 따로 — 라이브에서 net 표 삭제 권한이 없어도 위 장부 정리까지 롤백되지 않게 한다(pg_net 자체 ttl이 남은 몫을 지운다)
  begin
    if to_regclass('net._http_response') is not null then
      execute 'delete from net._http_response where created < now() - interval ''1 day''';
    end if;
  exception when others then null;
  end;
end $$;
revoke all on function public.msgr2_push_prune() from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr2-push-prune', '53 3 * * *', $c$select public.msgr2_push_prune()$c$);
  end if;
end $$;
