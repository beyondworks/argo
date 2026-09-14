-- 1:1 DM은 나와 그 에이전트 둘만의 방이다(유건 2026-09-14). 수신(To)·참조(CC)로 지정된 에이전트가 이 방의 멤버가 아니면
-- 서버가 그 지시를 "나와 그 에이전트의 1:1 방"으로 전달(relay)하고, 원래 방에는 전달 안내 한 줄만 남긴다.
-- 에이전트는 자기 방에서 평소 경로로 답하므로 브리지·외부 어댑터는 그대로다. 위임 스레드(0.1.24)의 원래 방 실행 경로는 닫는다.

-- 나(p_user)와 크루(p_crew)의 1:1 방을 찾거나 만든다. 사람 = {나, 크루 소유자(다르면)}, 크루 = {p_crew} 정확히 — 앱의 openDm과 같은 판정.
create or replace function public.msgr_dm_for_crew(p_org uuid, p_user uuid, p_crew uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare c msgr_crews; want uuid[]; ch uuid; u uuid;
begin
  select * into c from msgr_crews where id=p_crew and org_id=p_org and status='active';
  if c.id is null then return null; end if;
  want:=array(select distinct x from unnest(array[p_user,c.owner_user_id]) x order by x);
  -- 락을 조회보다 먼저 잡는다(검수 HIGH-1: 뒤에 잡으면 두 트랜잭션이 각자 "없음"을 보고 같은 방을 두 개 만든다).
  perform pg_advisory_xact_lock(hashtext('msgr_dm_for_crew:'||p_user::text||':'||p_crew::text));
  select d.id into ch from msgr_channels d
   where d.org_id=p_org and d.kind='dm' and d.archived_at is null
     and (select array_agg(m.member_id order by m.member_id) from msgr_channel_members m where m.channel_id=d.id and m.member_kind='user')=want
     and (select array_agg(m.member_id) from msgr_channel_members m where m.channel_id=d.id and m.member_kind='crew')=array[p_crew]
   order by d.created_at,d.id limit 1;
  if ch is not null then return ch; end if;
  insert into msgr_channels(org_id,kind,name,created_by) values(p_org,'dm',c.display_name,p_user) returning id into ch;
  foreach u in array want loop insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values(ch,'user',u,p_user); end loop;
  insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values(ch,'crew',p_crew,p_user);
  return ch;
end $$;
revoke all on function public.msgr_dm_for_crew(uuid,uuid,uuid) from public,anon,authenticated;

-- DM 실행 권한 = 그 방의 멤버 크루뿐. 원래 방에 남기던 위임 실행 경로(dm_delivery_protocol·grant chain)는 닫는다.
create or replace function public.msgr_delivery_allowed(p_crew uuid,p_source bigint) returns boolean
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s msgr_messages; r msgr_messages; c msgr_crews; ch msgr_channels; sender uuid;
begin
 select * into s from msgr_messages where id=p_source;
 select * into ch from msgr_channels where id=s.channel_id;
 select * into c from msgr_crews where id=p_crew;
 select * into r from msgr_messages where id=case when s.author_kind='user' then coalesce(s.thread_root,s.id) else s.thread_root end;
 if not coalesce(msgr_delivery_target(p_crew,p_source),false) or c.id is null or c.status<>'active' or c.org_id is distinct from ch.org_id or ch.archived_at is not null or msgr_org_locked(ch.org_id)
 or r.id is null or r.author_kind<>'user' or r.deleted_at is not null or r.channel_id is distinct from ch.id then return false; end if;
 if not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=c.owner_user_id and removed_at is null and (expires_at is null or expires_at>now()))
 or not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=r.author_user_id and removed_at is null and (expires_at is null or expires_at>now())) then return false; end if;
 if s.author_kind='user' then sender:=s.author_user_id;
 else select owner_user_id into sender from msgr_crews where id=s.crew_id and org_id=c.org_id and status='active'; end if;
 if sender is null or not coalesce(msgr_can_instruct(c.id,sender,ch.id),false) or not coalesce(msgr_can_instruct(c.id,r.author_user_id,ch.id),false) then return false; end if;
 if not msgr_crew_in_channel(ch.id,c.id) then return false; end if;
 if ch.kind='dm' and exists(select 1 from msgr_work_runs w where w.root_message_id=r.id and w.channel_id=ch.id and (w.status<>'running' or s.id<coalesce(w.last_resume_message_id,0))) then return false; end if;
 if s.author_kind='crew' and (select count(*) from msgr_messages where thread_root=r.id and channel_id=ch.id and author_kind='crew' and kind='text' and id>coalesce(msgr_work_round_start(r.id,ch.id),0))>=10 then return false; end if;
 return true;
end $$;

-- 참조 사본도 그 방의 멤버 크루에게만(전달된 방에서 받는다).
create or replace function public.msgr_cc_delivery_allowed(p_crew uuid,p_source bigint) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from msgr_messages s join msgr_channels ch on ch.id=s.channel_id and ch.kind='dm'
 where s.id=p_source and s.deleted_at is null and s.kind='text'
 and msgr_crew_in_channel(ch.id,p_crew)
 and not msgr_to_mentioned(s.mentions,p_crew)
 and exists(select 1 from jsonb_array_elements(s.mentions) x where x->>'kind'='crew' and x->>'id'=p_crew::text and x->>'role'='cc')
 and (s.author_kind='user' or s.meta->>'disposition' is distinct from 'done')
 and msgr_dm_access(p_crew,coalesce(s.thread_root,s.id),false)
 and not exists(select 1 from msgr_work_runs w where w.root_message_id=coalesce(s.thread_root,s.id) and w.channel_id=ch.id and w.status<>'running'))
$$;

-- 수신·참조 후보: 지시 권한만 있으면 전부 준비됨(전달 방식은 런타임 버전을 타지 않는다).
create or replace function public.msgr_dm_candidates(p_channel uuid) returns setof jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
 if auth.uid() is null or not coalesce(msgr_can_write_channel(p_channel),false) or not exists(select 1 from msgr_channels where id=p_channel and kind='dm') then raise exception 'msgr_forbidden' using errcode='42501'; end if;
 return query select jsonb_build_object('id',c.id,'display_name',c.display_name,'role_text',c.role_text,'slug',c.slug,'owner_user_id',c.owner_user_id,'ws_id',c.ws_id,'delivery_protocol',c.dm_delivery_protocol,'delivery_ready',true)
 from msgr_crews c join msgr_channels ch on ch.id=p_channel and ch.org_id=c.org_id
 where c.status='active' and msgr_can_instruct(c.id,auth.uid(),p_channel)
 and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
end $$;

-- DM 삽입 게이트: 멤버가 아닌 크루를 수신·참조로 적어도 거절하지 않는다(전달 대상이 된다). 런타임 버전 요구는 없앤다.
create or replace function public.msgr_dm_message_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; r msgr_messages; s msgr_messages; dest uuid; x jsonb; sender uuid;
begin
 select * into ch from msgr_channels where id=new.channel_id;
 if ch.kind<>'dm' then return new; end if;
 if ch.archived_at is not null or msgr_org_locked(ch.org_id) then raise exception 'msgr_not_allowed'; end if;
 if pg_trigger_depth()<=1 then new.meta:=coalesce(new.meta,'{}')-'relay'-'relay_to'-'relay_capped'; end if; -- 전달 표식은 전달 트리거(중첩 삽입)만 쓴다 — 클라이언트 위조 캡션 차단(검수 LOW)
 if new.author_kind='user' then
   if not exists(select 1 from msgr_channel_members where channel_id=ch.id and member_kind='user' and member_id=new.author_user_id) then raise exception 'msgr_not_allowed'; end if;
   if new.thread_root is null then new.thread_root:=new.id; end if;
   if new.thread_root<>new.id then
     select * into r from msgr_messages where id=new.thread_root and channel_id=ch.id and author_kind='user' and deleted_at is null;
     if r.id is null or r.author_user_id is distinct from new.author_user_id then raise exception 'msgr_not_allowed'; end if;
   end if;
   sender:=new.author_user_id;
 elsif new.author_kind='crew' then
   if new.reply_to is null and msgr_crew_in_channel(ch.id,new.crew_id) then
     new.mentions:='[]'; new.thread_root:=null; new.meta:=(coalesce(new.meta,'{}')-'origin'-'hop')||'{"disposition":"done"}'::jsonb; return new;
   end if;
   select * into s from msgr_messages where id=new.reply_to and channel_id=ch.id;
   if s.id is null or not msgr_delivery_allowed(new.crew_id,s.id) then raise exception 'msgr_not_allowed'; end if;
   new.thread_root:=coalesce(s.thread_root,s.id);
   select * into r from msgr_messages where id=new.thread_root;
   select owner_user_id into sender from msgr_crews where id=new.crew_id;
   new.meta:=coalesce(new.meta,'{}') || jsonb_build_object('origin',r.author_user_id,'hop',(select count(*) from msgr_messages where thread_root=r.id and channel_id=ch.id and author_kind='crew' and kind='text'));
   if new.meta->>'disposition'='done' then new.mentions:='[]'; end if;
 else return new; end if;
 for x in select value from jsonb_array_elements(coalesce(new.mentions,'[]')) loop
   if x->>'kind'<>'crew' then continue; end if;
   if coalesce(x->>'role','to') not in ('to','cc') then raise exception 'msgr_bad_delivery_role'; end if;
   begin dest:=(x->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
   if not exists(select 1 from msgr_crews c where c.id=dest and c.org_id=ch.org_id and c.status='active'
     and msgr_can_instruct(c.id,sender,ch.id) and msgr_can_instruct(c.id,coalesce(r.author_user_id,new.author_user_id),ch.id)
     and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()))) then raise exception 'msgr_not_allowed'; end if;
 end loop;
 return new;
end $$;

-- 전달: DM의 text 글에 적힌 수신·참조 중 이 방 멤버가 아닌 크루마다, 지시자(뿌리 글쓴이)와 그 크루의 1:1 방에 같은 본문을 지시자 명의로 넣는다.
-- 전달 글은 그 방의 새 뿌리이며 meta.relay가 출처를 가리킨다. 원래 방에는 system 글 하나(meta.relay_to)로 안내한다. 전달 글의 크루는 그 방 멤버라 재전달되지 않는다.
create or replace function public.msgr_dm_relay() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare ch msgr_channels; r msgr_messages; x jsonb; dest uuid; role text; target uuid; via msgr_crews; sent jsonb:='[]'; names text; human uuid; depth int;
begin
 if new.kind<>'text' or new.deleted_at is not null or new.author_kind not in ('user','crew') or coalesce(new.meta->>'disposition','')='done' or new.meta ? 'relay' then return new; end if;
 select * into ch from msgr_channels where id=new.channel_id;
 if ch.kind<>'dm' then return new; end if;
 select * into r from msgr_messages where id=coalesce(new.thread_root,new.id);
 human:=case when new.author_kind='user' then new.author_user_id else r.author_user_id end;
 if human is null then return new; end if;
 if new.author_kind='crew' then select * into via from msgr_crews where id=new.crew_id; end if;
 -- 전달 깊이: 사람이 직접 지정하면 1, 크루 답글의 넘김이면 (이 방 뿌리가 전달 글이었을 때 그 깊이)+1. 크루끼리 방을 오가며 핑퐁하는 연쇄는 5에서 끊고 안내만 남긴다.
 depth:=case when new.author_kind='user' then 1 else coalesce((r.meta->'relay'->>'depth')::int,0)+1 end;
 for x in select value from jsonb_array_elements(coalesce(new.mentions,'[]')) loop
   if x->>'kind'<>'crew' then continue; end if;
   role:=coalesce(x->>'role','to');
   begin dest:=(x->>'id')::uuid; exception when invalid_text_representation then continue; end;
   if dest is null or msgr_crew_in_channel(ch.id,dest) or (via.id is not null and dest=via.id) then continue; end if;
   if depth>5 then
     insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,reply_to,thread_root,client_msg_id,meta)
     values(ch.id,'user',human,'system','에이전트 사이의 전달이 5단계를 넘어 멈췄습니다. 필요하면 직접 지시해 주세요.',new.id,r.id,'relaycap:'||new.id,jsonb_build_object('relay_capped',depth))
     on conflict do nothing;
     return new;
   end if;
   -- 대상 하나의 실패(대상 방 정책·권한)가 사용자의 원글까지 롤백하지 않도록 대상별로 격리한다(검수 HIGH-2). 실패는 안내에 남긴다.
   begin
     target:=msgr_dm_for_crew(ch.org_id,human,dest);
     if target is null or target=ch.id then continue; end if;
     insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
     values(target,'user',human,'text',new.body,jsonb_build_array(jsonb_build_object('kind','crew','id',dest,'role',role)),'relay:'||new.id||':'||dest,
       jsonb_build_object('relay',jsonb_build_object('source_id',new.id,'channel_id',ch.id,'role',role,'via_crew_id',via.id,'via_name',via.display_name,'depth',depth)))
     on conflict do nothing;
     sent:=sent||jsonb_build_object('crew_id',dest,'channel_id',target,'role',role,'name',(select display_name from msgr_crews where id=dest));
   exception when others then
     sent:=sent||jsonb_build_object('crew_id',dest,'channel_id',null,'role',role,'name',(select display_name from msgr_crews where id=dest),'failed',sqlerrm);
   end;
 end loop;
 if jsonb_array_length(sent)=0 then return new; end if;
 select string_agg(e->>'name'||case when e->>'role'='cc' then '(참조)' else '' end||case when e ? 'failed' then ' — 전달 실패' else '' end,', ' order by (e->>'role'='cc'),e->>'name') into names from jsonb_array_elements(sent) e;
 insert into msgr_messages(channel_id,author_kind,author_user_id,kind,body,reply_to,thread_root,client_msg_id,meta)
 values(ch.id,'user',human,'system',names||'에게 전달했습니다. 답변은 그 에이전트와의 1:1 대화에 올라옵니다.',new.id,r.id,'relaynote:'||new.id,jsonb_build_object('relay_to',sent))
 on conflict do nothing;
 return new;
end $$;
revoke all on function public.msgr_dm_relay() from public,anon,authenticated;
drop trigger if exists msgr_dm_relay on public.msgr_messages;
create trigger msgr_dm_relay after insert on public.msgr_messages for each row execute function public.msgr_dm_relay();
notify pgrst,'reload schema';

-- 준비 게이트 비대칭 해소(검수 MEDIUM-4): 크루 쪽 피어 목록(msgr_crew_context·bot updates)이 보던 dm_delivery_protocol>=1 요구를 사실상 없앤다.
alter table public.msgr_crews alter column dm_delivery_protocol set default 1;
update public.msgr_crews set dm_delivery_protocol=1 where dm_delivery_protocol<1;
-- 옛 위임 grant는 더 이상 실행·열람 근거가 아니다. 새 grant를 쓰지 않고 남은 행을 비워 비멤버 크루의 스레드 열람(msgr_crew_thread)을 닫는다(PG 검수 결함 2).
drop trigger if exists msgr_dm_message_grant on public.msgr_messages;
delete from public.msgr_dm_grants;
notify pgrst,'reload schema';
