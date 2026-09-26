-- 조직 무료 기간 30일 + 유료 구독 자리. 확정 경위(모두 2026-09-26~27, 총괄 정리 — 아래가 최종, 이전 초안의 "보류" 문구는 없앤다):
--   1) 새 조직은 만든 시각부터 30일 무료, 기존 조직은 이 마이그레이션 적용 시각부터 30일(trial_ends_at 컬럼 기본값).
--   2) 무료 기간이 끝나고 결제도 없는 조직(entitled=false)은 "크루(에이전트)에게 일을 맡기는 것"만 멈춘다.
--      사람끼리 대화·기존 기록·파일·초대·채널은 전부 그대로 — **좌석 3명·공개 채널 1개로 되돌아가는 한도 복귀는
--      채택하지 않았다**(2026-09-27 총괄 확정 — "무료 한도로 복귀" 선택지를 유건님이 고르지 않음). 그래서:
--        - 공개 채널 수 한도 게이트(msgr_channel_gate)는 폐기한다 — 무료 조직도 채널 수 제한이 없다.
--        - 좌석 한도(msgr_member_seat_gate)는 이제 무료 기간·자격과 무관하다. **plan='team'(기존에 좌석을 산 조직)만
--          그 좌석 수(entitlements.seats)를 그대로 강제**한다(라이브 확인 2026-09-27: team 2곳, 회귀 방지). free 조직은
--          좌석 한도가 아예 없다.
--   3) 결제(paid_until)는 웹 결제 연동이 붙기 전까지 열과 판정 함수만 만든다(자리만). service_role 전용 — 웹훅이 채운다.
--   4) 자격 판정 msgr_org_entitled(org) = 무료 기간 중 OR paid_until 미래 OR msgr_org_plan(org)='team'(라이브 team 2곳
--      보호 — 웹 결제 연동 전까지 회귀 금지). 크루 턴 차단에만 쓰이고 좌석·채널 한도에는 더 이상 쓰이지 않는다(위 2번).
--   5) 앱 안 쿠폰 입력 화면은 만들지 않는다(App Store 3.1.1). 연장은 service_role 전용 msgr_extend_trial 함수로만.
--   6) 크루 턴 차단은 게이트웨이(1차)와 msgr_message_entitlement_gate 트리거(2차, crew 저자의 text·approval_card만,
--      system 안내·사람 메시지·개인 공간은 예외)로 이중화한다.
--   7) msgr_org_entitled·msgr_org_trial_active는 그 조직 멤버(authenticated + msgr_is_member) 또는 auth.uid()가 없는
--      호출(서비스 계정·엣지 펑션·게이트웨이 내부 트리거 경로)만 실제 값을 받는다 — 비회원 authenticated는 null(2026-09-27 L3).
-- DB 위생(CLAUDE.md): 새 주기 작업·폴링 없음. 한도 판정은 기존 트리거 안에서 시각·플랜 비교만 추가.

-- ── 무료 기간 열: 새 조직은 생성 시각 + 30일(컬럼 기본값), 이미 있던 조직은 이 마이그레이션 적용 시각 + 30일(ADD COLUMN 백필) ──
alter table public.msgr_org_entitlements
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '30 days');
-- ── 결제 기간: 웹 결제 연동(Lemon Squeezy 등)이 채울 자리 — 이번 범위는 열과 판정 함수만. 관리자·앱은 쓰기 권한이 없다(service_role만).
alter table public.msgr_org_entitlements
  add column if not exists paid_until timestamptz;

-- ── 무료 기간 판정 — 크루 턴 게이트가 참조(좌석·채널 한도는 더 이상 쓰지 않는다). ──
create or replace function public.msgr_org_trial_active(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when auth.uid() is not null and not public.msgr_is_member(org) then null -- L3: 비회원 authenticated는 값을 못 받는다(auth.uid() null = 서비스 계정·내부 트리거 경로는 그대로 통과)
      else coalesce((select e.trial_ends_at > now() from public.msgr_org_entitlements e where e.org_id = org), false)
      end
$$;

-- ── 자격 판정 단일 관문 — 무료 기간 중 OR 결제 기간 중 OR 레거시 team 플랜. 크루 턴 게이트(게이트웨이·DB 트리거)가 이 함수만 부른다. ──
-- 라이브 읽기 확인(2026-09-26, 총괄): msgr_org_entitlements에 team 2건, 둘 다 ls_status null(정상 결제 중 — 결제 실패면 msgr_org_locked가 따로 잠금).
--   이 두 조직은 이미 유료 고객이라 웹 결제 연동 전까지도 크루 작업이 멈추면 안 된다 — plan='team'도 자격으로 본다. 나중에 웹 결제가 붙으면 정리.
create or replace function public.msgr_org_entitled(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when auth.uid() is not null and not public.msgr_is_member(org) then null -- L3: 위와 같은 규칙
      else public.msgr_org_trial_active(org)
          or coalesce((select e.paid_until > now() from public.msgr_org_entitlements e where e.org_id = org), false)
          or public.msgr_org_plan(org) = 'team'
      end
$$;

-- ── 자격 종료 시각 표지 — 안내 1회 키에만 쓴다(멤버·서비스 계정 전용, 값 자체는 민감하지 않지만 같은 규칙으로 통일). ──
--   trial_ends_at·paid_until 중 더 늦은 시각 — 연장·결제로 이 값이 바뀌면 다음에 다시 미자격이 될 때 새 안내가 나간다(2026-09-27 L2).
create or replace function public.msgr_org_entitlement_marker(org uuid) returns timestamptz
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when auth.uid() is not null and not public.msgr_is_member(org) then null
      else (select greatest(e.trial_ends_at, coalesce(e.paid_until, '-infinity'::timestamptz)) from public.msgr_org_entitlements e where e.org_id = org)
      end
$$;

-- ── 좌석 게이트 재정의 — 이제 무료 기간·결제와 무관하다. plan='team'(좌석을 산 조직)만 그 좌석 수를 강제한다(2026-09-27 총괄 확정). ──
create or replace function public.msgr_member_seat_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare lim int; n int; gseats boolean;
begin
  if new.removed_at is not null then return new; end if;
  if tg_op = 'UPDATE' and old.removed_at is null then return new; end if; -- 활성→활성(역할 변경)은 좌석 불변
  if public.msgr_org_plan(new.org_id) <> 'team' then return new; end if; -- 무료 조직은 좌석 한도가 없다 — "한도 복귀" 미채택(2026-09-27)
  select coalesce(p.guest_seats, false) into gseats from public.msgr_org_policies p where p.org_id = new.org_id;
  gseats := coalesce(gseats, false);
  if new.role = 'guest' and not gseats then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_seats:' || new.org_id::text));
  select coalesce(e.seats, 0) into lim from public.msgr_org_entitlements e where e.org_id = new.org_id;
  if lim is null then lim := 0; end if;
  select count(*) into n from public.msgr_org_members where org_id = new.org_id and removed_at is null and user_id <> new.user_id
     and (role <> 'guest' or gseats) and (expires_at is null or expires_at > now());
  if n >= lim then raise exception 'msgr_seat_limit' using detail = format('%s/%s', n, lim); end if;
  return new;
end $$;

-- ── 채널 수 한도 게이트 폐기 — 무료 조직도 공개 채널 수 제한이 없다(2026-09-27 총괄 확정, M8·M2). ──
drop trigger if exists msgr_channel_gate on public.msgr_channels;
drop function if exists public.msgr_channel_gate();

do $$ declare f text; begin
  foreach f in array array['msgr_org_trial_active(uuid)', 'msgr_org_entitled(uuid)', 'msgr_org_entitlement_marker(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ── 크루 턴 DB 쪽 방어(2차 방어선) — 게이트웨이가 막지 못한 우회도 여기서 막는다. 'system' 안내는 예외(막히면 안내 자체가 안 나간다).
--    msgrNotifyPush(데스크톱 알림→메신저 1:1 미러)도 예외(2026-09-27 M5) — 크루가 "일을 맡은" 게 아니라 이미 일어난 일을
--    소유자 자신과의 1:1에 알리는 것뿐이다. client_msg_id 접두 nt:<그 크루id>: + reply_to·thread_root 둘 다 null인
--    모양으로 좁힌다(msgrNotifyPush의 실제 삽입 모양과 정확히 같음) — 이 좁힌 모양은 소유자 자신의 1:1에서만 의미가
--    있어(다른 사람 채널에는 이 크루로 못 쓴다 — RLS가 크루 글을 그 크루 소유자에게만 허용) 우회 통로가 되지 않는다. ──
create or replace function public.msgr_message_entitlement_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid;
begin
  if new.author_kind = 'crew' and new.kind in ('text', 'approval_card') then
    if new.client_msg_id like ('nt:' || new.crew_id::text || ':%') and new.reply_to is null and new.thread_root is null then return new; end if;
    select org_id into oid from public.msgr_channels where id = new.channel_id; -- 개인 공간(org_id null)은 대상 밖
    if oid is not null and not coalesce(public.msgr_org_entitled(oid), true) then raise exception 'msgr_org_unentitled'; end if; -- L3로 null이 와도(내부 SECURITY DEFINER 경로라 실제로는 auth.uid() 그대로 전달돼 값이 온다) 열어 둔다(fail-open)
  end if;
  return new;
end $$;
drop trigger if exists msgr_message_entitlement_gate on public.msgr_messages;
create trigger msgr_message_entitlement_gate before insert on public.msgr_messages for each row execute function public.msgr_message_entitlement_gate();

-- ── 무료 기간 연장 안내 — 기존 알림함(App.jsx Inbox v1 클라이언트 집계)에 얹는 새 소스. 서비스 계정 전용 쓰기. ──
create table if not exists public.msgr_org_announcements (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  kind text not null check (kind in ('trial_extended')),
  meta jsonb not null default '{}'::jsonb, -- trial_extended: {trial_ends_at, days, reason}
  created_at timestamptz not null default now()
);
create index if not exists msgr_org_announcements_org on public.msgr_org_announcements (org_id, created_at);
alter table public.msgr_org_announcements enable row level security;
create policy msgr_org_announcements_select on public.msgr_org_announcements for select to authenticated using (public.msgr_is_member(org_id));
grant select on public.msgr_org_announcements to authenticated;
grant all on public.msgr_org_announcements to service_role;

-- ── 무료 기간 연장 — service_role 전용(앱 안에는 쿠폰·코드 입력 화면을 두지 않는다). org=null이면 활성(삭제 안 된) 전 조직,
--    이때 plan='team' 조직은 무료 기간이 의미가 없으므로 대상에서 뺀다(2026-09-27 L4 — 공지도 안 나간다). ──
create or replace function public.msgr_extend_trial(p_org uuid, p_days int, p_reason text default null) returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record; new_end timestamptz;
begin
  if p_days is null or p_days <= 0 or p_days > 365 then raise exception 'msgr_extend_trial_days'; end if;
  for r in
    select e.org_id, greatest(coalesce(e.trial_ends_at, now()), now()) + make_interval(days => p_days) as ends
      from public.msgr_org_entitlements e
      join public.msgr_orgs o on o.id = e.org_id and o.deleted_at is null
     where (p_org is not null and e.org_id = p_org) or (p_org is null and public.msgr_org_plan(e.org_id) <> 'team')
  loop
    update public.msgr_org_entitlements set trial_ends_at = r.ends, updated_at = now() where org_id = r.org_id;
    insert into public.msgr_org_announcements (org_id, kind, meta)
      values (r.org_id, 'trial_extended', jsonb_build_object('trial_ends_at', r.ends, 'days', p_days, 'reason', p_reason));
    perform public.msgr_audit(r.org_id, 'org.trial_extend', 'org', r.org_id::text, jsonb_build_object('days', p_days, 'reason', p_reason, 'trial_ends_at', r.ends));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.msgr_extend_trial(uuid, int, text) from public;
revoke execute on function public.msgr_extend_trial(uuid, int, text) from anon, authenticated;
grant execute on function public.msgr_extend_trial(uuid, int, text) to service_role;

-- ── 외부 봇 경로(2026-09-27 M3) — msgr_bot_updates_before_work(20260926100000의 최종 정의 그대로 + 자격 확인 두 줄)를
--    재정의한다. 미자격 조직의 글은 실행 클레임(msgr_executions insert)보다 먼저 걸러 running으로 남는 실행 행이 생기지
--    않게 하고(continue로 그 후보만 건너뛴다), 채널당 1회만 안내를 남긴다(멱등 client_msg_id — 게이트웨이와 같은 규칙).
--    조직 자격은 루프 밖에서 한 번만 판정한다(봇은 조직 하나에 묶인다) — fail-open(coalesce ... true).
create or replace function public.msgr_bot_updates_before_work(token text,after_id bigint default 0,lim int default 50) returns setof jsonb
language plpgsql security definer set search_path=public,pg_temp as $function$
declare b msgr_bots; s msgr_messages; r msgr_messages; a uuid; won uuid; peers jsonb; ctx jsonb; n int:=0; lo bigint; actor uuid; ch msgr_channels; key text; cur bigint; entitled boolean;
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
 entitled:=coalesce(public.msgr_org_entitled(b.org_id),true); -- 조직 자격(2026-09-27 M3) — 봇은 조직 하나에 묶이므로 한 번만 판정, fail-open
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
 insert into msgr_messages(channel_id,author_kind,crew_id,kind,reply_to,thread_root,client_msg_id,body) values(ch.id,'crew',b.crew_id,'system',s.id,coalesce(s.thread_root,s.id),'unentitled:'||b.crew_id||':'||ch.id,'무료 기간이 끝나 이 조직의 크루 작업이 멈췄습니다. 조직 관리자에게 문의하세요. / The free period has ended, so crew work is paused for this organization. Contact your organization admin.') on conflict do nothing;
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
 -- 아무것도 못 준 전체 스캔(순서 대기로 중간 반환하지 않았다) — 커서를 앞으로 당긴다. 받을 글이 없는 봇은 ack가 없어 커서가 0에 머물러
 -- 매 스캔마다 조직 글 전체를 배달 판정 함수로 다시 훑었다(2026-09-23 라이브: 451건·봇 11개 동시 → 3초 초과, 픽업 중앙값 614초).
 -- 넘기는 것은 이 크루와 무관한 글뿐이다. 다음 앞에서 멈춘다(검수 #689 HIGH-1·MEDIUM-1):
 --   ① 최근 10분 안의 글(id 기준 — created_at을 과거로 넣어도 뒤의 대기 글을 건너뛰지 못한다)
 --   ② 이 크루를 겨냥할 수 있는 7일 안의 글 — 멘션(to·cc), 이 크루 글에 단 답글·그 스레드, 이 크루가 있는 1:1. 파견 재개·초대 결재 뒤 배달된다.
-- 재검수 #689: 넘길 끝은 10분 넘은 글까지만, 그런 글이 없으면 움직이지 않는다(진행 중 트랜잭션이 늦게 커밋하는 낮은 id를 건너뛰지 않게 — HIGH-2).
-- ponytail: created_at을 과거로 넣은 글(C)과 느린 커밋이 겹치면 여전히 넘길 수 있다 — 필요하면 created_at을 서버 시각으로 고정하는 트리거.
-- ②에서 크루 자기 글·지운 글·카드/시스템 글과 1:1의 크루 글은 겨냥이 아니다(1:1 자기 답글이 7일간 커서를 묶었다 — MEDIUM-4).
 if n=0 then
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



-- ── msgr_bot_finish 재정의(20260913122421의 최종 정의 그대로 + 자격 확인 3줄, 2026-09-27 M3) ──
--    이미 running으로 클레임된 실행이 회신 시점에 미자격으로 바뀐 드문 경합에서도, 삽입을 트리거가 막아 롤백되며
--    running이 그대로 남는 대신, 여기서 먼저 실행을 completed로 닫고 조용히 반환한다(이미 있는 "이미 완료" 반환과 같은 자리).
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
    return null; -- 미자격 — 실행 행을 닫아 running으로 남기지 않는다(2026-09-27 M3). 채널 안내는 게이트웨이·msgr_bot_updates_before_work가 이미 낸다.
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
      and (ch.kind = 'dm' or ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = channel and cm.member_kind = 'crew' and cm.member_id = c.id))) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', src_id, root_id, 'reply:' || b.crew_id::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
  return rid;
end $$;
revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;

-- ── 자동화(2026-09-27 M4) — msgr_automation_enqueue 재정의(20260913110000 그대로 + 자격 확인). 미자격 조직은 지시 글을
--    올리지 않는다(끄지 않고 다음 예약부터 다시 시도 — next_run_at은 그대로 전진). ──
create or replace function public.msgr_automation_enqueue(a public.msgr_automations, mode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_automation_runs; msg bigint;
begin
  insert into public.msgr_automation_runs(automation_id,scheduled_for,trigger,status)
    values(a.id,case when mode = 'schedule' then a.next_run_at else clock_timestamp() end,mode,'queued') returning * into r;
  if not public.msgr_automation_authorized(a.created_by,a.channel_id,a.crew_id) then
    update public.msgr_automation_runs set status = 'blocked',error = 'permission_revoked',finished_at = now() where id = r.id returning * into r;
    update public.msgr_automations set enabled = false,last_run_at = now(),last_status = 'blocked',updated_at = now() where id = a.id;
    return to_jsonb(r);
  end if;
  if not coalesce(public.msgr_org_entitled(a.org_id), true) then
    update public.msgr_automation_runs set status = 'blocked',error = 'unentitled',finished_at = now() where id = r.id returning * into r;
    update public.msgr_automations set last_run_at = now(),last_status = 'blocked',updated_at = now(),
      next_run_at = case when mode = 'schedule' then public.msgr_automation_next(a.schedule,now()) else next_run_at end where id = a.id;
    return to_jsonb(r);
  end if;
  insert into public.msgr_messages(org_id,channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
    values(a.org_id,a.channel_id,'user',a.created_by,'text',a.prompt,
      jsonb_build_array(jsonb_build_object('kind','crew','id',a.crew_id)), 'automation:' || r.id,
      jsonb_build_object('automation_id',a.id,'automation_run_id',r.id,'automation_title',a.title,'scheduled_for',r.scheduled_for)) returning id into msg;
  update public.msgr_automation_runs set message_id = msg where id = r.id returning * into r;
  update public.msgr_automations set last_run_at = now(),last_message_id = msg,last_status = 'queued',updated_at = now(),
    next_run_at = case when mode = 'schedule' then public.msgr_automation_next(a.schedule,now()) else next_run_at end where id = a.id;
  return to_jsonb(r);
end $$;

-- ── msgr_automation_terminal_message 재정의(20260913110000 그대로 + unentitled 사유, 2026-09-27 M4) — 무료 기간이
--    끝나 게이트웨이·봇이 채널에 남긴 안내(unentitled:<crew>:<channel>[:마커])가 뜨면, 그 크루·채널에 남아 있는
--    queued·running 자동화 실행을 모두 unentitled 사유로 닫는다(메시지별이 아니라 채널 전체 — 안내 자체가 채널당 1회이므로). ──
create or replace function public.msgr_automation_terminal_message() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a_id uuid; reason text := split_part(new.client_msg_id,':',1);
begin
  if new.author_kind <> 'crew' or new.kind <> 'system' then return new; end if;
  if reason = 'unentitled' then
    if new.client_msg_id is distinct from 'unentitled:' || new.crew_id::text || ':' || new.channel_id::text
      and new.client_msg_id !~ ('^unentitled:' || new.crew_id::text || ':' || new.channel_id::text || ':') then return new; end if;
    for a_id in update public.msgr_automation_runs r set status = 'blocked',reply_id = new.id,error = 'unentitled',finished_at = now()
      from public.msgr_automations au where r.automation_id = au.id and au.channel_id = new.channel_id and au.crew_id = new.crew_id
        and r.status in ('queued','running')
      returning r.automation_id
    loop
      update public.msgr_automations set last_status = 'blocked' where id = a_id;
    end loop;
    return new;
  end if;
  if reason not in ('deny','stale','hopcap','ratecap') or new.reply_to is null
    or new.client_msg_id is distinct from reason || ':' || new.crew_id::text || ':' || new.reply_to::text then return new; end if;
  for a_id in update public.msgr_automation_runs r set status = 'blocked',reply_id = new.id,error = reason,finished_at = now()
    from public.msgr_messages source where r.message_id = new.reply_to and source.id = r.message_id
      and source.channel_id = new.channel_id and r.status in ('queued','running')
      and source.mentions @> jsonb_build_array(jsonb_build_object('kind','crew','id',new.crew_id)) returning r.automation_id
  loop
    update public.msgr_automations set last_status = 'blocked' where id = a_id and last_message_id = new.reply_to;
  end loop;
  return new;
end $$;
revoke all on function public.msgr_automation_terminal_message() from public,anon,authenticated;
