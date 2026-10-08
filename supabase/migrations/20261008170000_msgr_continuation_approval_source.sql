-- 이어 실행 턴의 결재 카드(2026-10-08, PR #864 '남은 것'·경우 12) — 결재 후속·예약·긴 작업·루프 정지 턴이 올린 결재의 카드 출처는 원래 지시이고,
-- 그 지시의 실행은 이미 끝났다(msgr_executions.state = 'completed'). 출처 가드는 실행 중(running)이거나 승인된 부모 결재(payload.followup_of)만 받아
-- 카드가 msgr_approval_source_forbidden으로 거절되고 결재는 본체 로컬 결재함에만 남았다(조직 1:1·개인 crew 1:1·조직 채널 공통).
--
-- 계약(봇 선례 followup_of와 같은 방향): 이어 실행 턴은 카드에 근거를 싣고, 가드는 근거가 있을 때만 끝난 원래 글을 받는다.
--   본체(src/gateway/msgr.mjs msgrPush)가 싣는 근거 — payload.continuation = 'followup'|'routine'|'job'(호출자가 정한 이어 실행 종류),
--   결재 후속이면 payload.followup_of = 승인된 부모 결재 행 id(20260929150000_1b 갈래 그대로 — 이 파일 없이도 옛 가드가 받는다).
--   표지는 누구나 적을 수 있으므로(넣을 수 있는 사람은 크루 주인: 표 넣기 정책·개인 RPC) 받는 조건은 모두 서버 사실이다:
--   ① 방: 1b와 같은 원래 글 조건(있음·삭제 안 됨·같은 방·같은 조직·크루 조직 일치) — 남의 방·삭제된 글
--   ② 그 에이전트가 그 글을 실제로 실행해 끝냈다(msgr_executions (crew_id, source_msg_id) state = 'completed') — 아무 글이나 원래 글로 대는 위조
--   ③ 지금도 그 글을 이어서 할 수 있다(msgr_delivery_allowed — 이어 실행 턴 자신이 지나는 msgr_crew_context와 같은 판정: 크루 활성·방 보관 안 됨·
--      에이전트가 방에 있음·지시 권한·조직 멤버십/개인 방 사람) — 방에서 빠졌거나 보관됐거나 권한이 회수된 묵은 글
--   ④ 그 글에 근거로 들어온 대기 카드가 없다(같은 크루·같은 원래 글·pending·payload.continuation) — 예약·루프가 같은 글에 카드를 쌓지 않게.
--      원래 턴의 대기 카드(근거 없음)는 세지 않는다. 동시 넣기는 크루·글 단위 advisory lock으로 하나씩.
--      주의할 점: 근거 카드 하나가 서버에서 오래 pending이면(고위험이라 관리자 결정 대기 등) 같은 글의 다음 근거 카드는 모두 거절돼 로컬에만 남는다(PR '남은 것').
--   ⑤ 끝난 지 오래된 글: 그 실행이 끝난 지 31일 안일 때만(②의 msgr_executions.heartbeat_at — 완료 때 서버 함수만 now()로 적고, 사용자에게는 쓰기 권한이 없다).
--      31일은 정책 값이다(유건 확인 대상, PR '결정 필요'). 가장 긴 달 하나 — 결재 후속(결정까지 한 달)·긴 작업에는 넉넉하다.
--      비용: 메신저 글에서 건 예약·루프는 주기와 상관없이 그 글의 실행이 끝나고 31일 동안만 카드가 뜨고, 그 뒤 예약 카드는 배포본처럼 로컬 결재함에만 남는다.
--      다른 기준(그 에이전트가 그 글에 마지막으로 답한 시각·결재 행 시각)은 쓰지 않았다 — 크루 글은 크루 주인 세션이 아무 글에나 답으로 넣을 수 있고
--      (msgr_messages_insert 정책), 결재 행 created_at은 서버 시각으로 강제하는 트리거가 없다(넣는 쪽이 값을 정할 수 있다).
--   결재 후속의 시간 기준: 근거 표지 없는 행(봇·옛 본체 — followup_of만)은 1b의 '부모 결정 24시간' 창 그대로다. 새 본체의 결재 후속은 continuation='followup'도
--   같이 실으므로 1b가 24시간으로 거절해도 이 갈래(①~⑤)로 받는다 — 새 본체 결재 후속의 시간 기준은 '원래 실행 완료 31일'이다.
--
-- 기존 동작: 1b 정의(운영 prosrc md5 7bd34991748cc1165ed40a5e306c5d13 = 20260929150000_1b 283-315, 2026-10-08 읽기 전용 대조)를 그대로 옮기고,
--   1b가 거절하던 자리에서만 새 갈래를 본다 — 실행 중 카드·followup_of 카드·근거 없는 카드는 1b와 같은 결과다(옛 본체 + 새 DB = 배포본).
--   새 본체 + 옛 DB(이 파일 전): continuation은 무시되고 followup_of만 1b 갈래로 받는다 — 예약·긴 작업 카드는 지금처럼 거절(배포본과 같음).
--   트리거(a_msgr_approval_source_guard)는 그대로라 표 잠금이 없다(함수 본문만 교체).
-- DB 부하: 주기 호출·쓰기·새 표 없음. 본체 요청 수 그대로(근거는 같은 넣기 행에 실린다). 새 갈래는 1b가 거절할 행에서만 돈다 —
--   실행 기록 기본 키 1회 + msgr_delivery_allowed 1회(기본 키 조회 몇 번) + advisory lock + 대기 카드 조회 1회(crew_id 색인).
create or replace function public.msgr_approval_source_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare source public.msgr_messages; card public.msgr_messages; crew public.msgr_crews; parent_id uuid; cont text;
begin
  if tg_op = 'UPDATE' and old.source_msg_id is not null then
    if new.source_msg_id is null then return new; end if;
    if new.source_msg_id is distinct from old.source_msg_id then
      raise exception 'msgr_immutable_source_msg_id' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.source_msg_id is null and tg_op = 'UPDATE' and new.message_id is distinct from old.message_id and new.message_id is not null then
    select * into card from public.msgr_messages where id = new.message_id;
    if card.id is null or card.deleted_at is not null or card.kind <> 'approval_card' or card.channel_id is distinct from new.channel_id
       or card.crew_id is distinct from new.crew_id
       or not (card.mentions @> jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', new.id::text))) then
      raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
    end if;
    new.source_msg_id := card.reply_to;
  end if;
  if new.source_msg_id is null then return new; end if;
  select * into source from public.msgr_messages where id = new.source_msg_id;
  select * into crew from public.msgr_crews where id = new.crew_id;
  begin parent_id := nullif(new.payload->>'followup_of', '')::uuid; exception when others then parent_id := null; end;
  if source.id is null or source.deleted_at is not null or source.channel_id is distinct from new.channel_id
     or source.org_id is distinct from new.org_id or crew.org_id is distinct from new.org_id
     or not (exists (select 1 from public.msgr_executions e where e.crew_id = new.crew_id and e.source_msg_id = source.id and e.state = 'running')
       or (parent_id is not null and exists (select 1 from public.msgr_crew_approvals pa where pa.id = parent_id and pa.crew_id = new.crew_id
             and pa.source_msg_id = source.id and pa.status = 'approved' and pa.decided_at > now() - interval '24 hours'))) then
    -- 20261008170000: 1b가 거절하던 자리 — 이어 실행 근거(payload.continuation)가 있을 때만 끝난 원래 글을 받는다(머리 주석 ①~⑤)
    cont := case when jsonb_typeof(new.payload) = 'object' then new.payload->>'continuation' end;
    if source.id is null or source.deleted_at is not null or source.channel_id is distinct from new.channel_id
       or source.org_id is distinct from new.org_id or crew.org_id is distinct from new.org_id
       or cont is null or cont not in ('followup', 'routine', 'job')
       or not exists (select 1 from public.msgr_executions e where e.crew_id = new.crew_id and e.source_msg_id = source.id and e.state = 'completed'
                        and e.heartbeat_at > now() - interval '31 days') then -- ⑤ 끝난 지 31일 안
      raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
    end if;
    if not coalesce(public.msgr_delivery_allowed(new.crew_id, source.id), false) then
      raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('msgr-continuation-approval:' || new.crew_id || ':' || source.id));
    if exists (select 1 from public.msgr_crew_approvals pa where pa.crew_id = new.crew_id and pa.source_msg_id = source.id and pa.status = 'pending'
                 and pa.id is distinct from new.id and jsonb_typeof(pa.payload) = 'object' and pa.payload ? 'continuation') then
      raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.msgr_approval_source_guard() from public, anon, authenticated;
