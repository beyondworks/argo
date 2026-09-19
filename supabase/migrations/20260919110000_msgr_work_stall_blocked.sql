-- D48: 팀 업무가 끝나도 "진행 중"에 고착되던 결함(정비사 원장 P-C11·P3-4).
-- 완료 판정은 총괄 에이전트의 WORK: completed|blocked 표지에만 달려 있었다 — 총괄이 표지 없이(또는 MSGR 판정 없이)
-- 넘김도 없이 답을 마치면 스레드에서 더 움직일 에이전트가 없는데 업무는 영원히 running이었다("프롬프트는 힌트, 코드가 보장").
-- 처방: 그런 답이 들어왔고 스레드에 아직 답하지 않은 에이전트 지시도 없으면(정지) blocked(도움 필요)로 바꾸고 이유를 남긴다.
-- completed로 올리지 않는다 — 계획·분담만의 답을 완료로 오인하지 않는다(기존 원칙). 사람은 "보완하여 계속"·"업무 취소"로 이어간다.
alter table public.msgr_crew_approvals add column if not exists source_msg_id bigint references public.msgr_messages(id) on delete cascade;
drop trigger if exists msgr_lock_approvals on public.msgr_crew_approvals;
create trigger msgr_lock_approvals before update on public.msgr_crew_approvals for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'created_at', 'risk', 'kind', 'payload', 'source_msg_id');

create or replace function public.msgr_work_result() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; verdict text; stalled boolean := false;
begin
  if new.author_kind <> 'crew' then return new; end if;
  select * into w from public.msgr_work_runs where root_message_id = coalesce(new.thread_root,(select coalesce(m.thread_root,m.id) from public.msgr_messages m where m.id=new.reply_to and m.channel_id=new.channel_id)) and channel_id = new.channel_id for update;
  if w.id is null or w.status <> 'running' or new.reply_to < coalesce(w.last_resume_message_id,0) then return new; end if;
  verdict := case when new.meta->>'failed' = 'true' or (new.kind='system' and (new.client_msg_id ~ '^(hopcap|ratecap|stale|deny|execution-unknown|unknown):' or new.meta->>'execution_status'='unknown')) then 'blocked'
    when new.crew_id = w.lead_crew_id and new.meta->>'disposition' = 'done' then new.meta->>'work_status' else null end;
  -- 정지 판정: 총괄의 글(넘김 판정 아님)인데 판정이 없고, 같은 스레드에 이 총괄이 올린 결재가 대기 중이지 않으며,
  -- 이번 라운드에 에이전트를 부른 글(이 답 자체의 멘션 포함 — AFTER 트리거) 중 그 에이전트의 실행이 끝나지 않은 것이 없다
  -- (이 답의 원문은 지금 끝나는 중이므로 제외). 결재나 동료 실행이 대기 중이면 종전처럼 running이고, 결재 결정 뒤 후속 답에서 다시 판정한다.
  if verdict is null and new.crew_id = w.lead_crew_id and new.kind = 'text'
     and coalesce(new.meta->>'disposition', 'done') <> 'handoff'
     and not exists (
       select 1 from public.msgr_crew_approvals a
       left join public.msgr_messages card on card.id = a.message_id
       left join public.msgr_messages approval_source on approval_source.id = a.source_msg_id
       where a.channel_id = w.channel_id and a.crew_id = new.crew_id and a.status = 'pending'
         and (
           (approval_source.deleted_at is null and approval_source.channel_id = w.channel_id
             and coalesce(approval_source.thread_root, approval_source.id) = w.root_message_id)
           or (a.source_msg_id is null and card.deleted_at is null and card.kind = 'approval_card'
             and card.crew_id = a.crew_id and coalesce(card.thread_root, card.id) = w.root_message_id
             and card.mentions @> jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', a.id::text)))
         )
     ) then
    stalled := not exists (
      select 1 from public.msgr_messages m
      cross join lateral jsonb_array_elements(case when jsonb_typeof(m.mentions) = 'array' then m.mentions else '[]'::jsonb end) x
      join public.msgr_crews target on target.id::text = x->>'id' and target.org_id = w.org_id and target.status = 'active'
      where m.channel_id = w.channel_id and (m.id = w.root_message_id or m.thread_root = w.root_message_id)
        and m.id >= coalesce(w.last_resume_message_id, 0) and m.deleted_at is null
        and x->>'kind' = 'crew'
        and coalesce(x->>'role', 'to') = 'to'
        and public.msgr_crew_in_channel(w.channel_id, target.id)
        and public.msgr_can_instruct(target.id, w.created_by, w.channel_id)
        and (m.crew_id = w.lead_crew_id or exists (
          select 1 from public.msgr_executions source where source.reply_id = m.id and source.crew_id = m.crew_id and source.state = 'completed'
        ))
        and not (m.id = new.reply_to and x->>'id' = new.crew_id::text)
        and not exists (select 1 from public.msgr_executions e where e.crew_id::text = x->>'id' and e.source_msg_id = m.id and e.state = 'completed'));
    if stalled then verdict := 'blocked'; end if;
  end if;
  if verdict in ('completed','blocked') then
    update public.msgr_work_runs set status = verdict,
      result = case when stalled then null else new.body end, -- 정지 이유는 앱이 사용자 언어로 그린다(blocked + result 없음 = 판정 없는 정지). 답 본문은 result_message_id로
      result_message_id = new.id, updated_at = now() where id = w.id;
  else update public.msgr_work_runs set updated_at = now() where id = w.id; end if;
  return new;
end $$;
