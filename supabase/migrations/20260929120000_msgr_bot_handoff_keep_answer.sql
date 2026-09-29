-- 봇 넘김 한도에 걸린 답을 버리지 않는다(유건 2026-09-29). 실사고: 페퍼 - v가 "헤르메스 에이전트 모두에게 전달" 지시에 9명을 멘션해
-- 넘기려다 msgr_bot_handoff_limit(409)로 답 전체가 거부되어 사장 화면에는 아무것도 뜨지 않았다(VPS 실패 보관함에만 남음).
-- ① 한도를 넘으면 멘션만 빼고 done으로 저장(meta.handoff_dropped·handoff_reason) ② 봇 소유자·조직 소유자/관리자가 직접 시킨 턴은
-- 조직 활성 에이전트 수까지 ③ 에이전트끼리의 넘김 5명·스레드 10홉 상한은 그대로. 나머지 본문은 20260927130000_msgr_bot_gates_merged.sql 그대로.
create or replace function public.msgr_bot_finish(token text, channel uuid, body text, src_id bigint, attempt uuid, disposition text, mentions jsonb default '[]') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; s public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint; origin_user uuid; hop int; target jsonb; dest uuid; cap int := 5; dropped int; reason text; n int; ch_kind text;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  s := public.msgr_bot_source(b.crew_id, src_id, channel);
  select * into e from public.msgr_executions where crew_id = b.crew_id and source_msg_id = src_id for update;
  if attempt is null or e.attempt is distinct from attempt then raise exception 'msgr_execution_not_owner'; end if;
  if e.state = 'completed' then return e.reply_id; end if;
  if not coalesce(public.msgr_org_entitled(b.org_id), true) then
    update public.msgr_executions set state = 'completed', heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
    return null; -- 미자격 — 실행 행을 닫아 running으로 남기지 않는다(M3). 호출부(core.js)가 null을 403 msgr_org_unentitled로 바꾼다(LOW).
  end if;
  if disposition not in ('handoff', 'done') or disposition is null or jsonb_typeof(mentions) <> 'array' or mentions is null then raise exception 'msgr_bot_bad_disposition'; end if;
  if body is null or length(trim(body)) = 0 or length(body) > 20000 then raise exception 'msgr_bot_bad_body'; end if;
  root_id := case when s.author_kind = 'user' then s.id else s.thread_root end;
  select author_user_id into origin_user from public.msgr_messages where id = root_id;
  select count(*) into hop from public.msgr_messages where thread_root = root_id and channel_id=channel and author_kind = 'crew' and kind = 'text' and id>coalesce(public.msgr_work_round_start(root_id,channel),0);
  if disposition = 'done' then mentions := '[]'; end if;
  -- 사람이 직접 시킨 턴(원문이 사람 글)이고 그 사람이 봇 소유자·조직 소유자/관리자면 조직의 활성 에이전트 수까지 넘길 수 있다(전체 공지).
  -- 에이전트끼리 넘길 때(원문이 크루 글)는 5명 그대로 — 서로 부르며 폭주하는 것을 막는 상한.
  -- 에이전트가 DM에서 넘기면 전달 트리거가 받는 쪽 1:1에 사람 글(meta.relay.via_crew_id)을 새로 만든다 — 이건 사람 지시가 아니다(검수 #752 HIGH-1).
  -- 채널은 스레드 10홉 상한이 받은 답까지 막으므로 확대 상한을 9명으로 둔다(넘김 1 + 답 9). DM 넘김은 각자의 1:1로 전달되어 그 상한이 없다(검수 MEDIUM-2).
  select kind into ch_kind from public.msgr_channels where id = channel;
  if s.author_kind = 'user' and coalesce(s.meta->'relay'->>'via_crew_id', '') = ''
     and (s.author_user_id = (select owner_user_id from public.msgr_crews where id = b.crew_id)
      or exists (select 1 from public.msgr_org_members m where m.org_id = b.org_id and m.user_id = s.author_user_id
                 and m.removed_at is null and (m.expires_at is null or m.expires_at > now()) and m.role in ('owner', 'admin'))) then
    cap := (select count(*)::int from public.msgr_crews where org_id = b.org_id and status = 'active' and id <> b.crew_id);
    cap := greatest(5, case when ch_kind = 'dm' and (select count(*) from public.msgr_channel_members where channel_id = channel and member_kind = 'crew') = 1
                            then cap else least(cap, 9 - hop) end); -- 같은 방에서 답하는 넘김(채널·크루 여럿인 그룹 대화)은 10홉 안(재검수 MEDIUM-2)
  end if;
  -- 중복을 없앤 배열로 바꾼 뒤 센다 — 같은 크루 반복으로 상한을 피하거나 큰 배열이 반복문·저장을 키우지 않게(검수 LOW-4, 재검수 MEDIUM-1: 2만 개 반복 12초)
  select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into mentions
    from (select distinct on (value->>'id') value as v, o from jsonb_array_elements(mentions) with ordinality e(value, o) order by value->>'id', o) d;
  n := jsonb_array_length(mentions);
  -- 한도를 넘어도 답은 버리지 않는다 — 전달(멘션)만 빼고 일반 답으로 저장해 사장이 답과 사유를 본다.
  -- 종전엔 예외로 답 전체가 사라져 10분 뒤 "결과 미도착" 안내만 떴다(2026-09-29 페퍼 - v, 멘션 9명 → 409).
  if disposition = 'handoff' and (hop >= 10 or n > cap) then
    dropped := n; reason := case when hop >= 10 then 'hop' else 'mentions' end;
    mentions := '[]'; disposition := 'done';
  end if;
  for target in select value from jsonb_array_elements(mentions) loop
    if target->>'kind' is distinct from 'crew' then raise exception 'msgr_not_allowed'; end if;
    begin dest := (target->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
    if dest is null or dest = b.crew_id or not exists (select 1 from public.msgr_crews c join public.msgr_channels ch on ch.id = channel
      where c.id = dest and c.org_id = b.org_id and c.status = 'active' and public.msgr_can_instruct(c.id, origin_user, channel)
      and public.msgr_can_instruct(c.id, (select owner_user_id from public.msgr_crews where id = b.crew_id), channel)
      and (ch.kind = 'dm' or public.msgr_crew_in_channel(channel, c.id))) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', src_id, root_id, 'reply:' || b.crew_id::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)
        || case when dropped is null then '{}'::jsonb else jsonb_build_object('handoff_dropped', dropped, 'handoff_reason', reason) end) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;

revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
