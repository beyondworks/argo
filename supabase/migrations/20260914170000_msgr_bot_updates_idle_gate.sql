-- 봇 getUpdates 유휴 게이트 — 엣지 함수 롱폴은 봇마다 1초에 한 번 이 함수를 부른다(supabase/functions/msgr-bot/core.js POLL_MS).
-- 라이브 실측(2026-09-14, pg_stat_statements 60초 델타): 이 RPC가 분당 297회·회당 평균 1.2초로 전체 SQL 시간의 96%.
-- 원인: 봇에게 오지 않은 글은 update가 안 돼 커서가 안 넘어가고, 매초 커서 뒤 글 전부를 권한 함수로 재평가(84건 = 294ms+).
-- 처방: 배달 판정 입력의 지문(조직 최대 글 id·DM 위임·실행 클레임·채널 멤버십·프로토콜)을 msgr_bots에 기록하고,
--       지문이 같고 30초 이내면 전체 스캔을 건너뛴다. 새 글·멤버십·클레임 변화는 지문이 바뀌어 즉시 스캔한다.
-- 본문은 20260913122421_msgr_dm_thread_delegation.sql의 msgr_bot_updates_before_work를 그대로 두고 첫머리 게이트만 더한 것.
alter table public.msgr_bots add column if not exists scan_key text, add column if not exists scan_at timestamptz;

create or replace function public.msgr_bot_updates_before_work(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $function$
declare b msgr_bots; s msgr_messages; r msgr_messages; a uuid; won uuid; peers jsonb; ctx jsonb; n int:=0; lo bigint; actor uuid; ch msgr_channels; key text; cur bigint;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 -- 유휴 게이트(2026-09-14 라이브 실측: 봇 11개가 매초 커서 뒤 글 84건을 권한 함수로 재평가 → CPU 96%·회당 0.9초).
 -- 배달 판정에 들어오는 상태의 지문이 지난 전체 스캔과 같고 30초가 안 지났고 ack(after_id)도 새것이 아니면 빈 결과로 즉시 끝낸다.
 -- 지문 밖의 변화(멤버 만료·잠금·심박 10분 경과 등)는 최대 30초 늦게 반영된다 — 그 안에 반드시 전체 스캔이 한 번 돈다.
 select cursor_msg_id into cur from msgr_crews where id=b.crew_id;
 key:=(select coalesce(max(id),0) from msgr_messages where org_id=b.org_id)||':'||(select count(*) from msgr_dm_grants where crew_id=b.crew_id)
   ||':'||(select count(*) from msgr_executions where crew_id=b.crew_id)||':'||(select count(*) from msgr_channel_members where member_kind='crew' and member_id=b.crew_id)
   ||':'||coalesce(current_setting('argo.msgr_delivery_protocol',true),'');
 if b.scan_key=key and b.scan_at>now()-interval '30 seconds' and coalesce(after_id,0)<=coalesce(cur,0) then return; end if;
 update msgr_bots set last_seen_at=now(),scan_key=key,scan_at=now() where id=b.id;
 update msgr_crews set last_seen_at=now(),cursor_msg_id=greatest(cursor_msg_id,coalesce(after_id,0)) where id=b.crew_id returning cursor_msg_id into lo;
 for s in select m.* from msgr_executions e join msgr_messages m on m.id=e.source_msg_id
 where e.crew_id=b.crew_id and e.state='running' and e.heartbeat_at<now()-interval '10 minutes' and msgr_delivery_allowed(b.crew_id,m.id)
 and not exists(select 1 from msgr_messages x where x.channel_id=m.channel_id and x.client_msg_id='unknown:'||b.crew_id||':'||m.id) loop
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,meta)
 values(s.channel_id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),'unknown:'||b.crew_id||':'||s.id,'외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. / The external agent has not returned a result. Check its status.','{"execution_status":"unknown","disposition":"done"}') on conflict do nothing;
 end loop;
 for s in select m.* from msgr_messages m where m.org_id=b.org_id and (m.id>lo or (current_setting('argo.msgr_delivery_protocol',true)='1' and exists(select 1 from msgr_dm_grants g where g.source_message_id=m.id and g.crew_id=b.crew_id and g.role='to')))
 and (current_setting('argo.msgr_delivery_protocol',true)='1' or not exists(select 1 from msgr_channels d where d.id=m.channel_id and d.kind='dm' and not msgr_crew_in_channel(d.id,b.crew_id)))
 and (msgr_delivery_allowed(b.crew_id,m.id) or (current_setting('argo.msgr_delivery_protocol',true)='1' and msgr_cc_delivery_allowed(b.crew_id,m.id)))
 and not exists(select 1 from msgr_executions e where e.crew_id=b.crew_id and e.source_msg_id=m.id) order by m.id loop
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 select * into ch from msgr_channels where id=s.channel_id;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='user' and s.created_at>now()-interval '10 minutes' and exists(
   select 1 from jsonb_array_elements(s.mentions) with ordinality prev(x,pos)
   where prev.x->>'kind'='crew' and coalesce(prev.x->>'role','to')='to'
   and prev.pos<(select min(pos) from jsonb_array_elements(s.mentions) with ordinality own(x,pos) where own.x->>'id'=b.crew_id::text and coalesce(own.x->>'role','to')='to')
   and msgr_delivery_allowed((prev.x->>'id')::uuid,s.id)
   and not exists(select 1 from msgr_messages answer where answer.channel_id=s.channel_id and answer.crew_id::text=prev.x->>'id' and answer.reply_to=s.id)
 ) then return; end if;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='crew' and msgr_delivery_target(b.crew_id,r.id)
 and not exists(select 1 from msgr_messages answer where answer.channel_id=s.channel_id and answer.crew_id=b.crew_id and answer.reply_to=r.id and answer.id<s.id) then continue; end if;
 a:=null; won:=null;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) then
 a:=gen_random_uuid();
 insert into msgr_executions(crew_id,source_msg_id,attempt) values(b.crew_id,s.id,a) on conflict do nothing returning attempt into won;
 if won is null then continue; end if;
 end if;
 actor:=r.author_user_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.display_name)),'[]') into peers
 from msgr_crews c where c.org_id=b.org_id and c.status='active' and c.id<>b.crew_id
 and msgr_can_instruct(c.id,actor,ch.id) and msgr_can_instruct(c.id,(select owner_user_id from msgr_crews where id=b.crew_id),ch.id)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(ch.id,c.id) or c.dm_delivery_protocol>=1) else msgr_crew_in_channel(ch.id,c.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 select coalesce(jsonb_agg(h.row order by h.id),'[]') into ctx from (
 select m.id,jsonb_build_object('message_id',m.id,'text',m.body,'author_kind',m.author_kind,'crew_id',m.crew_id,'mentions',m.mentions) row
 from msgr_messages m where m.channel_id=ch.id and m.kind='text' and m.deleted_at is null and (case when ch.kind='dm' and msgr_crew_in_channel(ch.id,b.crew_id) then (m.id<=s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) else (m.id=r.id or m.thread_root=r.id) end)
 and (s.author_kind='user' or m.id<=s.id) order by m.id desc limit 12) h;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'message_id')::bigint=r.id) then ctx:=jsonb_build_array(jsonb_build_object('message_id',r.id,'text',r.body,'author_kind',r.author_kind,'crew_id',r.crew_id,'mentions',r.mentions))||ctx; end if;
 return next jsonb_build_object('update_id',s.id,'message',jsonb_build_object(
 'message_id',s.id,'execution_attempt',a,'delivery_role',case when a is null then 'cc' else 'to' end,'thread_root',r.id,'origin_user_id',actor,'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,b.crew_id),
 'chat',jsonb_build_object('id',ch.id,'kind',ch.kind,'name',ch.name),
 'from',jsonb_build_object('id',coalesce(s.author_user_id,s.crew_id),'kind',s.author_kind,'name',coalesce((select display_name from msgr_crews where id=s.crew_id),(select display_name from msgr_org_members where org_id=b.org_id and user_id=s.author_user_id),'')),
 'date',extract(epoch from s.created_at)::bigint,'text',s.body,'reply_to',s.reply_to,'peers',peers,'context',ctx,
 'attachments',(select coalesce(jsonb_agg(jsonb_build_object('file_id',f.id,'file_name',f.name,'mime_type',f.mime,'file_size',f.bytes)),'[]') from msgr_attachments f where f.message_id=s.id),
 'mentioned',msgr_to_mentioned(s.mentions,b.crew_id)));
 n:=n+1; exit when n>=greatest(1,least(coalesce(lim,50),100));
 end loop;
end $function$
;

-- 매초 오던 무조건 갱신(HOT update·autovacuum 7,873회의 원인) — 이미 1이면 쓰지 않는다.
create or replace function public.msgr_bot_updates_with_delivery(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $function$
declare old_protocol text;
begin
 if (msgr_bot_auth(token)).id is null then raise exception 'msgr_bot_unauthorized'; end if;
 update msgr_crews set dm_delivery_protocol=1 where id=(msgr_bot_auth(token)).crew_id and dm_delivery_protocol is distinct from 1;
 old_protocol:=current_setting('argo.msgr_delivery_protocol',true);
 perform set_config('argo.msgr_delivery_protocol','1',true);
 return query select * from msgr_bot_updates(token,after_id,lim);
 perform set_config('argo.msgr_delivery_protocol',coalesce(old_protocol,''),true);
end $function$;
