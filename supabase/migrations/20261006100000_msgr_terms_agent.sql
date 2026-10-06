-- 2026-10-06 용어 변경 T3(크루→에이전트, rc-0195 terminology-plan.md 4-1) — 사용자에게 보이는 서버 문구 3곳만 바꾼다.
-- 각 함수는 이 브랜치의 마지막 정의를 글자 그대로 옮기고 문자열 리터럴만 바꿨다(본문·판정·grant·revoke·security definer·search_path 동일):
--   msgr_bot_updates_before_work  ← 20260927130000_msgr_bot_gates_merged.sql (무료 기간 안내·AI 동의 안내 2줄)
--   _msgr_bot_personal_updates    ← 20261002140000_msgr_bot_personal_attach.sql (AI 동의 안내 1줄)
--   msgr_channel_journal          ← 20260930210000_msgr_personal_crews.sql (일지의 이름 없을 때 대체 이름 2곳)
-- revoke는 각 함수가 마지막으로 받은 것과 같다(create or replace는 권한을 유지하므로 같은 값을 다시 거는 것뿐이다).
-- 이미 쌓인 행(메신저 system 글·journal/*.md·msgr_journal_entries)은 기억 데이터라 고치지 않는다 — 이 파일에 UPDATE·DELETE 문은 없다.
-- 안내 중복 방지는 client_msg_id(aiconsent:·unentitled: 키)로만 하고 본문과 무관하다 — 옛 문구 안내가 이미 있는 방에는 새 안내가 다시 올라가지 않는다.
-- 같은 문장을 본체 src/gateway/msgr.mjs도 쓴다(ko·en을 언어별로 고름). 두 쪽이 같은지는 test/msgr-terms-sql-sync.test.mjs가 본다.
-- DB 부하: 함수 본문 문자열만 바뀌어 호출·쓰기 수는 그대로다(+0).

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
       '무료 기간이 끝나 이 조직의 에이전트 작업이 멈췄습니다. 조직 관리자에게 문의하세요. / The free period has ended, so agent work is paused for this organization. Contact your organization admin.') on conflict do nothing;
   continue;
 end if;
 -- 검수 H2: 이 글의 사람이 조직 AI 이용에 동의하지 않았으면 봇에게 넘기지 않는다. 배달(to)이면 크루·채널당 한 번 안내하고 건너뛴다.
 if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then
   if not msgr_cc_delivery_allowed(b.crew_id,s.id) then
     insert into msgr_messages(channel_id,author_kind,crew_id,kind,client_msg_id,body,meta)
       values(s.channel_id,'crew',b.crew_id,'system','aiconsent:'||b.crew_id||':'||s.channel_id,
         '앱을 업데이트하고 AI 이용에 동의하면 에이전트에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to an agent.',
         jsonb_build_object('disposition','done')) on conflict do nothing;
   end if;
   -- 델타 검수(2026-09-27 밤, 4차) — L-1의 "커서를 무조건 전진" 수정을 되돌린다: 커서를 넘기면
   -- #689가 일부러 붙잡아 둔 앞쪽 글(아직 채널 미초대·결재 대기·파견 재개 전인 겨냥 글, 10분 안에
   -- 늦게 커밋되는 낮은 id 글)까지 함께 건너뛰어 봇 배달을 영구히 잃는다(HIGH — 실측: E가 봇 없는
   -- 채널에서 멘션 후 D의 거부 글이 커서를 6까지 밀면, 뒤이어 봇을 초대해도 E의 글이 배달되지 않음).
   -- 거부 글이 커서를 붙잡아 나중에 동의하면 뒤늦게 배달될 수 있는 LOW는 감수한다 — 배달 유실보다 가볍다.
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

revoke all on function public.msgr_bot_updates_before_work(text,bigint,int) from public,anon,authenticated;

create or replace function public._msgr_bot_personal_updates(p_bot uuid, p_twin uuid, after_id bigint, lim int) returns setof jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare bp public.msgr_bot_personal; tw public.msgr_crews; cur bigint; lo bigint; key text; s public.msgr_messages; r public.msgr_messages; ch public.msgr_channels;
  a uuid; won uuid; n int := 0; peers jsonb; ctx jsonb; r_json jsonb; pending boolean := false; waited boolean := false; maxid bigint := 0; cap int;
begin
  select * into bp from public.msgr_bot_personal where bot_id = p_bot;
  select * into tw from public.msgr_crews where id = p_twin;
  if bp.bot_id is null or tw.id is null then return; end if;
  cap := greatest(1, least(coalesce(lim, 50), 100));
  cur := coalesce(tw.cursor_msg_id, 0);
  lo := greatest(cur, least(coalesce(after_id, 0), coalesce(bp.personal_sent_id, cur))); -- H3: 개인으로 실제 보낸 데까지만 ack
  key := public._msgr_bot_personal_key(p_twin, lo, tw.owner_user_id);
  if bp.scan_key = key and lo = cur and (not bp.scan_pending or bp.scan_at > now() - interval '30 seconds') then return; end if;
  if lo > cur then update public.msgr_crews set cursor_msg_id = lo where id = p_twin and cursor_msg_id < lo; end if;

  -- 결과 미도착 안내(10분) — 조직 경로와 같은 규칙, 한 번만
  for s in select m.* from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
            where e.crew_id = p_twin and e.state = 'running' and e.heartbeat_at < now() - interval '10 minutes' and public.msgr_delivery_allowed(p_twin, m.id)
              and not exists (select 1 from public.msgr_messages x where x.channel_id = m.channel_id and x.client_msg_id = 'unknown:' || p_twin || ':' || m.id) loop
    insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, meta)
      values (s.channel_id, 'crew', p_twin, 'system', s.id, coalesce(s.thread_root, s.id), 'unknown:' || p_twin || ':' || s.id,
        '외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. / The external agent has not returned a result. Check its status.',
        '{"execution_status":"unknown","disposition":"done"}') on conflict do nothing; -- 동시 두 호출(검수 #794 LOW-3)
  end loop;

  -- 후보: 쌍둥이가 든 개인 방(참여 행 기반 — org IS NULL 전역 스캔 금지)의 커서 뒤, 24시간 안, 쌍둥이를 겨냥한 글(to 멘션 또는 크루 1:1의 사람 글)
  for s in with cand as materialized (
      select m.* from public.msgr_channel_members cm
        join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
        join public.msgr_channels c on c.id = m.channel_id and c.org_id is null and c.archived_at is null
       where cm.member_kind = 'crew' and cm.member_id = p_twin
         and m.org_id is null and m.kind = 'text' and m.deleted_at is null and m.created_at > now() - interval '24 hours'
         and m.crew_id is distinct from p_twin
         and (public.msgr_to_mentioned(m.mentions, p_twin) or (m.author_kind = 'user' and c.personal_pair like 'crew:%')))
    select x.* from cand x
     where public.msgr_delivery_allowed(p_twin, x.id)
       and not exists (select 1 from public.msgr_executions e where e.crew_id = p_twin and e.source_msg_id = x.id)
     order by x.id loop
    select * into r from public.msgr_messages where id = case when s.author_kind = 'user' then coalesce(s.thread_root, s.id) else s.thread_root end;
    select * into ch from public.msgr_channels where id = s.channel_id;
    -- 개인 방은 명시적 동의만(#779 H3). 뿌리 작성자는 지시할 수 있는 사람(= 주인)이고 사람 글이면 이번 글 작성자와 같다(msgr_dm_message_guard).
    if not public.msgr_ai_consent_ok_for(r.author_user_id, true) then
      if not exists (select 1 from public.msgr_messages x where x.channel_id = s.channel_id and x.client_msg_id = 'aiconsent:' || p_twin || ':' || s.channel_id) then
        insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body, meta)
          values (s.channel_id, 'crew', p_twin, 'system', 'aiconsent:' || p_twin || ':' || s.channel_id,
            '앱을 업데이트하고 AI 이용에 동의하면 에이전트에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to an agent.',
            jsonb_build_object('disposition', 'done')) on conflict do nothing; -- 동시 두 호출(검수 #794 LOW-3)
      end if;
      continue;
    end if;
    -- 순차 멘션(>@): 앞의 크루가 아직 답하지 않았으면 기다린다(2분) — 조직 경로와 같은 규칙
    if s.author_kind = 'user' and s.body ~ '>[ \t\r\n]*@' and s.created_at > now() - interval '2 minutes' and exists (
      select 1 from jsonb_array_elements(s.mentions) with ordinality prev(x, pos)
       where prev.x->>'kind' = 'crew' and coalesce(prev.x->>'role', 'to') = 'to'
         and prev.pos < (select min(pos) from jsonb_array_elements(s.mentions) with ordinality own(x, pos) where own.x->>'id' = p_twin::text and coalesce(own.x->>'role', 'to') = 'to')
         and public.msgr_delivery_allowed((prev.x->>'id')::uuid, s.id)
         and not exists (select 1 from public.msgr_messages answer where answer.channel_id = s.channel_id and answer.crew_id::text = prev.x->>'id' and answer.reply_to = s.id)) then
      waited := true; pending := true; exit;
    end if;
    if s.author_kind = 'crew' and public.msgr_delivery_target(p_twin, r.id) and r.body ~ '>[ \t\r\n]*@'
       and not exists (select 1 from public.msgr_messages answer where answer.channel_id = s.channel_id and answer.crew_id = p_twin and answer.reply_to = r.id and answer.id < s.id) then
      continue;
    end if;
    a := gen_random_uuid(); won := null;
    insert into public.msgr_executions (crew_id, source_msg_id, attempt) values (p_twin, s.id, a) on conflict do nothing returning attempt into won;
    if won is null then continue; end if;
    -- 동료: 이 방의 크루 중 뿌리 작성자와 주인 둘 다 지시할 수 있는 것(사실상 주인의 크루)
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name)), '[]') into peers
      from public.msgr_channel_members cm join public.msgr_crews c on c.id = cm.member_id and c.org_id is null and c.status = 'active' and c.id <> p_twin
     where cm.channel_id = ch.id and cm.member_kind = 'crew'
       and public.msgr_can_instruct(c.id, r.author_user_id, ch.id) and public.msgr_can_instruct(c.id, tw.owner_user_id, ch.id)
       and exists (select 1 from public.msgr_channel_members o where o.channel_id = ch.id and o.member_kind = 'user' and o.member_id = c.owner_user_id);
    -- 문맥(M4): 주인 글(명시적 동의)과 주인의 크루 글만 — 친구 글은 회사 도구·기억을 가진 에이전트에게 넘기지 않는다
    select coalesce(jsonb_agg(h.row order by h.id), '[]') into ctx from (
      select m.id, jsonb_build_object('message_id', m.id, 'text', m.body, 'author_kind', m.author_kind, 'crew_id', m.crew_id, 'mentions', m.mentions) as row
        from public.msgr_messages m
       where m.channel_id = ch.id and m.kind = 'text' and m.deleted_at is null
         and (m.id <= s.id or (m.reply_to = s.id and public.msgr_to_mentioned(s.mentions, m.crew_id)))
         and (s.author_kind = 'user' or m.id <= s.id)
         and ((m.author_kind = 'user' and m.author_user_id = tw.owner_user_id and public.msgr_ai_consent_ok_for(m.author_user_id, true))
              or (m.author_kind = 'crew' and exists (select 1 from public.msgr_crews oc where oc.id = m.crew_id and oc.owner_user_id = tw.owner_user_id)))
       order by m.id desc limit 12) h;
    r_json := jsonb_build_object('message_id', r.id, 'text', r.body, 'author_kind', r.author_kind, 'crew_id', r.crew_id, 'mentions', r.mentions);
    if not exists (select 1 from jsonb_array_elements(ctx) x where (x->>'message_id')::bigint = r.id) then ctx := jsonb_build_array(r_json) || ctx; end if;
    return next jsonb_build_object('update_id', s.id, 'message', jsonb_build_object(
      'message_id', s.id, 'execution_attempt', a, 'delivery_role', 'to', 'thread_root', r.id, 'origin_user_id', r.author_user_id, 'delegated', false,
      'personal', true, -- 개인 공간 글(조직 밖) — 어댑터가 조직 기억과 나눌 수 있게
      'chat', jsonb_build_object('id', ch.id, 'kind', ch.kind, 'name', ch.name),
      'from', jsonb_build_object('id', coalesce(s.author_user_id, s.crew_id), 'kind', s.author_kind,
        'name', coalesce((select display_name from public.msgr_crews where id = s.crew_id), public.msgr_person_label(s.author_user_id), '')),
      'date', extract(epoch from s.created_at)::bigint, 'text', s.body, 'reply_to', s.reply_to, 'peers', peers, 'context', ctx,
      -- 개인 방 첨부(20261002100000부터 있다) — 주인 글(명시적 동의)·주인 크루 글의 첨부만. 친구 글의 파일은 문맥과 같은 이유(M4)로 넘기지 않는다
      'attachments', case when (s.author_kind = 'user' and s.author_user_id = tw.owner_user_id and public.msgr_ai_consent_ok_for(s.author_user_id, true))
                             or (s.author_kind = 'crew' and exists (select 1 from public.msgr_crews oc where oc.id = s.crew_id and oc.owner_user_id = tw.owner_user_id))
                          then (select coalesce(jsonb_agg(jsonb_build_object('file_id', f.id, 'file_name', f.name, 'mime_type', f.mime, 'file_size', f.bytes)), '[]') from public.msgr_attachments f where f.message_id = s.id)
                          else '[]'::jsonb end,
      'mentioned', public.msgr_to_mentioned(s.mentions, p_twin)));
    n := n + 1; maxid := greatest(maxid, s.id);
    exit when n >= cap;
  end loop;

  if n > 0 then
    -- 처음 개인 글을 보낼 때 조직 기록값이 없으면 지금 조직 커서에서 시작한다(그 뒤로는 조직 배달마다 msgr_bot_updates가 올린다)
    update public.msgr_bot_personal p set personal_sent_id = greatest(coalesce(p.personal_sent_id, 0), maxid),
        org_sent_id = greatest(coalesce(p.org_sent_id, 0), (select coalesce(oc.cursor_msg_id, 0) from public.msgr_bots b join public.msgr_crews oc on oc.id = b.crew_id where b.id = p_bot)),
        scan_key = null -- 다음 호출이 이어서 훑는다(한도 때문에 남은 후보)
      where p.bot_id = p_bot;
    return;
  end if;
  -- 보류: 결과를 기다리는 실행(안내 전)이 있으면 30초마다 다시 본다. 안내를 실제로 남길 수 있는 실행만 — 배달 판정이 거짓이 된 실행(글 삭제·방 보관·
  -- 나가기·차단)은 안내도 답도 못 남겨 running으로 남는다. 그런 실행이나 11분(안내 기한 10분 + 한 번 더 볼 여유)이 지난 실행은 기다리지 않는다
  -- (검수 #794 M-1 — 끝나지 않는 보류가 30초마다 msgr_bot_personal을 다시 썼다).
  pending := pending or exists (select 1 from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
     where e.crew_id = p_twin and e.state = 'running' and e.heartbeat_at > now() - interval '11 minutes'
       and not exists (select 1 from public.msgr_messages x where x.channel_id = m.channel_id and x.client_msg_id = 'unknown:' || p_twin || ':' || m.id)
       and public.msgr_delivery_allowed(p_twin, m.id));
  if not waited then
    -- 아무것도 못 준 스캔 — 커서를 당긴다. 10분 안의 글과 24시간 안의 겨냥 글(아직 실행 기록 없음) 앞에서 멈춘다.
    -- least()는 NULL을 무시한다 — 넘길 끝(10분 넘은 글의 최댓값)이 없으면 움직이지 않는다(case).
    update public.msgr_crews c set cursor_msg_id = x.id from (
      select case when a2.id is not null then least(a2.id,
          (select min(m.id) - 1 from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
            where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at >= now() - interval '10 minutes'),
          (select min(m.id) - 1 from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
             join public.msgr_channels d on d.id = m.channel_id
            where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at >= now() - interval '24 hours'
              and m.kind = 'text' and m.deleted_at is null and m.crew_id is distinct from p_twin
              and (public.msgr_to_mentioned(m.mentions, p_twin) or (m.author_kind = 'user' and d.personal_pair like 'crew:%'))
              and not exists (select 1 from public.msgr_executions e where e.crew_id = p_twin and e.source_msg_id = m.id))) end as id
        from (select max(m.id) as id from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
               where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at < now() - interval '10 minutes') a2) x
     where c.id = p_twin and x.id is not null and c.cursor_msg_id < x.id;
  end if;
  select cursor_msg_id into cur from public.msgr_crews where id = p_twin;
  update public.msgr_bot_personal set scan_key = public._msgr_bot_personal_key(p_twin, cur, tw.owner_user_id), scan_at = now(), scan_pending = pending
   where bot_id = p_bot;
end $$;
revoke all on function public._msgr_bot_personal_updates(uuid, uuid, bigint, int) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.msgr_channel_journal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare ch msgr_channels; src msgr_messages; crew_name text; who text; human uuid; day text; line text; src_author uuid; src_visible boolean; quote_body text;
begin
  if new.author_kind<>'crew' or new.kind<>'text' or new.deleted_at is not null or new.crew_id is null then return new; end if;
  select * into ch from msgr_channels where id=new.channel_id;
  if ch.id is null or ch.org_id is null or ch.crew_memory=false or ch.archived_at is not null then return new; end if; -- 개인 방은 조직 문서가 없다(2026-09-30: 삽입 실패를 삼키던 서브트랜잭션을 없앤다) -- 2026-09-16: DM 포함(문서는 채널 범위 RLS)
  select display_name into crew_name from msgr_crews where id=new.crew_id;
  select * into src from msgr_messages where id=new.reply_to;
  human:=(select author_user_id from msgr_messages where id=coalesce(new.thread_root,new.reply_to) and author_kind='user');
  if human is null then select owner_user_id into human from msgr_crews where id=new.crew_id; end if;
  who:=case when src.author_kind='user' then coalesce((select display_name from msgr_org_members m where m.org_id=ch.org_id and m.user_id=src.author_user_id),'멤버')
            when src.author_kind='crew' then coalesce((select display_name from msgr_crews where id=src.crew_id),'에이전트') else null end;
  -- 검수 M-1(2026-09-27 밤, 3차 재검수) — 원글 작성자가 지금 동의 상태로 보이지 않으면(거부·철회·전환 기간 지난 미응답)
  -- 일지에 그 사람 원문을 적지 않는다. 크루 글(src.author_kind='crew')은 동의 판정 대상이 아니다(AI 산출물).
  src_author:=case when src.author_kind='user' then src.author_user_id else null end;
  src_visible:=src_author is null or public.msgr_ai_consent_visible(src_author);
  quote_body:=case when not src_visible then '(비공개 / private)' else left(regexp_replace(coalesce(src.body,''),'\s+',' ','g'),160) end;
  day:=to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD'); -- ponytail: 조직 시간대 설정이 생기면 그 값으로
  line:='- '||to_char(now() at time zone 'Asia/Seoul','HH24:MI')||' · **'||coalesce(crew_name,'에이전트')||'**'
        ||case when who is not null then ' ← '||who||': '||quote_body else '' end
        ||' → '||left(regexp_replace(new.body,'\s+',' ','g'),240);
  begin
    perform set_config('argo.msgr_journal','1',true);
    insert into msgr_org_docs(org_id,channel_id,path,title,body,created_by,updated_by)
    values(ch.org_id,ch.id,'journal/'||day||'.md',day,line,human,human)
    on conflict (org_id, coalesce(channel_id, org_id), path) do update
      set body=left(msgr_org_docs.body||E'\n'||excluded.body,65536), updated_by=excluded.updated_by; -- 하루 64KB를 넘기면 뒤가 잘린다(ponytail: 파일 분할은 필요해지면)
    perform set_config('argo.msgr_journal','',true);
  exception when others then
    perform set_config('argo.msgr_journal','',true); -- 일지 실패가 답글 저장을 막지 않는다
  end;
  -- 검수 M-1 — msgr_org_docs 쓰기와 별개 예외 범위에 둔다(줄 단위 표 쓰기가 실패해도 방금 성공한 문서 갱신을
  -- 롤백하지 않는다 — 같은 begin/exception 안에 같이 두면 저장점 하나를 공유해 뒤쪽 실패가 앞쪽 성공까지 되돌린다).
  begin
    -- 델타 검수 LOW(4차) — 여기 있던 인라인 삭제(채널당 매 답글)를 뺐다: channel_id 조건만으로는 인덱스를
    -- 못 타 매번 표 전체를 훑었다(msgr_journal_entries_lookup은 org_id가 선두라 channel_id 단독 스캔에
    -- 못 쓰인다). 보존은 아래 03:29 pg_cron(purge-msgr-journal-entries) 하나로만 맡긴다.
    insert into public.msgr_journal_entries(org_id,channel_id,day,source_msg_id,source_author_id,line)
      values(ch.org_id,ch.id,day,src.id,src_author,line);
  exception when others then null; -- 이 표 실패도 답글 저장·문서 갱신을 막지 않는다
  end;
  return new;
end $function$;
revoke all on function public.msgr_channel_journal() from public,anon,authenticated;

notify pgrst, 'reload schema';
