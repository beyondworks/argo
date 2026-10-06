-- 메신저 결정 두 가지(유건 승인 2026-10-06). 20261006160000_msgr_security_fixes.sql(#846) 다음에 적용한다.
-- 시그니처·security definer·search_path·권한(grant)은 바꾸지 않는다(create or replace·alter policy는 기존 권한을 유지한다).
-- 시험: test/msgr-group-delete-report-pg.test.mjs (이 파일 적용 전 재현 → 적용 뒤 동작, 정상 경로 유지)
-- 부하: 주기 작업·새 표·새 쓰기 없음. 판정 쿼리만 늘어난다(아래 각 절의 "부하").

-- ── 1. 조직 그룹 대화는 만든 사람(지금 참여 중)과 조직 관리자만 삭제한다 ─────────────────────────
-- 원인: 삭제 정책 msgr_channels_delete가 관리 판정 msgr_can_manage_channel을 그대로 썼고, 그 판정의 1:1(dm) 갈래는 "방에 있는 참여자 누구나"다.
--   조직 그룹 대화도 kind='dm'이라 참여자 누구나 방을 지웠고, 글·구성원·첨부 행이 FK cascade로 함께 사라져 모두의 대화가 없어졌다.
-- 그룹 대화 판정: kind='dm' and org_id is not null and 사람 참여 행 3개 이상(앱 src/room-delete.mjs와 같은 기준). 에이전트 행은 세지 않는다 —
--   사람 둘 + 에이전트는 두 사람의 대화라 1:1 규칙 그대로. 개인 1:1(personal_pair)은 사람 둘로 잠겨 있고,
--   개인 그룹(org_id null)은 이미 관리 판정에서 만든 사람만이다(20260917190000) — 둘 다 이 조건에 걸리지 않는다.
-- 처방: 관리 판정은 그대로 두고(이름 바꾸기·보관은 이번 결정 밖), 삭제 정책만 새 판정 msgr_can_delete_channel로 바꾼다.
--   조직 그룹 대화에서는 관리 판정에 더해 "만든 사람이면서 지금 참여 중" 또는 조직 관리자(owner·admin = msgr_is_admin)여야 한다.
--   채널 관리자(admin_user_ids)는 이 갈래에서 삭제하지 못한다(결정: 만든 사람과 조직 관리자만). 조직 관리자도 대화방 밖에서는 못 지운다 —
--   관리 판정의 dm 갈래가 참여를 요구한다(종전과 같음, 앱 ChannelSheet canManage와 같은 규칙).
--   만든 사람이 나간 뒤에는 조직 관리자(참여 중)만 지운다. 조직 그룹은 나갈 때 created_by를 넘기지 않는다(msgr_leave_dm은 개인 그룹만 넘긴다).
-- 소비자: 채널 행 삭제는 이 정책 하나다(앱 deleteChannel의 PostgREST delete). 정의자 함수 msgr_delete_me는 개인 채널(org_id null)만 지우고 RLS를 거치지 않는다.
-- 부하: 조직 dm 행 삭제 때만 사람 참여 행 count 1회(msgr_channel_members 기본 키 앞부분 channel_id 범위). 다른 채널은 kind·org_id 비교에서 끝난다.
create or replace function public.msgr_can_delete_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_can_manage_channel(ch)
       and not exists (select 1 from public.msgr_channels c
                        where c.id = ch and c.kind = 'dm' and c.org_id is not null
                          and (select count(*) from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user') >= 3
                          and not ((c.created_by = auth.uid()
                                    and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()))
                                   or coalesce(public.msgr_is_admin(c.org_id), false)))
$$;
revoke all on function public.msgr_can_delete_channel(uuid) from public, anon;
grant execute on function public.msgr_can_delete_channel(uuid) to authenticated;

-- 정책 출처: 20260911150000_msgr_channel_manage.sql(유일한 정의 — using (public.msgr_can_manage_channel(id))). 판정 함수만 바꾼다.
alter policy msgr_channels_delete on public.msgr_channels
  using (public.msgr_can_delete_channel(id));

-- 1-b. 같은 결과의 다른 길 — 남의 참여 행 지우기(분리 검수 자동 표시 반박 중 확인). 참여 행 delete 정책의 사람 갈래가 관리 판정을 써서
--   조직 그룹 대화의 일반 참여자도 다른 사람을 PostgREST로 빼낼 수 있었다 → 사람이 둘만 남으면 1:1 규칙으로 방을 지웠다(그룹 삭제 우회).
--   남을 빼는 판정을 삭제 판정과 같게 둔다. 자기 행(나가기)과 에이전트 갈래는 그대로. 조직 그룹이 아닌 방은 msgr_can_delete_channel = 관리 판정이라 종전과 같다.
--   앱은 대화방에서 사람 내보내기를 보이지 않는다(ChannelSheet canKick = canEdit && kind !== 'dm') — 앱 동작은 바뀌지 않는다.
-- 정책 출처: 20261002120000_msgr_crew_remove_owner_only.sql(마지막) — 사람 갈래의 판정 함수 이름만 바꾼다.
-- 부하: 남의 사람 행 delete 때만 판정 1회(위 함수와 같다).
alter policy msgr_channel_members_delete on public.msgr_channel_members
  using ((member_kind = 'user' and (member_id = (select auth.uid()) or public.msgr_can_delete_channel(channel_id)))
      or (member_kind = 'crew' and public.msgr_crew_removable(channel_id, member_id)));

-- 1-c. 같은 결과의 옆 길 — 참여 행 고치기(update). 같은 표의 update 정책도 관리 판정이라, 조직 그룹 대화의 일반 참여자가 남의 행의
--   member_id를 방 밖 사람으로 바꿔 그 사람을 빼낼 수 있었다(1-b와 같은 결과 — 빠진 사람은 대화를 못 본다). using·with check 모두 삭제 판정으로.
--   앱의 참여 행 upsert(ChannelSheet 사람 추가·공개 채널 되돌리기)는 채널(dm 아님)에서만 쓰여 판정이 같다. 대화방의 에이전트 추가는 msgr_crew_join(정의자).
-- 정책 출처: 20260918150000_msgr_crew_room_members.sql(마지막) — 판정 함수 이름만 바꾼다.
alter policy msgr_channel_members_update on public.msgr_channel_members
  using (public.msgr_can_delete_channel(channel_id))
  with check (public.msgr_can_delete_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id) and added_by = (select auth.uid()));

-- ── 2. 신고 제외는 진짜 시스템 글(author_kind='system')만 ────────────────────────────────────
-- 원인: #846의 조건 (kind = 'system' and author_kind <> 'user')가 에이전트(author_kind='crew') 명의 system 글도 신고 대상에서 뺐다.
--   사람이 자기 에이전트 명의로 "관리자 공지: 재로그인 링크" 같은 안내 글을 써도 신고할 수 없었다.
-- 처방: author_kind = 'system'인 글만 뺀다. 에이전트 글은 kind(text·system·approval_card)와 상관없이 신고된다. 사람 글은 종전대로(자기 글은 msgr_report_own).
-- 신고 처리 쪽: msgr_reports_list·msgr_report_resolve·msgr_report_notify·엣지 msgr-push는 kind를 보지 않는다(body_snapshot·author_crew_id만 싣는다) —
--   에이전트 text 글 신고와 같은 행 모양이다.
-- 정의 출처: 20261006160000_msgr_security_fixes.sql(마지막) — 조건 한 줄만 바꾼다.
create or replace function public.msgr_report_message(msg bigint, reason text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); m public.msgr_messages; rid uuid;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into m from public.msgr_messages where id = msg;
  -- 읽을 수 없는 글과 없는 글은 같은 오류(검수 L1: 존재 여부를 드러내지 않는다)
  if m.id is null or not public.msgr_can_read_channel(m.channel_id) or m.deleted_at is not null or m.author_kind = 'system' then
    raise exception 'msgr_report_no_message' using errcode = '22023';
  end if;
  if m.author_kind = 'user' and m.author_user_id = me then
    raise exception 'msgr_report_own' using errcode = '42501';
  end if;
  select id into rid from public.msgr_reports where message_id = m.id and reporter_user_id = me and status = 'open';
  if rid is not null then return rid; end if; -- 같은 글 반복 신고는 하나로(검수 L2)
  insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id, author_user_id, author_crew_id, body_snapshot, reason)
    values (m.id, m.channel_id, m.org_id, me, m.author_user_id, m.crew_id, left(m.body, 1000), nullif(left(btrim(coalesce(reason, '')), 500), ''))
    returning id into rid;
  return rid;
end $$;

-- ── 3. 에이전트 답 저장(msgr_execution_finish)은 전달 표지를 싣지 않는다 ─────────────────────────
-- 원인(#846 재검수): 정의자 함수가 p_reply.meta를 그대로 insert해 RLS 정책(#846 3·3-c)을 거치지 않았다. 에이전트 주인이
--   msgr_execution_claim → msgr_execution_finish(p_reply.meta={"relay":{...}})로 공개·비공개 채널의 에이전트 글에 전달 표지를 넣었다
--   (1:1(dm)은 b_msgr_dm_message_guard가 먼저 지운다).
-- 처방: 저장 전에 전달 표지 키 다섯 개만 뺀다. 다른 키(hop·origin·guest·office·disposition·work_status 등)·검사·시그니처·정의자·권한은 그대로.
--   게이트웨이(src/gateway/msgr.mjs msgrReply.meta, msgr-execution.mjs)는 이 키를 보내지 않는다 — 정상 답은 바뀌지 않는다.
--   같은 모양의 다른 길: msgr_post_thread_followup은 kind='dm' 방에만 쓰여 dm guard가 지우고, msgr_bot_finish·msgr_bot_send는 meta를 서버에서 만든다.
-- 정의 출처: 20260909120000_msgr_execution_claims.sql(유일한 정의) — insert의 meta 식 하나만 바꾼다.
-- 부하: 답 저장마다 jsonb 키 빼기 1회(메모리 안 계산, 쿼리 없음).
create or replace function public.msgr_execution_finish(p_ws text, p_crew uuid, p_source bigint, p_channel uuid, p_attempt uuid, p_reply jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare src public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint;
begin
  src := public.msgr_execution_source(p_ws, p_crew, p_source, p_channel);
  select * into e from public.msgr_executions where crew_id = p_crew and source_msg_id = p_source for update;
  if e.attempt is null or e.attempt is distinct from p_attempt then raise exception 'msgr_execution_not_owner' using errcode = '42501'; end if;
  if e.state = 'completed' then return jsonb_build_object('id', e.reply_id); end if;
  root_id := coalesce(src.thread_root, src.id);
  if p_reply->>'channel_id' is distinct from p_channel::text or p_reply->>'crew_id' is distinct from p_crew::text
     or p_reply->>'author_kind' is distinct from 'crew' or p_reply->>'kind' is distinct from 'text'
     or p_reply->>'client_msg_id' is distinct from ('reply:' || p_crew::text || ':' || p_source::text)
     or p_reply->>'reply_to' is distinct from p_source::text or p_reply->>'thread_root' is distinct from root_id::text then
    raise exception 'msgr_execution_reply_mismatch' using errcode = '42501';
  end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values (p_channel, 'crew', p_crew, 'text', p_source, root_id, 'reply:' || p_crew::text || ':' || p_source::text,
      p_reply->>'body', coalesce(p_reply->'mentions', '[]'::jsonb),
      case when jsonb_typeof(p_reply->'meta') = 'object' -- 전달 표지는 서버 트리거만 쓴다(#846 3). 객체가 아닌 meta는 종전 그대로(키가 없다)
           then (p_reply->'meta') - array['relay', 'relay_to', 'relay_capped', 'relay_cycle', 'relay_chain_id']
           else coalesce(p_reply->'meta', '{}'::jsonb) end)
    on conflict do nothing returning id into rid;
  if rid is null then
    select id into rid from public.msgr_messages where channel_id = p_channel and author_kind = 'crew' and crew_id = p_crew
      and client_msg_id = 'reply:' || p_crew::text || ':' || p_source::text;
  end if;
  if rid is null then raise exception 'msgr_execution_reply_not_saved'; end if;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now()
    where crew_id = p_crew and source_msg_id = p_source;
  return jsonb_build_object('id', rid);
end $$;

notify pgrst, 'reload schema';
