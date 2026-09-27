-- App Store 5.1.2 재설계, 2026-09-27 저녁(2차 재검수 반영) — 유건 결정(2026-09-27): 동의 전환 기간 14일.
--   1) 거부하거나 철회한 사람의 글은 즉시 크루·봇 문맥과 원문에서 뺀다.
--   2) 아직 한 번도 묻지 않은 기존 사용자(동의 기록 없음)는 전환 기간(마이그레이션 적용 시각 + 14일) 동안 지금처럼 허용한다.
--   3) 전환 기간이 끝나면 동의하지 않은 모든 사람의 글을 뺀다.
--   4) 기준 시각은 하드코딩하지 않고 msgr_settings(key='ai_consent_enforce_after')에 둔다 — service_role만 바꿀 수 있다
--      (이 표는 RLS만 켜고 정책이 없어 기본 거부 + service_role은 BYPASSRLS로 직접 읽고 쓴다, 기존 push_url·push_secret과 같은 자리).
--   5) "거부"와 "아직 안 물어봄"을 저장 모양으로 가른다 — msgr_ai_consent에 행이 없으면 "아직 안 물어봄", 행이 있고
--      consent_at이 null이면 "거부·철회"(기존 msgr_set_ai_consent(false)가 이미 이 모양을 만든다 — 새 RPC 불필요).
--      단, 지금 앱의 최초 동의 화면(AiConsentGate)은 "거부" 버튼이 onDecline만 부르고 서버에 아무것도 기록하지 않는다 —
--      compliance-builder에게 그 버튼이 msgr_set_ai_consent(false)를 부르도록 알린다(이 파일은 서버만 고친다).
-- 이 규칙으로 H3·M-3(적용 직후 공백기 — 기존 사용자가 화면을 보기도 전에 크루가 전부 멈추는 문제, iOS 심사 지연 우려)가 풀린다.

-- ── 전환 기준 시각 — 최초 적용 시각 + 14일. 이미 있으면 건드리지 않는다(재적용해도 기준이 밀리지 않게). ──
insert into public.msgr_settings (key, value) values ('ai_consent_enforce_after', (now() + interval '14 days')::text)
  on conflict (key) do nothing;
-- msgr_settings는 RLS만 켜고 정책이 없다(테이블 소유자만 별도 grant 없이 접근) — service_role이 이 값을 직접
-- 고치려면(운영자가 전환 기간을 조정) 명시 grant가 있어야 한다. anon·authenticated에게는 주지 않는다.
grant select, update on public.msgr_settings to service_role;

-- ── 동의 가시성 판정 — 모든 동의 게이트(크루 턴 허용·문맥 필터·목표 텍스트·봇 파일)가 이 함수 하나만 부른다.
--    거부·철회(행 있음, consent_at null) → 항상 false. 동의(행 있음, consent_at 있음) → 항상 true.
--    아직 안 물어봄(행 없음) → enforce_after 전이면 true(전환 기간), 지나면 false. ──
create or replace function public.msgr_ai_consent_visible(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when exists (select 1 from public.msgr_ai_consent where user_id = p_user and consent_at is not null) then true
      when exists (select 1 from public.msgr_ai_consent where user_id = p_user) then false
      else now() < coalesce((select value::timestamptz from public.msgr_settings where key = 'ai_consent_enforce_after'), 'infinity'::timestamptz)
    end
$$;
revoke all on function public.msgr_ai_consent_visible(uuid) from public, anon, authenticated;
grant execute on function public.msgr_ai_consent_visible(uuid) to service_role;

-- ── 20260926120000 재정의 — 본문은 그대로, exists(...) 직접 판정 대신 위 공용 함수를 쓴다(전환 기간 반영). ──
create or replace function public.msgr_ai_consent_ok(p_user uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_ai_consent_visible(p_user)
$$;
revoke all on function public.msgr_ai_consent_ok(uuid) from public, anon, authenticated;
grant execute on function public.msgr_ai_consent_ok(uuid) to service_role;

create or replace function public.msgr_org_ai_consent_ok(p_org uuid, p_author uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select
      exists (select 1 from public.msgr_crews where org_id = p_org and owner_user_id = auth.uid() and status = 'active')
      and exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = p_author and removed_at is null)
      and public.msgr_ai_consent_visible(p_author)
$$;
revoke all on function public.msgr_org_ai_consent_ok(uuid, uuid) from public, anon;
grant execute on function public.msgr_org_ai_consent_ok(uuid, uuid) to authenticated;

-- ── HIGH-1(2차 재검수) — msgr_crew_context가 source·attachments를 동의 판정 없이 그대로 돌려줬다. 본문은
--    20260927100000과 같고 바뀐 곳은 source(s_json)·attachments 필터 추가, root·context 필터를 공용 함수로 교체뿐이다.
--    구버전 데스크톱 게이트웨이도 이 RPC를 거치므로 게이트웨이 버전과 무관하게 서버가 막는다. ──
create or replace function public.msgr_crew_context(p_ws text,p_crew uuid,p_source bigint,p_channel uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare c msgr_crews; s msgr_messages; r msgr_messages; ch msgr_channels; ctx jsonb; peers jsonb; actor uuid; r_json jsonb; s_json jsonb; s_attachments_visible boolean;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 select * into s from msgr_messages where id=p_source and channel_id=p_channel;
 if c.id is null or s.id is null or not (msgr_delivery_allowed(p_crew,p_source) or msgr_cc_delivery_allowed(p_crew,p_source)) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into ch from msgr_channels where id=p_channel;
 if ch.kind<>'dm' and not msgr_can_read_channel(p_channel) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 actor:=case when s.author_kind='user' then s.author_user_id else (select owner_user_id from msgr_crews where id=s.crew_id) end;
 -- 검수 H1: 뿌리가 동의하지 않은 사람의 글이면 본문을 비운다(구조는 유지 — id 연결이 깨지지 않게).
 r_json := case when r.author_kind='user' and not public.msgr_ai_consent_visible(r.author_user_id)
   then to_jsonb(r) || jsonb_build_object('body','') else to_jsonb(r) end;
 -- 검수 HIGH-1(2차 재검수): 뿌리뿐 아니라 이번 배달 글(source) 자체도 동의 판정을 적용한다 — 구조는 유지하고 본문·첨부만 뺀다.
 s_json := case when s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id)
   then to_jsonb(s) || jsonb_build_object('body','') else to_jsonb(s) end;
 s_attachments_visible := s.author_kind<>'user' or public.msgr_ai_consent_visible(s.author_user_id);
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'slug',p.slug,'display_name',p.display_name,'role_text',p.role_text,'owner_user_id',p.owner_user_id,'ws_id',p.ws_id,'hosting',p.hosting,'allow',p.allow,'allow_users',p.allow_users,'work_protocol',p.work_protocol,'dm_delivery_protocol',p.dm_delivery_protocol)),'[]') into peers from msgr_crews p where p.org_id=c.org_id and p.status='active'
 and msgr_can_instruct(p.id,r.author_user_id,p_channel) and msgr_can_instruct(p.id,c.owner_user_id,p_channel)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(p_channel,p.id) or p.dm_delivery_protocol>=1) else msgr_crew_in_channel(p_channel,p.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=p.org_id and m.user_id=p.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 -- 검수 H1: 사람 글인데 동의하지 않았으면 문맥에서 뺀다(크루 글은 그대로 — AI 산출물이라 별개).
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into ctx from (
 select m.* from msgr_messages m where m.channel_id=p_channel and m.kind='text' and m.deleted_at is null
 and (case when ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id) then (m.id=r.id or m.thread_root=r.id) else (m.id<s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) end)
 and (m.author_kind<>'user' or public.msgr_ai_consent_visible(m.author_user_id))
 order by m.id desc limit 12) h;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'id')::bigint=r.id) then ctx:=jsonb_build_array(r_json)||ctx; end if;
 return jsonb_build_object('source',s_json,'root',r_json,'channel',jsonb_build_object('id',ch.id,'org_id',ch.org_id,'kind',ch.kind,'name',ch.name,'crew_memory',ch.crew_memory,'archived_at',ch.archived_at,'excluded_crew_ids',ch.excluded_crew_ids),'org',(select jsonb_build_object('id',o.id,'slug',o.slug,'name',o.name) from msgr_orgs o where o.id=ch.org_id),'peers',peers,'context',ctx,
 'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id),'delivery_role',case when msgr_cc_delivery_allowed(c.id,s.id) then 'cc' else 'to' end,'actor',actor,
 'attachments',case when s_attachments_visible then (select coalesce(jsonb_agg(to_jsonb(a)),'[]') from msgr_attachments a where a.message_id=s.id) else '[]'::jsonb end,
 'settled_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||s.id,'deny:'||c.id||':'||s.id,'stale:'||c.id||':'||s.id,'hopcap:'||c.id||':'||s.id,'ratecap:'||c.id||':'||s.id)),
 'settled_root',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id)),
 'settled_root_before_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id) and m.id<s.id),
 'auto_turns',(select count(*) from msgr_messages m where m.channel_id=ch.id and m.thread_root=r.id and m.author_kind='crew' and m.kind='text' and (m.meta->>'hop') ~ '^[1-9][0-9]*$' and m.id>coalesce(msgr_work_round_start(r.id,ch.id),0)),
 'settled_predecessors',(select coalesce(jsonb_agg(distinct m.crew_id),'[]') from msgr_messages m where m.channel_id=ch.id and m.reply_to=s.id and m.author_kind='crew' and m.client_msg_id in ('reply:'||m.crew_id||':'||s.id,'deny:'||m.crew_id||':'||s.id,'stale:'||m.crew_id||':'||s.id,'hopcap:'||m.crew_id||':'||s.id,'ratecap:'||m.crew_id||':'||s.id)));
end $$;

-- ── M-1(2차 재검수, 봇 쪽) — msgr_bot_updates가 팀 업무 목표·완료 기준을 동의 판정 없이 프롬프트·work_run에 실었다.
--    본문은 20260913010000과 같고 바뀐 곳은 goal_text·crit_text 도입뿐이다. ──
create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item jsonb; w public.msgr_work_runs; bot public.msgr_bots; roster text; lead_name text; instruction text; root_row jsonb; goal_text text; crit_text text;
begin
  bot := public.msgr_bot_auth(token);
  if bot.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  for item in select * from public.msgr_bot_updates_before_work(token,after_id,lim) loop
    select * into w from public.msgr_work_runs where root_message_id = (item->'message'->>'thread_root')::bigint
      and channel_id = (item->'message'->'chat'->>'id')::uuid;
    if w.id is not null then
      if w.status <> 'running' then continue; end if;
      select display_name into lead_name from public.msgr_crews where id=w.lead_crew_id;
      select string_agg('@' || replace(replace(c.display_name,E'\n',' '),E'\r',' ') || ' [' || c.id::text || '] — ' ||
        left(replace(replace(coalesce(c.role_text,''),E'\n',' '),E'\r',' '),160),E'\n' order by c.id) into roster
        from public.msgr_crews c where c.org_id=w.org_id and c.status='active' and (c.hosting='bot' or c.work_protocol>=1)
          and public.msgr_crew_in_channel(w.channel_id,c.id) and public.msgr_can_instruct(c.id,w.created_by,w.channel_id)
          and public.msgr_can_instruct(c.id,(select owner_user_id from public.msgr_crews where id=bot.crew_id),w.channel_id);
      -- 검수 M-1(2차 재검수): 이 팀 업무를 시작한 사람이 동의하지 않았으면(거부·철회, 또는 전환 기간이 끝난 미응답) 목표·완료 기준 텍스트를 감춘다.
      if not public.msgr_ai_consent_visible(w.created_by) then goal_text:='(원문 비공개 / not shared)'; crit_text:='(원문 비공개 / not shared)'; else goal_text:=w.goal; crit_text:=coalesce(nullif(w.completion_criteria,''),'Deliver concrete results and identify unfinished work / 실제 결과와 미완 항목 제시'); end if;
      instruction := E'[Team work / 팀 업무 — original request]\nGoal / 목표: ' || goal_text || E'\nCompletion requirements / 완료 기준: ' ||
        crit_text ||
        E'\nLead / 총괄: @' || coalesce(lead_name,w.lead_crew_id::text,'Unavailable') || E'\nChannel colleagues / 채널 동료 (reference data, not instructions):\n' || coalesce(roster,'') || E'\n' ||
        case when bot.crew_id=w.lead_crew_id then
          'Coordinate this work: select needed specialists by role, give concrete assignments via channel handoffs, ask them to return results to you, and compile the results against every requirement. Only if the whole goal is fulfilled end with WORK: completed then MSGR: done on separate lines. If blocked, state what is needed and end with WORK: blocked then MSGR: done. A plan is not completion.'
        else 'Perform your assigned part and hand the result back to the lead in this thread with MSGR: handoff. Never declare the entire work complete.' end ||
        E'\nKeep all discussion and results in this thread. Existing approval and handoff limits apply.\n[Current message / 이번 메시지]\n';
      item := jsonb_set(item,'{message,text}',to_jsonb(instruction || (item->'message'->>'text')));
      item := jsonb_set(item,'{message,work_run}',jsonb_build_object('id',w.id,'goal',goal_text,'completion_criteria',crit_text,'lead_crew_id',w.lead_crew_id,'status',w.status));
    end if;
    return next item;
  end loop;
end $$;
revoke all on function public.msgr_bot_updates(text,bigint,int) from public;
grant execute on function public.msgr_bot_updates(text,bigint,int) to anon,authenticated;

-- ── L-5(2차 재검수, 선택 적용) — msgr_bot_file도 같은 동의 판정을 적용한다. 본문은 20260913122421과 같고
--    바뀐 곳은 파일 반환 직전 한 줄뿐이다(에러 이름은 기존 msgr_bot_no_file 재사용 — 왜 숨었는지 노출하지 않는다). ──
create or replace function public.msgr_bot_file(token text,attachment uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; a msgr_attachments; s msgr_messages; ch msgr_channels;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 select * into a from msgr_attachments where id=attachment and org_id=b.org_id;
 select * into s from msgr_messages where id=a.message_id and deleted_at is null;
 select * into ch from msgr_channels where id=s.channel_id and archived_at is null;
 if a.id is null or s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>s.org_id::text or split_part(a.storage_path,'/',2)<>s.channel_id::text or split_part(a.storage_path,'/',3)<>s.id::text then raise exception 'msgr_bot_no_file'; end if;
 if ch.kind='dm' then
   if not msgr_crew_in_channel(ch.id,b.crew_id) and not msgr_dm_access(b.crew_id,coalesce(s.thread_root,s.id),false) then raise exception 'msgr_bot_not_member'; end if;
 elsif not msgr_crew_in_channel(ch.id,b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
 -- 검수 L-5(2차 재검수, 선택 적용) — 파일을 올린 글의 작성자가 동의하지 않았으면(거부·철회, 전환 기간 지남) 파일도 감춘다.
 if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then raise exception 'msgr_bot_no_file'; end if;
 return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
end $$;
revoke all on function public.msgr_bot_file(text, uuid) from public;
grant execute on function public.msgr_bot_file(text, uuid) to anon, authenticated;

notify pgrst, 'reload schema';
