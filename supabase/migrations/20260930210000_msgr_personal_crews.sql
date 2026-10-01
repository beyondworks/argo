-- 개인 공간 에이전트 1단계(2026-09-30 유건): 내 Argo 크루를 조직 없이 개인 공간에서 부르고, 친구와의 개인 방에도 넣는다.
-- 원칙: 개인 크루 행(org_id NULL)은 개인 방에만, 조직 크루는 그 조직 채널에만 — "크루 org = 채널 org"를 IS NOT DISTINCT FROM으로 지킨다.
-- 목록 노출: 개인 크루 행은 주인만 select한다. 방 안의 남의 크루는 msgr_personal_room_crews()가 표시용 열만 돌려준다
--   ("내 에이전트"·"추가 후보"에 남의 에이전트가 나오면 안 된다 — 유건 2026-09-30).
-- 인원 한도(무료 플랜, 유건 2026-09-30): 사람이 둘 이상인 개인 방은 사람+에이전트 4명까지. 혼자 쓰는 방은 내 에이전트 제한 없음. Pro는 제한 없음(Pro 한도 미정).
-- 2주 유예: 기존 사용자는 2026-10-14까지, 신규 가입자는 가입부터 2주(msgr_free_grace).
-- 외부 봇(Hermes·OpenClaw)은 다음 단계 — 이 파일은 hosting='local'만 연다.

-- 1) 표
alter table public.msgr_crews alter column org_id drop not null;
alter table public.msgr_crews add constraint msgr_crews_personal_local check (org_id is not null or hosting = 'local');
create unique index if not exists msgr_crews_personal_uniq on public.msgr_crews (owner_user_id, ws_id, slug) where org_id is null;

-- 2) RLS — 개인 크루 행은 주인만 본다·만든다. 크루 글 삽입은 크루 org = 채널 org(개인은 둘 다 NULL).
alter policy msgr_crews_select on public.msgr_crews
  using (case when org_id is null then owner_user_id = auth.uid() else msgr_is_member(org_id) end); -- 하위 조회((select auth.uid()))를 넣으면 msgr_crews_update_admin의 자기 표 조회와 겹쳐 '정책 무한 재귀'가 난다(드릴 실측)
alter policy msgr_crews_insert on public.msgr_crews
  with check ((owner_user_id = (select auth.uid())) and (
    (org_id is null and hosting = 'local')
    or ((msgr_role(org_id) = any (array['owner'::text, 'admin'::text, 'member'::text])) and (not msgr_org_locked(org_id))
        and ((hosting = 'local'::text) or (owner_user_id = (select o.service_user_id from msgr_orgs o where o.id = msgr_crews.org_id))))));
alter policy msgr_messages_insert on public.msgr_messages
  with check (msgr_can_write_channel(channel_id) and (((author_kind = 'user'::text) and (author_user_id = (select auth.uid())))
    or ((author_kind = 'crew'::text) and (exists (select 1 from msgr_crews c
      where c.id = msgr_messages.crew_id and c.owner_user_id = (select auth.uid()) and c.status = 'active'::text
        and c.org_id is not distinct from (select ch.org_id from msgr_channels ch where ch.id = msgr_messages.channel_id))))));

CREATE OR REPLACE FUNCTION public.msgr_crew_in_channel(ch uuid, crew uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select exists (
      select 1 from public.msgr_channels c join public.msgr_crews cr on cr.id = crew and cr.org_id is not distinct from c.org_id
       where c.id = ch and not (crew = any (c.excluded_crew_ids))
         and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'crew' and m.member_id = crew)
    )
$function$;

CREATE OR REPLACE FUNCTION public.msgr_channel_member_ok(ch uuid, kind text, mid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select case kind
      when 'user' then exists (select 1 from public.msgr_org_members m join public.msgr_channels c on c.id = ch
                                where m.org_id = c.org_id and m.user_id = mid and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))
      when 'crew' then exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch
                                where cr.id = mid and cr.org_id is not distinct from c.org_id and cr.status = 'active'
                                  and ((cr.owner_user_id = auth.uid() and (c.kind <> 'dm' or public.msgr_dm_approver(ch) = auth.uid()))
                                       or (c.kind <> 'dm' and public.msgr_crew_is_company(cr.id))))
      else false end
$function$;

CREATE OR REPLACE FUNCTION public.msgr_dm_shape()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare k text; pair text; nu int;
begin
  select kind, personal_pair into k, pair from public.msgr_channels where id = new.channel_id;
  if k <> 'dm' or pair is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || new.channel_id::text)); -- 두 기기가 같은 순간에 열 때(검수 2R LOW-2)
  select count(*) filter (where member_kind = 'user') into nu
    from public.msgr_channel_members where channel_id = new.channel_id;
  if new.member_kind = 'crew' then return new; end if; -- 개인 1:1에도 에이전트를 넣는다(2026-09-30) — 사람 두 명 제한은 그대로, 에이전트 수는 msgr_personal_room_cap
  if new.member_kind <> 'user' or nu >= 2 then raise exception 'msgr_dm_pair_only'; end if;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.msgr_crew_join(ch uuid, crew uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare me uuid := auth.uid(); c public.msgr_channels; cr public.msgr_crews; tier text; in_room boolean; host boolean; company boolean;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch and archived_at is null;
  if c.id is null then raise exception 'msgr_no_channel' using errcode = '22023'; end if;
  select * into cr from public.msgr_crews where id = crew;
  if cr.id is null or cr.org_id is distinct from c.org_id or cr.status <> 'active' then raise exception 'msgr_bad_member' using errcode = '22023'; end if; -- 개인 방은 개인 크루만(둘 다 NULL)
  if exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'crew' and m.member_id = crew) then return 'already'; end if;
  tier := public.msgr_crew_tier(crew);
  if c.personal_crews = 'blocked' and tier is distinct from 'company' then raise exception 'msgr_channel_personal_blocked' using errcode = '42501'; end if;
  in_room := exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = me);
  host := public.msgr_is_channel_host(ch);
  -- 조직 서비스 계정 소유의 상주 크루만 "회사 에이전트"다(msgr_crew_is_company — 20260918130000 정본). tier는 봇도 company로 보지만 봇의 주인은 연결한 멤버다.
  company := public.msgr_crew_is_company(crew); -- 크루 조직 = 채널 조직은 위에서 이미 확인(msgr_bad_member)

  if c.kind = 'dm' then -- 채팅: 참여자가 자기 에이전트만. 결재자(방을 연 사람)는 바로, 다른 참여자는 결재자에게 요청한다.
    if not in_room or cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
    if public.msgr_dm_approver(ch) = me then
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'crew', crew, me);
      return 'joined';
    end if;
  else
    if not company and cr.owner_user_id <> me then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 남의 에이전트는 방장이어도 못 데려온다 — 그 주인이 요청한다
    if host then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if;
    if not in_room then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 채널에 참여한 사람만 데려온다
    if tier is distinct from 'company' and c.personal_crews = 'allowed' then perform public.msgr_crew_join_apply(ch, crew, me); return 'joined'; end if; -- '누구나 데려옴' = 방장의 사전 승인
  end if;
  -- 결재 요청(채널 = 방장, 채팅 = 결재자). 방금 거절된 요청은 한 시간 동안 다시 보내지 않는다(결재자 알림함이 같은 요청으로 차지 않게 — 검수 M-4)
  if exists (select 1 from public.msgr_channel_crew_requests q where q.channel_id = ch and q.crew_id = crew and q.status = 'rejected' and q.decided_at > now() - interval '1 hour') then
    raise exception 'msgr_request_recently_rejected' using errcode = '22023';
  end if;
  insert into public.msgr_channel_crew_requests (channel_id, crew_id, requested_by) values (ch, crew, me)
    on conflict (channel_id, crew_id) where status = 'pending' do nothing;
  return 'requested';
end $function$;

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
            when src.author_kind='crew' then coalesce((select display_name from msgr_crews where id=src.crew_id),'크루') else null end;
  -- 검수 M-1(2026-09-27 밤, 3차 재검수) — 원글 작성자가 지금 동의 상태로 보이지 않으면(거부·철회·전환 기간 지난 미응답)
  -- 일지에 그 사람 원문을 적지 않는다. 크루 글(src.author_kind='crew')은 동의 판정 대상이 아니다(AI 산출물).
  src_author:=case when src.author_kind='user' then src.author_user_id else null end;
  src_visible:=src_author is null or public.msgr_ai_consent_visible(src_author);
  quote_body:=case when not src_visible then '(비공개 / private)' else left(regexp_replace(coalesce(src.body,''),'\s+',' ','g'),160) end;
  day:=to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD'); -- ponytail: 조직 시간대 설정이 생기면 그 값으로
  line:='- '||to_char(now() at time zone 'Asia/Seoul','HH24:MI')||' · **'||coalesce(crew_name,'크루')||'**'
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

CREATE OR REPLACE FUNCTION public.msgr_instruct_check(crew uuid, author uuid, channel uuid DEFAULT NULL::uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      -- 개인 크루(2026-09-30): 기본은 주인만. 주인이 허용을 넓혀도 그 방에 있는 사람만 — 조직의 "방 안이면 누구나"는 적용하지 않는다.
      when c.org_id is null then case
        when c.owner_user_id = author then 'ok'
        when channel is null or ch.id is null or ch.org_id is not null or not public.msgr_crew_in_channel(channel, c.id) then 'crew_allow'
        when not exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'user' and cm.member_id = author) then 'crew_allow'
        when c.allow = 'all' then 'ok'
        when c.allow = 'list' and author = any (c.allow_users) then 'ok'
        else 'crew_allow' end
      when channel is not null and ch.personal_crews = 'read_only'
           and not public.msgr_crew_is_company(c.id) then 'channel_policy'
      when channel is not null and public.msgr_crew_in_channel(channel, c.id)
           and m.user_id is not null and (m.expires_at is null or m.expires_at > now())
           and ((ch.kind = 'public' and m.role in ('owner', 'admin', 'member') and not (author = any (ch.excluded_user_ids)))
                or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'user' and cm.member_id = author)) then 'ok'
      when c.owner_user_id = author then 'ok'
      when c.allow = 'owner' then 'crew_allow'
      when c.allow = 'list' then case when author = any (c.allow_users) and m.user_id is not null then 'ok' else 'crew_allow' end
      else case when m.user_id is not null then 'ok' else 'crew_allow' end
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_channels ch on ch.id = channel
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$function$;

CREATE OR REPLACE FUNCTION public.msgr_delivery_allowed(p_crew uuid, p_source bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare s msgr_messages; r msgr_messages; c msgr_crews; ch msgr_channels; sender uuid;
begin
 select * into s from msgr_messages where id=p_source;
 select * into ch from msgr_channels where id=s.channel_id;
 select * into c from msgr_crews where id=p_crew;
 select * into r from msgr_messages where id=case when s.author_kind='user' then coalesce(s.thread_root,s.id) else s.thread_root end;
 if not coalesce(msgr_delivery_target(p_crew,p_source),false) or c.id is null or c.status<>'active' or c.org_id is distinct from ch.org_id or ch.archived_at is not null or msgr_org_locked(ch.org_id)
 or r.id is null or r.author_kind<>'user' or r.deleted_at is not null or r.channel_id is distinct from ch.id then return false; end if;
 if ch.org_id is null then -- 개인 방(2026-09-30): 조직 멤버십 대신 크루 주인과 뿌리 작성자가 그 방의 사람이어야 한다. 차단한 1:1은 더 전달하지 않는다.
   if not exists(select 1 from msgr_channel_members where channel_id=ch.id and member_kind='user' and member_id=c.owner_user_id)
   or not exists(select 1 from msgr_channel_members where channel_id=ch.id and member_kind='user' and member_id=r.author_user_id)
   or (c.owner_user_id<>r.author_user_id and exists(select 1 from msgr_friends f where f.a=least(c.owner_user_id,r.author_user_id) and f.b=greatest(c.owner_user_id,r.author_user_id) and f.status='blocked')) then return false; end if;
 elsif not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=c.owner_user_id and removed_at is null and (expires_at is null or expires_at>now()))
 or not exists(select 1 from msgr_org_members where org_id=c.org_id and user_id=r.author_user_id and removed_at is null and (expires_at is null or expires_at>now())) then return false; end if;
 if s.author_kind='user' then sender:=s.author_user_id;
 else select owner_user_id into sender from msgr_crews where id=s.crew_id and org_id is not distinct from c.org_id and status='active'; end if;
 if sender is null or not coalesce(msgr_can_instruct(c.id,sender,ch.id),false) or not coalesce(msgr_can_instruct(c.id,r.author_user_id,ch.id),false) then return false; end if;
 if not msgr_crew_in_channel(ch.id,c.id) then return false; end if;
 if ch.kind='dm' and exists(select 1 from msgr_work_runs w where w.root_message_id=r.id and w.channel_id=ch.id and (w.status<>'running' or s.id<coalesce(w.last_resume_message_id,0))) then return false; end if;
 if s.author_kind='crew' and (select count(*) from msgr_messages where thread_root=r.id and channel_id=ch.id and author_kind='crew' and kind='text' and id>coalesce(msgr_work_round_start(r.id,ch.id),0))>=10 then return false; end if;
 return true;
end $function$;

-- 개인 방은 크루 1:1에서만 모든 글이 크루에게 간다 — 친구가 있는 개인 방은 @로 부를 때만(주인의 모든 글에 답하지 않게, 2026-09-30)
CREATE OR REPLACE FUNCTION public.msgr_delivery_target(p_crew uuid, p_source bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 select exists(select 1 from msgr_messages s join msgr_channels ch on ch.id=s.channel_id where s.id=p_source and s.deleted_at is null and s.kind='text'
 and (msgr_to_mentioned(s.mentions,p_crew)
 or (s.author_kind='user' and ch.kind='dm' and (ch.org_id is not null or ch.personal_pair like 'crew:%') and not msgr_has_to(s.mentions) and not exists(select 1 from jsonb_array_elements(s.mentions) cc where cc->>'kind'='crew' and cc->>'id'=p_crew::text and cc->>'role'='cc') and msgr_crew_in_channel(ch.id,p_crew))
 or (s.author_kind='user' and ch.kind<>'dm' and exists(select 1 from msgr_messages p where p.id=s.reply_to and p.channel_id=ch.id and p.crew_id=p_crew)))
 and (s.author_kind='user' or (s.author_kind='crew' and s.crew_id<>p_crew and s.meta->>'disposition' is distinct from 'done')))
$function$;

CREATE OR REPLACE FUNCTION public.msgr_crew_inbox(p_ws text, p_crew uuid, p_after bigint DEFAULT 0, p_limit integer DEFAULT 100)
 RETURNS SETOF msgr_messages
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c msgr_crews;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 if c.id is null then raise exception 'msgr_execution_forbidden' using errcode='42501'; end if;
 update msgr_crews set dm_delivery_protocol=1 where id=c.id and dm_delivery_protocol is distinct from 1; -- 같은 값을 폴마다 다시 쓰지 않는다(DB 위생 2026-09-30)
 if c.org_id is null then -- 개인 크루: 조직 글 스캔 대신 이 크루가 들어간 방만(참여 행 기반 — org_id IS NULL 전역 스캔 금지)
   return query select m.* from msgr_channel_members cm join msgr_messages m on m.channel_id=cm.channel_id join msgr_channels ch on ch.id=m.channel_id
    where cm.member_kind='crew' and cm.member_id=c.id and ch.org_id is null and m.id>p_after and m.deleted_at is null
      and (msgr_can_read_channel(ch.id) or msgr_delivery_allowed(c.id,m.id)) order by m.id limit greatest(1,least(p_limit,200));
   return;
 end if;
 return query select m.* from msgr_messages m join msgr_channels ch on ch.id=m.channel_id where m.org_id=c.org_id and m.id>p_after and m.deleted_at is null
 and (msgr_can_read_channel(ch.id) or (ch.kind='dm' and (msgr_delivery_allowed(c.id,m.id) or msgr_cc_delivery_allowed(c.id,m.id)))) order by m.id limit greatest(1,least(p_limit,200));
end $function$;

CREATE OR REPLACE FUNCTION public.msgr_dm_candidates(p_channel uuid)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
 if auth.uid() is null or not coalesce(msgr_can_write_channel(p_channel),false) or not exists(select 1 from msgr_channels where id=p_channel and kind='dm') then raise exception 'msgr_forbidden' using errcode='42501'; end if;
 return query select jsonb_build_object('id',c.id,'display_name',c.display_name,'role_text',c.role_text,'slug',c.slug,'owner_user_id',c.owner_user_id,'ws_id',c.ws_id,'delivery_protocol',c.dm_delivery_protocol,'delivery_ready',true)
 from msgr_crews c join msgr_channels ch on ch.id=p_channel and ch.org_id=c.org_id
 where c.status='active' and msgr_can_instruct(c.id,auth.uid(),p_channel)
 and exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()))
 union all -- 개인 방(2026-09-30): 이 방의 크루 참여 행에서 시작한다 — org IS NULL 크루 전체를 훑고 함수를 부르면 크루 수에 비례해 느려진다(분리 검수 H1)
 select jsonb_build_object('id',c.id,'display_name',c.display_name,'role_text',c.role_text,'slug',c.slug,'owner_user_id',c.owner_user_id,'ws_id',c.ws_id,'delivery_protocol',c.dm_delivery_protocol,'delivery_ready',true)
 from msgr_channels ch join msgr_channel_members cm on cm.channel_id=ch.id and cm.member_kind='crew' join msgr_crews c on c.id=cm.member_id and c.org_id is null
 where ch.id=p_channel and ch.org_id is null and c.status='active' and not (c.id = any (ch.excluded_crew_ids)) and msgr_can_instruct(c.id,auth.uid(),p_channel)
 and exists(select 1 from msgr_channel_members o where o.channel_id=ch.id and o.member_kind='user' and o.member_id=c.owner_user_id);
end $function$;

CREATE OR REPLACE FUNCTION public.msgr_dm_message_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare ch msgr_channels; r msgr_messages; s msgr_messages; dest uuid; x jsonb; sender uuid;
begin
 select * into ch from msgr_channels where id=new.channel_id;
 if ch.kind<>'dm' then return new; end if;
 if ch.archived_at is not null or msgr_org_locked(ch.org_id) then raise exception 'msgr_not_allowed'; end if;
 if pg_trigger_depth()<=1 then new.meta:=coalesce(new.meta,'{}')-'relay'-'relay_to'-'relay_capped'; end if;
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
   if not exists(select 1 from msgr_crews c where c.id=dest and c.org_id is not distinct from ch.org_id and c.status='active'
     and msgr_can_instruct(c.id,sender,ch.id) and msgr_can_instruct(c.id,coalesce(r.author_user_id,new.author_user_id),ch.id)
     and (case when ch.org_id is null -- 개인 방: 방에 없는 크루는 부르지 못한다(전달로 조직 없는 방이 새로 생기지 않게)
       then msgr_crew_in_channel(ch.id,c.id) and exists(select 1 from msgr_channel_members cm where cm.channel_id=ch.id and cm.member_kind='user' and cm.member_id=c.owner_user_id)
       else exists(select 1 from msgr_org_members m where m.org_id=c.org_id and m.user_id=c.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now())) end)) then raise exception 'msgr_not_allowed'; end if;
 end loop;
 return new;
end $function$;

-- AI 동의 판정 도우미(2026-09-30): 개인 방은 명시적 동의(consent_at)만 인정한다 — 조직 전환 기간의 "아직 안 물어봄 = 동의"를 개인 방 친구 글에 쓰면
-- 한 번도 승인하지 않은 친구의 글이 남의 에이전트 제공자로 나간다(분리 검수 H3). 조직은 종전 판정(msgr_ai_consent_visible) 그대로.
create or replace function public.msgr_ai_consent_ok_for(p_user uuid, p_personal boolean)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select case when p_personal then exists (select 1 from public.msgr_ai_consent where user_id = p_user and consent_at is not null)
              else public.msgr_ai_consent_visible(p_user) end
$$;
revoke all on function public.msgr_ai_consent_ok_for(uuid, boolean) from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.msgr_crew_context(p_ws text, p_crew uuid, p_source bigint, p_channel uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare c msgr_crews; s msgr_messages; r msgr_messages; ch msgr_channels; ctx jsonb; peers jsonb; actor uuid; r_json jsonb; s_json jsonb; s_attachments_visible boolean; personal boolean;
begin
 select * into c from msgr_crews where id=p_crew and owner_user_id=auth.uid() and ws_id=p_ws and status='active';
 select * into s from msgr_messages where id=p_source and channel_id=p_channel;
 if c.id is null or s.id is null or not (msgr_delivery_allowed(p_crew,p_source) or msgr_cc_delivery_allowed(p_crew,p_source)) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into ch from msgr_channels where id=p_channel;
 personal := ch.org_id is null;
 if ch.kind<>'dm' and not msgr_can_read_channel(p_channel) then raise exception 'msgr_execution_source_forbidden' using errcode='42501'; end if;
 select * into r from msgr_messages where id=coalesce(s.thread_root,s.id);
 actor:=case when s.author_kind='user' then s.author_user_id else (select owner_user_id from msgr_crews where id=s.crew_id) end;
 -- 검수 H1: 뿌리가 동의하지 않은 사람의 글이면 본문을 비운다(구조는 유지 — id 연결이 깨지지 않게).
 r_json := case when r.author_kind='user' and not public.msgr_ai_consent_ok_for(r.author_user_id, personal)
   then to_jsonb(r) || jsonb_build_object('body','') else to_jsonb(r) end;
 -- 검수 HIGH-1(2차 재검수): 뿌리뿐 아니라 이번 배달 글(source) 자체도 동의 판정을 적용한다 — 구조는 유지하고 본문·첨부만 뺀다.
 s_json := case when s.author_kind='user' and not public.msgr_ai_consent_ok_for(s.author_user_id, personal)
   then to_jsonb(s) || jsonb_build_object('body','') else to_jsonb(s) end;
 s_attachments_visible := s.author_kind<>'user' or public.msgr_ai_consent_ok_for(s.author_user_id, personal);
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'slug',p.slug,'display_name',p.display_name,'role_text',p.role_text,'owner_user_id',p.owner_user_id,'ws_id',p.ws_id,'hosting',p.hosting,'allow',p.allow,'allow_users',p.allow_users,'work_protocol',p.work_protocol,'dm_delivery_protocol',p.dm_delivery_protocol)),'[]') into peers from msgr_crews p where p.org_id=c.org_id and p.status='active'
 and msgr_can_instruct(p.id,r.author_user_id,p_channel) and msgr_can_instruct(p.id,c.owner_user_id,p_channel)
 and (case when ch.kind='dm' then (msgr_crew_in_channel(p_channel,p.id) or p.dm_delivery_protocol>=1) else msgr_crew_in_channel(p_channel,p.id) end)
 and exists(select 1 from msgr_org_members m where m.org_id=p.org_id and m.user_id=p.owner_user_id and m.removed_at is null and (m.expires_at is null or m.expires_at>now()));
 -- 개인 방(2026-09-30): 동료는 이 방의 크루 참여 행에서만(org IS NULL 크루 전체 스캔 금지 — 분리 검수 H1). 조직 쿼리는 org_id=NULL이라 빈다.
 if ch.org_id is null then
   select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'org_id',p.org_id,'slug',p.slug,'display_name',p.display_name,'role_text',p.role_text,'owner_user_id',p.owner_user_id,'ws_id',p.ws_id,'hosting',p.hosting,'allow',p.allow,'allow_users',p.allow_users,'work_protocol',p.work_protocol,'dm_delivery_protocol',p.dm_delivery_protocol)),'[]') into peers
     from msgr_channel_members cm join msgr_crews p on p.id=cm.member_id and p.org_id is null and p.status='active'
    where cm.channel_id=p_channel and cm.member_kind='crew' and msgr_crew_in_channel(p_channel,p.id)
      and msgr_can_instruct(p.id,r.author_user_id,p_channel) and msgr_can_instruct(p.id,c.owner_user_id,p_channel)
      and exists(select 1 from msgr_channel_members o where o.channel_id=p_channel and o.member_kind='user' and o.member_id=p.owner_user_id);
 end if;
 -- 검수 H1: 사람 글인데 동의하지 않았으면 문맥에서 뺀다(크루 글은 그대로 — AI 산출물이라 별개).
 select coalesce(jsonb_agg(to_jsonb(h) order by h.id),'[]') into ctx from (
 select m.* from msgr_messages m where m.channel_id=p_channel and m.kind='text' and m.deleted_at is null
 and (case when ch.kind='dm' and not msgr_crew_in_channel(ch.id,c.id) then (m.id=r.id or m.thread_root=r.id) else (m.id<s.id or (m.reply_to=s.id and msgr_to_mentioned(s.mentions,m.crew_id))) end)
 and (m.author_kind<>'user' or public.msgr_ai_consent_ok_for(m.author_user_id, personal))
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
end $function$;


-- 5-0) 무료 한도 유예(유건 2026-09-30 "2주 동안은 Pro처럼"): 기존 사용자는 오늘부터 2주(설정 free_limits_grace_until — 10/14 끝까지),
--      신규 가입자는 가입부터 2주. 둘 중 늦은 쪽까지 한도를 걸지 않는다. 날짜는 설정 값만 고치면 바뀐다(마이그레이션 불필요).
insert into public.msgr_settings (key, value) values ('free_limits_grace_until', '2026-10-15T00:00:00+09:00') on conflict (key) do nothing;
create or replace function public.msgr_free_grace(p_uid uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select now() < greatest(
    coalesce((select value::timestamptz from public.msgr_settings where key = 'free_limits_grace_until'), '-infinity'::timestamptz),
    coalesce((select u.created_at + interval '14 days' from auth.users u where u.id = p_uid), '-infinity'::timestamptz))
$$;
revoke all on function public.msgr_free_grace(uuid) from public, anon, authenticated;

-- 5) 인원 한도(무료 플랜, 유건 2026-09-30) — 참여 행이 들어가는 모든 길(msgr_crew_join·요청 승인·그룹 만들기)을 한 곳에서 막는다.
--    사람이 둘 이상인 개인 방은 사람+에이전트 4명까지. 혼자 쓰는 방은 에이전트 제한 없음. 넣는 사람이 Pro면 제한 없음.
--    짝 방(1:1)에 사람을 다시 넣는 것(나갔다 돌아오기)은 세지 않는다 — 원래 있던 사람이 돌아오지 못하게 되면 안 된다.
create or replace function public.msgr_personal_room_cap()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare ch public.msgr_channels; nu int; nc int; pro boolean;
begin
  select * into ch from public.msgr_channels where id = new.channel_id;
  if ch.id is null or ch.org_id is not null then return new; end if;
  if new.member_kind = 'user' and ch.personal_pair is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_room_cap:' || new.channel_id::text)); -- 두 기기가 동시에 넣어도 한도를 넘지 않게(분리 검수 M5)
  select count(*) filter (where m.member_kind = 'user'),
         count(*) filter (where m.member_kind = 'crew' and exists (select 1 from public.msgr_crews c where c.id = m.member_id and c.status = 'active')) -- 없어진 크루의 남은 참여 행은 세지 않는다
    into nu, nc from public.msgr_channel_members m where m.channel_id = new.channel_id;
  if new.member_kind = 'user' then nu := nu + 1; else nc := nc + 1; end if;
  if nu >= 2 and nu + nc > 4 then
    -- 한도에 걸릴 때만 요금제를 묻는다(동적 호출 — 요금제 마이그레이션이 없는 테스트 DB에서도 이 트리거가 깨지지 않게)
    pro := public.msgr_free_grace(coalesce(auth.uid(), new.added_by)); -- 2주 유예 중이면 Pro처럼
    if not pro then execute 'select coalesce(public.is_pro_for($1), false)' into pro using coalesce(auth.uid(), new.added_by); end if;
    if not pro then raise exception 'msgr_room_limit' using errcode = '22023', hint = '무료 플랜은 한 대화방에 나를 포함해 4명(에이전트 포함)까지입니다'; end if;
  end if;
  return new;
end $$;
drop trigger if exists msgr_personal_room_cap on public.msgr_channel_members;
create trigger msgr_personal_room_cap before insert on public.msgr_channel_members for each row execute function public.msgr_personal_room_cap();

-- 6) 개인 공간에서 쓰는 새 함수
-- 내 개인 크루와 1:1 — 한 크루에 한 방(personal_pair 'crew:<id>', 사람 짝 키 uuid:uuid와 겹치지 않는다). 주인만 연다.
create or replace function public.msgr_dm_personal_crew(crew uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); ch uuid; key text := 'crew:' || crew::text;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr_crews c where c.id = crew and c.owner_user_id = me and c.org_id is null and c.status = 'active') then
    raise exception 'msgr_bad_member' using errcode = '22023';
  end if;
  select c.id into ch from public.msgr_channels c where c.personal_pair = key for update;
  if ch is null then
    insert into public.msgr_channels (org_id, kind, name, created_by, personal_pair) values (null, 'dm', 'dm', me, key)
      on conflict (personal_pair) where personal_pair is not null do nothing returning id into ch;
    if ch is null then select c.id into ch from public.msgr_channels c where c.personal_pair = key for update; end if;
  end if;
  update public.msgr_channels set archived_at = null where id = ch and archived_at is not null;
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by)
    select ch, v.k, v.id, me from (values ('user', me), ('crew', crew)) v(k, id)
     where not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = v.k and m.member_id = v.id);
  return ch;
end $$;
revoke all on function public.msgr_dm_personal_crew(uuid) from public, anon;
grant execute on function public.msgr_dm_personal_crew(uuid) to authenticated;

-- 개인 공간 화면이 쓰는 크루: 내 개인 크루 + 내가 들어간 개인 방의 크루(남의 것 포함 — 표시용 열만, 허용 목록·ws는 싣지 않는다).
-- 앱은 "내 에이전트"·"추가 후보"를 owner_user_id = 나로 거른다(남의 행은 select 정책으로도 안 보인다).
create or replace function public.msgr_personal_room_crews()
returns table(id uuid, org_id uuid, slug text, display_name text, role_text text, owner_user_id uuid, hosting text, status text,
              avatar_url text, face jsonb, department text, last_seen_at timestamptz, commands jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.org_id, c.slug, c.display_name, c.role_text, c.owner_user_id, c.hosting, c.status, c.avatar_url, c.face, c.department,
         -- 접속: 방에 들지 않은 개인 행은 심박을 쓰지 않는다 — 같은 크루(주인·회사·slug)의 조직 행 시각을 빌린다(쓰기 0)
         greatest(c.last_seen_at, (select max(o.last_seen_at) from public.msgr_crews o where o.owner_user_id = c.owner_user_id and o.ws_id = c.ws_id and o.slug = c.slug and o.org_id is not null)),
         case when c.owner_user_id = auth.uid() then c.commands else null end
    from public.msgr_crews c
   where c.org_id is null and c.status <> 'available'
     and (c.owner_user_id = auth.uid()
          or exists (select 1 from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = ch.id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where cm.member_kind = 'crew' and cm.member_id = c.id))
$$;
revoke all on function public.msgr_personal_room_crews() from public, anon;
grant execute on function public.msgr_personal_room_crews() to authenticated;

-- 게이트웨이의 동의 확인(개인 방): 이 방에 내 크루가 있고, 작성자가 그 방 사람이며, 작성자가 AI 처리에 동의했을 때.
create or replace function public.msgr_personal_ai_consent_ok(p_channel uuid, p_author uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_channels ch where ch.id = p_channel and ch.org_id is null)
     and exists (select 1 from public.msgr_channel_members cm join public.msgr_crews c on c.id = cm.member_id
                  where cm.channel_id = p_channel and cm.member_kind = 'crew' and c.owner_user_id = auth.uid() and c.status = 'active')
     and exists (select 1 from public.msgr_channel_members cm where cm.channel_id = p_channel and cm.member_kind = 'user' and cm.member_id = p_author)
     and public.msgr_ai_consent_ok_for(p_author, true) -- 명시적 동의만(분리 검수 H3)
$$;
revoke all on function public.msgr_personal_ai_consent_ok(uuid, uuid) from public, anon;
grant execute on function public.msgr_personal_ai_consent_ok(uuid, uuid) to authenticated;

drop function if exists public.msgr_dm_personal_list(boolean);
CREATE OR REPLACE FUNCTION public.msgr_dm_personal_list(include_groups boolean DEFAULT false)
 RETURNS TABLE(channel_id uuid, other_user_id uuid, last_at timestamp with time zone, last_body text, name text, members jsonb, is_group boolean, created_by uuid, crew_dm uuid, crews jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select c.id,
           (select m.member_id from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid() order by m.added_at, m.member_id limit 1),
           (select max(x.created_at) from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null),
           (select x.body from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1),
           c.name,
           (select coalesce(jsonb_agg(jsonb_build_object('id', m.member_id, 'name', p.display_name) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m left join public.msgr_profiles p on p.user_id = m.member_id
             where m.channel_id = c.id and m.member_kind = 'user'),
           c.personal_pair is null,
           c.created_by,
           case when c.personal_pair like 'crew:%' then substr(c.personal_pair, 6)::uuid end,
           (select coalesce(jsonb_agg(jsonb_build_object('id', cr.id, 'name', cr.display_name, 'owner_user_id', cr.owner_user_id) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m join public.msgr_crews cr on cr.id = m.member_id
             where m.channel_id = c.id and m.member_kind = 'crew')
      from public.msgr_channels c
     where c.org_id is null and c.kind = 'dm' and c.archived_at is null
       and (include_groups or (c.personal_pair is not null and c.personal_pair not like 'crew:%')) -- 옛 앱은 크루 1:1을 모른다(dm:?로 그려진다)
       and exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by 3 desc nulls last
$function$;
revoke all on function public.msgr_dm_personal_list(boolean) from public, anon;
grant execute on function public.msgr_dm_personal_list(boolean) to authenticated;

CREATE OR REPLACE FUNCTION public.msgr_work_heartbeat(p_crews uuid[])
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  update public.msgr_crews set work_protocol=1 where id=any(p_crews) and owner_user_id=auth.uid() and status='active' and work_protocol is distinct from 1; -- 15초마다 같은 값을 다시 쓰던 것(DB 위생, 분리 검수 M3)
$function$;

notify pgrst, 'reload schema';
