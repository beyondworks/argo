-- 메시지 즉시성 — 렌더에 필요한 필드를 실은 방송을 채널 토픽으로 보낸다.
--
-- 왜 새 토픽인가: 기존 방송은 org:<조직> 토픽으로 나가고, 그 토픽의 수신 인가는
-- msgr_is_member(조직)이라 **조직 멤버 전원**이 받는다. 반면 채널 열람권은
-- msgr_can_read_channel(채널)이며 비공개 채널은 멤버만, 공개 채널도 excluded_user_ids를
-- 제외한다. 그래서 org: 토픽 payload에 본문을 실으면 비공개 채널과 조직 내 DM의 본문이
-- 조직 전원에게 전달된다. 본문은 열람권자만 있는 토픽으로만 내보낸다.
--
-- 왜 기존 방송을 그대로 두는가: org: 방송의 소비자가 앱 사이드바·안읽음·알림과
-- 브리지(src/gateway/msgr.mjs)다. 토픽을 옮기면 그들이 조용히 깨진다. 더하기만 한다.
-- 구버전 앱은 ch: 토픽을 구독하지 않으므로 지금과 똑같이 동작한다.

create or replace function public.msgr_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- ① 기존 여윈 방송 — 바꾸지 않는다(사이드바·안읽음·알림·브리지의 정본).
  perform realtime.send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id, 'crew_id', new.crew_id,
                       'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to),
    'message',
    case when new.org_id is null then 'dm:' || new.channel_id::text else 'org:' || new.org_id::text end,
    true);

  -- ② 렌더용 방송 — 채널 토픽. 받는 사람은 이 payload만으로 글을 그린다(조회 0회).
  --    본문이 실리므로 토픽 인가가 msgr_can_read_channel인 자리에만 보낸다.
  perform realtime.send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id,
                       'crew_id', new.crew_id, 'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to,
                       'body', new.body, 'created_at', new.created_at, 'meta', new.meta, 'client_msg_id', new.client_msg_id),
    'message',
    'ch:' || new.channel_id::text,
    true);
  return new;
end $$;

-- 토픽 인가 — ch:<채널>은 그 채널을 읽을 수 있는 사람만. org:·dm: 절은 그대로 둔다.
drop policy if exists msgr_realtime_recv on realtime.messages;
create policy msgr_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))
    or ((select realtime.topic()) like 'ch:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))));

drop policy if exists msgr_realtime_send on realtime.messages;
create policy msgr_realtime_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))
    or ((select realtime.topic()) like 'ch:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))));
