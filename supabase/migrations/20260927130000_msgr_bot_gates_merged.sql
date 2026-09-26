-- 2026-09-27(2차 검수, H1) — fix/msgr-appstore-compliance(20260927110000, AI 동의 필터)와
-- feat/msgr-trial-30d(20260926115000, 무료 기간 자격 게이트)가 msgr_bot_updates_before_work를 각자
-- create or replace해 버전 순서상 나중에 적용되는 쪽이 앞선 쪽의 게이트를 지운다. 이 마이그레이션이
-- 두 브랜치 중 가장 늦게 적용되어, 두 게이트를 모두 담은 최종 합본을 둔다(전수 grep 결과 두 브랜치가
-- 모두 create or replace하는 함수는 msgr_bot_updates_before_work 하나뿐 — msgr_bot_finish는 trial만 건드렸지만
-- N1(2차 검수)이 지적한 자체 회귀가 있어 같이 합본한다).
--
-- msgr_bot_updates_before_work: 본문은 20260926100000(릴레이 순서 수정본)과 같고, 추가된 것은
--   (1) 조직 자격 판정 1회 + 미자격이면 후보별로 채널당 1회 안내·건너뛰기(M3),
--   (2) 안내 client_msg_id에 자격 마커 시각을 섞어 재만료 시 새 안내가 다시 뜨게(L2),
--   (3) AI 미동의 사람 글은 봇에게 넘기지 않고 문맥(ctx)·뿌리 주입에서도 빼기(H2) — 2026-09-27 저녁(2차 재검수)
--       부터는 20260927140000_msgr_ai_consent_transition.sql의 public.msgr_ai_consent_visible()을 부른다(14일
--       전환 기간 포함 — "거부"와 "아직 안 물어봄"을 가른다). 이 파일이 먼저 적용되지만 plpgsql 본문은 실행
--       시점에만 해석되므로 앞을 가리켜도(순방향 참조) 안전하다 — 같은 마이그레이션 배치 안에서 140000이 뒤이어 적용된다.
--   (4) 미자격일 때는 10분/7일 유예창 없이 이번 스캔 최댓값까지 커서를 바로 넘겨, 자격이 돌아와도
--       밀린 후보를 뒤늦게 실행하지 않고 다음 폴부터 새 글만 보게(N6, DB 위생 — 전체 재스캔 방지).
--
-- msgr_bot_finish: 본문은 20260917090000(가장 늦은 정상 정의 — 넘김 판정이 msgr_crew_in_channel 기반)과
--   같고, 추가된 것은 조직 자격 판정 하나뿐이다(M3). 20260926115000의 msgr_bot_finish는 그보다 4버전 전인
--   20260913122421 본문을 베이스로 삼아 20260917090000에서 고친 넘김 판정("ch.kind='public' or 채널
--   멤버십 exists")이 되살아났었다(N1 — 공개 채널·초대 안 된 크루로 넘김이 성공하는 회귀). 이 파일이
--   나중에 적용되므로 그 회귀도 함께 닫는다.

create or replace function public.msgr_bot_updates_before_work(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $function$
declare b msgr_bots; s msgr_messages; r msgr_messages; a uuid; won uuid; peers jsonb; ctx jsonb; n int:=0; lo bigint; actor uuid; ch msgr_channels; key text; cur bigint;
        entitled boolean; ent_marker timestamptz; r_json jsonb; -- 2026-09-27 최종 합본(H1) — 무료 기간 자격(M3) + AI 동의(H2) 둘 다
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 -- 유휴 게이트(2026-09-14 라이브 실측: 봇 11개가 매초 커서 뒤 글 84건을 권한 함수로 재평가 → CPU 96%·회당 0.9초).
 -- 배달 판정에 들어오는 상태의 지문이 지난 전체 스캔과 같고 30초가 안 지났고 ack(after_id)도 새것이 아니면 빈 결과로 즉시 끝낸다.
 -- 지문 밖의 변화(멤버 만료·잠금·심박 10분 경과 등)는 최대 30초 늦게 반영된다 — 그 안에 반드시 전체 스캔이 한 번 돈다.
 select cursor_msg_id into cur from msgr_crews where id=b.crew_id;
 -- max(id)만으로는 id가 작은 글이 늦게 커밋되는 순서 역전 때 지문이 안 바뀐다(검수 MEDIUM-1) → 커서 뒤 글 수를 함께 넣는다(둘 다 (org_id,id) 인덱스 전용 스캔).
 key:=(select coalesce(max(id),0)||':'||count(*) from msgr_messages where org_id=b.org_id and id>coalesce(cur,0))
   ||':'||(select count(*) from msgr_executions where crew_id=b.crew_id)||':'||(select count(*) from msgr_channel_members where member_kind='crew' and member_id=b.crew_id)
   ||':'||coalesce(current_setting('argo.msgr_delivery_protocol',true),'');
 if b.scan_key=key and b.scan_at>now()-interval '30 seconds' and coalesce(after_id,0)<=coalesce(cur,0) then return; end if;
 update msgr_bots set last_seen_at=now(),scan_key=key,scan_at=now() where id=b.id;
 update msgr_crews set last_seen_at=now(),cursor_msg_id=greatest(cursor_msg_id,coalesce(after_id,0)) where id=b.crew_id returning cursor_msg_id into lo;
 entitled:=coalesce(public.msgr_org_entitled(b.org_id),true); -- 조직 자격(M3) — 봇은 조직 하나에 묶이므로 한 번만 판정, fail-open
 if not entitled then select public.msgr_org_entitlement_marker(b.org_id) into ent_marker; end if; -- L2: 안내 키에 만료 시각을 섞어 재만료 시 새 안내
 for s in select m.* from msgr_executions e join msgr_messages m on m.id=e.source_msg_id
 where e.crew_id=b.crew_id and e.state='running' and e.heartbeat_at<now()-interval '10 minutes' and msgr_delivery_allowed(b.crew_id,m.id)
 and not exists(select 1 from msgr_messages x where x.channel_id=m.channel_id and x.client_msg_id='unknown:'||b.crew_id||':'||m.id) loop
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body,meta)
 values(s.channel_id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),'unknown:'||b.crew_id||':'||s.id,'외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. / The external agent has not returned a result. Check its status.','{"execution_status":"unknown","disposition":"done"}') on conflict do nothing;
 end loop;
 for s in with ids as materialized (
   select x.id from msgr_messages x where x.org_id=b.org_id and x.id>lo
   union select g.source_message_id from msgr_dm_grants g where current_setting('argo.msgr_delivery_protocol',true)='1' and g.crew_id=b.crew_id and g.role='to'
 ), cand as materialized (select x.* from ids join msgr_messages x on x.id=ids.id where x.org_id=b.org_id) -- 판정은 이 CTE 행에만(조건이 msgr_messages 스캔으로 밀려 내려가지 않게)
 select m.* from cand m where true
 and (current_setting('argo.msgr_delivery_protocol',true)='1' or not exists(select 1 from msgr_channels d where d.id=m.channel_id and d.kind='dm' and not msgr_crew_in_channel(d.id,b.crew_id)))
 and (msgr_delivery_allowed(b.crew_id,m.id) or (current_setting('argo.msgr_delivery_protocol',true)='1' and msgr_cc_delivery_allowed(b.crew_id,m.id)))
 and not exists(select 1 from msgr_executions e where e.crew_id=b.crew_id and e.source_msg_id=m.id) order by m.id loop
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 select * into ch from msgr_channels where id=s.channel_id;
 if not entitled and ch.org_id is not null then
   insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body)
     values(ch.id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),
       'unentitled:'||b.crew_id||':'||ch.id||':'||coalesce(extract(epoch from ent_marker)::bigint::text,''),
       '무료 기간이 끝나 이 조직의 크루 작업이 멈췄습니다. 조직 관리자에게 문의하세요. / The free period has ended, so crew work is paused for this organization. Contact your organization admin.') on conflict do nothing;
   continue;
 end if;
 -- 검수 H2: 이 글의 사람이 조직 AI 이용에 동의하지 않았으면 봇에게 넘기지 않는다. 배달(to)이면 크루·채널당 한 번 안내하고 건너뛴다.
 if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then
   if not msgr_cc_delivery_allowed(b.crew_id,s.id) then
     insert into msgr_messages(channel_id,author_kind,crew_id,kind,client_msg_id,body,meta)
       values(s.channel_id,'crew',b.crew_id,'system','aiconsent:'||b.crew_id||':'||s.channel_id,
         '앱을 업데이트하고 AI 이용에 동의하면 크루에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to a crew.',
         jsonb_build_object('disposition','done')) on conflict do nothing;
   end if;
   continue;
 end if;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='user' and s.body ~ '>[ \t\r\n]*@' and s.created_at>now()-interval '2 minutes' and exists(
   select 1 from jsonb_array_elements(s.mentions) with ordinality prev(x,pos)
   where prev.x->>'kind'='crew' and coalesce(prev.x->>'role','to')='to'
   and prev.pos<(select min(pos) from jsonb_array_elements(s.mentions) with ordinality own(x,pos) where own.x->>'id'=b.crew_id::text and coalesce(own.x->>'role','to')='to')
   and msgr_delivery_allowed((prev.x->>'id')::uuid,s.id)
   and not exists(select 1 from msgr_messages answer where answer.channel_id=s.channel_id and answer.crew_id::text=prev.x->>'id' and answer.reply_to=s.id)
 ) then return; end if;
 if not msgr_cc_delivery_allowed(b.crew_id,s.id) and s.author_kind='crew' and msgr_delivery_target(b.crew_id,r.id) and r.body ~ '>[ \t\r\n]*@'
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
 and (s.author_kind='user' or m.id<=s.id)
 and (m.author_kind<>'user' or public.msgr_ai_consent_visible(m.author_user_id))
 order by m.id desc limit 12) h;
 r_json := case when r.author_kind='user' and not public.msgr_ai_consent_visible(r.author_user_id)
   then jsonb_build_object('message_id',r.id,'text','','author_kind',r.author_kind,'crew_id',r.crew_id,'mentions',r.mentions)
   else jsonb_build_object('message_id',r.id,'text',r.body,'author_kind',r.author_kind,'crew_id',r.crew_id,'mentions',r.mentions) end;
 if ch.kind='dm' and not exists(select 1 from jsonb_array_elements(ctx) x where (x->>'message_id')::bigint=r.id) then ctx:=jsonb_build_array(r_json)||ctx; end if;
 return next jsonb_build_object('update_id',s.id,'message',jsonb_build_object(
 'message_id',s.id,'execution_attempt',a,'delivery_role',case when a is null then 'cc' else 'to' end,'thread_root',r.id,'origin_user_id',actor,'delegated',ch.kind='dm' and not msgr_crew_in_channel(ch.id,b.crew_id),
 'chat',jsonb_build_object('id',ch.id,'kind',ch.kind,'name',ch.name),
 'from',jsonb_build_object('id',coalesce(s.author_user_id,s.crew_id),'kind',s.author_kind,'name',coalesce((select display_name from msgr_crews where id=s.crew_id),(select display_name from msgr_org_members where org_id=b.org_id and user_id=s.author_user_id),'')),
 'date',extract(epoch from s.created_at)::bigint,'text',s.body,'reply_to',s.reply_to,'peers',peers,'context',ctx,
 'attachments',(select coalesce(jsonb_agg(jsonb_build_object('file_id',f.id,'file_name',f.name,'mime_type',f.mime,'file_size',f.bytes)),'[]') from msgr_attachments f where f.message_id=s.id),
 'mentioned',msgr_to_mentioned(s.mentions,b.crew_id)));
 n:=n+1; exit when n>=greatest(1,least(coalesce(lim,50),100));
 end loop;
 -- 아무것도 못 준 전체 스캔(순서 대기로 중간 반환하지 않았다) — 커서를 앞으로 당긴다. 받을 글이 없는 봇은 ack가 없어 커서가 0에 머물러
 -- 매 스캔마다 조직 글 전체를 배달 판정 함수로 다시 훑었다(2026-09-23 라이브: 451건·봇 11개 동시 → 3초 초과, 픽업 중앙값 614초).
 -- 넘기는 것은 이 크루와 무관한 글뿐이다. 다음 앞에서 멈춘다(검수 #689 HIGH-1·MEDIUM-1):
 --   ① 최근 10분 안의 글(id 기준 — created_at을 과거로 넣어도 뒤의 대기 글을 건너뛰지 못한다)
 --   ② 이 크루를 겨냥할 수 있는 7일 안의 글 — 멘션(to·cc), 이 크루 글에 단 답글·그 스레드, 이 크루가 있는 1:1. 파견 재개·초대 결재 뒤 배달된다.
-- 재검수 #689: 넘길 끝은 10분 넘은 글까지만, 그런 글이 없으면 움직이지 않는다(진행 중 트랜잭션이 늦게 커밋하는 낮은 id를 건너뛰지 않게 — HIGH-2).
-- ponytail: created_at을 과거로 넣은 글(C)과 느린 커밋이 겹치면 여전히 넘길 수 있다 — 필요하면 created_at을 서버 시각으로 고정하는 트리거.
-- ②에서 크루 자기 글·지운 글·카드/시스템 글과 1:1의 크루 글은 겨냥이 아니다(1:1 자기 답글이 7일간 커서를 묶었다 — MEDIUM-4).
 if not entitled then
   -- N6(2026-09-27, 2차 검수): 미자격 동안 밀린 후보는 자격이 돌아와도 뒤늦게 실행하지 않는다(게이트웨이 24시간 만료 규칙과 일관).
   -- 10분/7일 유예창 없이 이번 스캔에서 본 최댓값까지 바로 커서를 넘겨, 다음 폴부터 같은 백로그를 다시 훑지 않는다(DB 위생).
   update msgr_crews c set cursor_msg_id = x.id from (select max(m.id) id from msgr_messages m where m.org_id=b.org_id and m.id>lo) x
     where c.id=b.crew_id and x.id is not null and c.cursor_msg_id<x.id;
 elsif n=0 then
   update msgr_crews c set cursor_msg_id=x.id from (select case when a.id is not null then least(a.id,
       (select min(m.id)-1 from msgr_messages m where m.org_id=b.org_id and m.id>lo and m.created_at>=now()-interval '10 minutes'),
       (select min(m.id)-1 from msgr_messages m where m.org_id=b.org_id and m.id>lo and m.created_at>=now()-interval '7 days'
          and m.kind='text' and m.deleted_at is null and m.crew_id is distinct from b.crew_id and (
          m.mentions @> jsonb_build_array(jsonb_build_object('id', b.crew_id::text))
          or exists(select 1 from msgr_messages p where p.id in (m.reply_to, m.thread_root) and p.crew_id=b.crew_id)
          or (m.author_kind='user' and exists(select 1 from msgr_channels d where d.id=m.channel_id and d.kind='dm' and msgr_crew_in_channel(d.id,b.crew_id)))))
     ) end id from (select max(m.id) id from msgr_messages m where m.org_id=b.org_id and m.id>lo and m.created_at<now()-interval '10 minutes') a) x
    where c.id=b.crew_id and x.id is not null and c.cursor_msg_id<x.id;
 end if;
end $function$
;

notify pgrst, 'reload schema';

create or replace function public.msgr_bot_finish(token text, channel uuid, body text, src_id bigint, attempt uuid, disposition text, mentions jsonb default '[]') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; s public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint; origin_user uuid; hop int; target jsonb; dest uuid;
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
  if disposition = 'handoff' and (hop >= 10 or jsonb_array_length(mentions) > 5) then raise exception 'msgr_bot_handoff_limit'; end if;
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
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;
revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;

notify pgrst, 'reload schema';
