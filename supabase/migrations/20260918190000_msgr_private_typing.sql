-- 휘발 방송(typing·progress)도 비공개 방이면 조직 토픽이 아니라 그 방의 채널 토픽(dm:<채널>)으로 보낸다(20260918184500의 후속).
-- 조직 토픽(org:<조직>)은 조직 전원이 받는다 — 비공개 방의 typing·progress는 channel_id·crew_id(progress는 단계·시작 시각)를 실어
-- 비공개 방의 존재와 크루 활동이 조직 전원에게 샜다. dm:<채널>의 수신·발신 정책은 이미 msgr_can_read_channel(그 방을 읽을 수 있는 사람만 — 20260916150000).
-- 공개 채널은 지금처럼 org:. 봇 typing RPC 두 판(2인자·위임 4인자)과 노드 브리지(src/gateway/msgr.mjs startTyping)가 같은 규칙을 쓴다.
-- 호환: 새 앱은 열린 비공개 방의 dm:<채널>을 구독하고 org: typing도 계속 받는다(옛 서버에서도 동작). 옛 앱(0.1.28)은 적용 뒤 비공개 방의 '답변 중' 표시만 빠진다.

create or replace function public.msgr_room_topic(ch uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when c.kind = 'public' and c.org_id is not null then 'org:' || c.org_id::text else 'dm:' || c.id::text end
      from public.msgr_channels c where c.id = ch
$$;
revoke all on function public.msgr_room_topic(uuid) from public, anon, authenticated;

create or replace function public.msgr_bot_typing(token text, channel uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if not exists (select 1 from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
  if not public.msgr_crew_in_channel(channel, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  perform realtime.send(jsonb_build_object('channel_id', channel, 'crew_id', b.crew_id), 'typing', public.msgr_room_topic(channel), true);
end $$;

-- 위임 실행용 4인자 판(20260913122421) — 본문은 그대로, 토픽만 방 토픽으로
create or replace function public.msgr_bot_typing(token text,channel uuid,src_id bigint,attempt uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 if not exists(select 1 from msgr_channels where id=channel and org_id=b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
 if not msgr_crew_in_channel(channel,b.crew_id) and not exists(select 1 from msgr_executions e join msgr_messages s on s.id=e.source_msg_id
 where e.crew_id=b.crew_id and e.source_msg_id=src_id and e.attempt=$4 and e.state='running' and s.channel_id=channel and msgr_delivery_allowed(b.crew_id,s.id)) then raise exception 'msgr_bot_not_member'; end if;
 perform realtime.send(jsonb_build_object('channel_id',channel,'crew_id',b.crew_id),'typing',public.msgr_room_topic(channel),true);
end $$;
