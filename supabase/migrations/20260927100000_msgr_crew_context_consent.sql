-- App Store 5.1.2 재설계(2026-09-27, 검수 H1) — 크루에게 넘기는 채널 문맥(msgr_crew_context)과 원문에서
-- 동의하지 않은 사람의 글을 뺀다. 크루 턴 자체는 멈추지 않는다(그건 게이트웨이가 org 단위로 판정 — msgr_org_ai_consent_ok).
-- 본문은 20260913122421 정의와 같고 바뀐 곳은 ctx 필터 한 줄과 r_json/그 사용 두 자리뿐(라이브 대조 편의를 위해 나머지는 그대로 둔다).
create or replace function public.msgr_crew_context(p_ws text,p_crew uuid,p_source bigint,p_channel uuid) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare c msgr_crews; s msgr_messages; r msgr_messages; ch msgr_channels; ctx jsonb; peers jsonb; actor uuid; r_json jsonb;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 select * into s from msgr_messages where id=p_source and channel_id=p_channel;
 if c.id is null or s.id is null or not (msgr_delivery_allowed(p_crew,p_source) or msgr_cc_delivery_allowed(p_crew,p_source)) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into ch from msgr_channels where id=p_channel;
 if ch.kind<>'dm' and not msgr_can_read_channel(p_channel) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 actor:=case when s.author_kind='user' then s.author_user_id else (select owner_user_id from msgr_crews where id=s.crew_id) end;
 -- 검수 H1: 뿌리가 동의하지 않은 사람의 글이면 본문을 비운다(구조는 유지 — id 연결이 깨지지 않게).
 r_json := case when r.author_kind='user' and not exists(select 1 from msgr_ai_consent ac where ac.user_id=r.author_user_id and ac.consent_at is not null)
   then to_jsonb(r) || jsonb_build_object('body','') else to_jsonb(r) end;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'slug',p.slug,'display_name',p.display_name,'role_text',p.role_text,'owner_user_id',p.owner_user_id,'ws_id',p.ws_id,'hosting',p.hosting,'allow',p.allow,'allow_users',p.allow_users,'work_protocol',p.work_protocol,'dm_delivery_protocol',p.dm_delivery_protocol)),'[]') into peers from msgr_crews p where p.org_id=c.org_id and p.status='active'
 and msgr_can_instruct(p.id,r.author_user_id,p_channel) and msgr_can_instruct(p.id,c.owner_user_id,p_channel)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(p_channel,p.id) or p.dm_delivery_protocol>=1) else msgr_crew_in_channel(p_channel,p.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=p.org_id and m.user_id=p.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 -- 검수 H1: 사람 글인데 동의하지 않았으면 문맥에서 뺀다(크루 글은 그대로 — AI 산출물이라 별개).
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into ctx from (
 select m.* from msgr_messages m where m.channel_id=p_channel and m.kind='text' and m.deleted_at is null
 and (case when ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id) then (m.id=r.id or m.thread_root=r.id) else (m.id<s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) end)
 and (m.author_kind<>'user' or exists(select 1 from msgr_ai_consent ac where ac.user_id=m.author_user_id and ac.consent_at is not null))
 order by m.id desc limit 12) h;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'id')::bigint=r.id) then ctx:=jsonb_build_array(r_json)||ctx; end if;
 return jsonb_build_object('source',to_jsonb(s),'root',r_json,'channel',jsonb_build_object('id',ch.id,'org_id',ch.org_id,'kind',ch.kind,'name',ch.name,'crew_memory',ch.crew_memory,'archived_at',ch.archived_at,'excluded_crew_ids',ch.excluded_crew_ids),'org',(select jsonb_build_object('id',o.id,'slug',o.slug,'name',o.name) from msgr_orgs o where o.id=ch.org_id),'peers',peers,'context',ctx,
 'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id),'delivery_role',case when msgr_cc_delivery_allowed(c.id,s.id) then 'cc' else 'to' end,'actor',actor,
 'attachments',(select coalesce(jsonb_agg(to_jsonb(a)),'[]') from msgr_attachments a where a.message_id=s.id),
 'settled_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||s.id,'deny:'||c.id||':'||s.id,'stale:'||c.id||':'||s.id,'hopcap:'||c.id||':'||s.id,'ratecap:'||c.id||':'||s.id)),
 'settled_root',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id)),
 'settled_root_before_source',exists(select 1 from msgr_messages m where m.channel_id=ch.id and m.crew_id=c.id and m.client_msg_id in ('reply:'||c.id||':'||r.id,'deny:'||c.id||':'||r.id,'stale:'||c.id||':'||r.id,'hopcap:'||c.id||':'||r.id,'ratecap:'||c.id||':'||r.id) and m.id<s.id),
 'auto_turns',(select count(*) from msgr_messages m where m.channel_id=ch.id and m.thread_root=r.id and m.author_kind='crew' and m.kind='text' and (m.meta->>'hop') ~ '^[1-9][0-9]*$' and m.id>coalesce(msgr_work_round_start(r.id,ch.id),0)),
 'settled_predecessors',(select coalesce(jsonb_agg(distinct m.crew_id),'[]') from msgr_messages m where m.channel_id=ch.id and m.reply_to=s.id and m.author_kind='crew' and m.client_msg_id in ('reply:'||m.crew_id||':'||s.id,'deny:'||m.crew_id||':'||s.id,'stale:'||m.crew_id||':'||s.id,'hopcap:'||m.crew_id||':'||s.id,'ratecap:'||m.crew_id||':'||s.id)));
end $$;
