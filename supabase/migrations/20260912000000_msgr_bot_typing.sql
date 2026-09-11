-- 봇(외부 에이전트) 타이핑 방송 — 유건 제보 2026-09-11 밤: VPS 크루(헤르메스 봇)에게 지시하면 '답변 중' 표시가 없다.
-- 노드 크루는 realtime 브로드캐스트 'typing'을 직접 보내지만 봇 API에는 그 경로가 없었다. 봇은 이 RPC를 2초마다 부르고(헤르메스 _keep_typing),
-- 서버가 조직 토픽(org:<id>)으로 같은 모양의 payload를 방송한다. 앱은 6초 안에 갱신되지 않으면 표시를 지운다.
-- 범위 판정은 글 삽입과 같은 규칙(msgr_crew_in_channel — 20260911230000): 초대되지 않았거나 내보낸 채널에서는 타이핑도 못 보낸다.
create or replace function public.msgr_bot_typing(token text, channel uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if not exists (select 1 from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
  if not public.msgr_crew_in_channel(channel, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  perform realtime.send(jsonb_build_object('channel_id', channel, 'crew_id', b.crew_id), 'typing', 'org:' || b.org_id, true);
end $$;
revoke all on function public.msgr_bot_typing(text, uuid) from public;
grant execute on function public.msgr_bot_typing(text, uuid) to anon, authenticated;
notify pgrst, 'reload schema';
