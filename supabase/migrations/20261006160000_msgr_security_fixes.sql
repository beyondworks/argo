-- 메신저 보안 결함 4건(2026-10-06 점검, 로컬 PG 14 재현). 함수는 각자 마지막 정의를 그대로 가져와 판정 한 곳만 고친다 —
-- 시그니처·security definer·search_path·권한(grant)은 바꾸지 않는다(create or replace는 기존 권한을 유지한다).
-- 시험: test/msgr-security-0197-pg.test.mjs (이 파일 적용 전 빨강 → 적용 뒤 초록, 정상 경로 유지)
-- 부하: 주기 작업·새 표·새 쓰기 없음. 판정 쿼리만 늘어난다(아래 각 절의 "부하").

-- ── 1. 게스트는 공개 채널 찾아보기·참여를 못 한다 ──────────────────────────────────────────
-- 원인: 두 RPC가 게스트도 참인 msgr_is_member만 봤다. 공개 채널 열람 갈래(msgr_can_read_channel)는 owner·admin·member만 허용하는데,
--   게스트가 참여 행을 만들면 "참여 행" 갈래로 읽기·쓰기가 열렸다. 판정을 열람 갈래와 같은 역할 목록으로 맞춘다.
-- 정의 출처: 20260916190000_msgr_channel_join.sql(두 함수의 유일한 정의).
create or replace function public.msgr_join_channel(ch uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_channels;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_channels where id = ch;
  if c.id is null then return false; end if;
  if c.kind <> 'public' then raise exception 'msgr_public_only' using errcode = '42501'; end if; -- 비공개·1:1은 초대로만
  -- 게스트는 공개 채널에 스스로 들어오지 못한다(초대받은 비공개 채널만) — msgr_can_read_channel 공개 갈래와 같은 역할 목록
  if c.org_id is null or not coalesce(public.msgr_role(c.org_id) in ('owner', 'admin', 'member'), false) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if c.archived_at is not null or coalesce(public.msgr_org_locked(c.org_id), false) then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if me = any (c.excluded_user_ids) then raise exception 'msgr_forbidden' using errcode = '42501'; end if; -- 제외된 사람은 못 들어온다
  insert into public.msgr_channel_members (channel_id, member_kind, member_id)
    select ch, 'user', me
     where not exists (select 1 from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user' and m.member_id = me);
  return true;
end $$;

create or replace function public.msgr_browse_channels(org uuid)
returns table (id uuid, name text, topic text, members int, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select c.id, c.name, c.topic,
           (select count(*)::int from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user'),
           c.created_at
      from public.msgr_channels c
     where c.org_id = org and c.kind = 'public' and c.archived_at is null
       and coalesce(public.msgr_role(org) in ('owner', 'admin', 'member'), false) -- 게스트에게는 빈 목록(참여도 못 한다)
       and not (auth.uid() = any (c.excluded_user_ids))
       and not exists (select 1 from public.msgr_channel_members m
                        where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by c.created_at
$$;

-- ── 2. 채널을 나간 생성자·채널 관리자는 그 채널을 관리하지 못한다 ────────────────────────────
-- 원인: created_by·admin_user_ids만 보고 지금 참여 중인지 보지 않았다. 참여 행 insert 정책이 이 판정을 써서
--   나간 사람이 자기·남을 다시 넣었다(비공개 채널 재입장). 조직 관리자 갈래와 1:1(dm) 갈래는 그대로다.
-- 정의 출처: msgr_can_manage_channel = 20260917190000_msgr_personal_group_fixes.sql(마지막),
--            msgr_is_channel_host   = 20260918170000_msgr_dm_crew_approval.sql(마지막).
-- 부하: 생성자·관리자 갈래에서만 참여 행 조회 1회(msgr_channel_members 기본 키 (channel_id, member_kind, member_id) 조회).
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (((c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids))
                           and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()))
                          or (c.kind <> 'dm' and c.org_id is not null and coalesce(public.msgr_is_admin(c.org_id), false))
                          or (c.kind = 'dm' and not (c.org_id is null and c.personal_pair is null)
                              and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())))
                     and (c.org_id is null or coalesce(public.msgr_is_member(c.org_id), false)))
$$;

create or replace function public.msgr_is_channel_host(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch and c.kind <> 'dm'
                     and coalesce(public.msgr_is_member(c.org_id), false)
                     and (((c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids))
                           and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()))
                          or coalesce(public.msgr_is_admin(c.org_id), false)))
$$;

-- ── 3. 사람은 보통 글(kind='text')만, 전달 표지(meta.relay*) 없이 쓴다 ───────────────────────
-- 원인: insert 정책에 kind·meta 조건이 없어 author_kind='user'가 system·approval_card 글과 전달 표지를 위조했다
--   (system 글은 신고 대상에서 빠지고, 앱은 system 글을 안내 줄로 그린다).
-- 서버가 쓰는 사람 명의 system 글(msgr_dm_relay 전달 안내·한도 안내)과 전달 글(meta.relay)은 security definer 함수가 테이블 소유자로 넣어
--   RLS를 거치지 않는다(로컬 실측: msgr_messages에 insert하는 public 함수 15개 전부 prosecdef=t·소유자 postgres, relforcerowsecurity=f).
--   그래서 트리거가 아니라 정책에서 막는다 — 서버 경로·서비스 롤·에이전트(author_kind='crew') 글은 바뀌지 않는다.
-- 정책 출처: 20260930210000_msgr_personal_crews.sql의 alter policy(마지막) — 식은 그대로, 사람 갈래에 조건 둘만 더한다.
-- 1:1(dm) 방은 b_msgr_dm_message_guard(BEFORE INSERT)가 relay·relay_to·relay_capped를 먼저 지운다 — WITH CHECK는 BEFORE 트리거 뒤에 보므로 그 경로는 그대로 통과한다.
-- 부하: 사람 글 insert마다 meta 키 검사 1회(메모리 안 계산, 쿼리 없음).
alter policy msgr_messages_insert on public.msgr_messages
  with check (msgr_can_write_channel(channel_id) and (((author_kind = 'user'::text) and (author_user_id = (select auth.uid()))
      and kind = 'text'::text
      and not (coalesce(meta, '{}'::jsonb) ?| array['relay', 'relay_to', 'relay_capped', 'relay_cycle', 'relay_chain_id']))
    or ((author_kind = 'crew'::text) and (exists (select 1 from msgr_crews c
      where c.id = msgr_messages.crew_id and c.owner_user_id = (select auth.uid()) and c.status = 'active'::text
        and c.org_id is not distinct from (select ch.org_id from msgr_channels ch where ch.id = msgr_messages.channel_id))))));

-- 신고: 사람이 쓴 system 글(이 수정 전에 위조됐을 수 있는 글)은 신고할 수 있다. 서버·에이전트 안내(author_kind<>'user')는 종전대로 제외.
-- 정의 출처: 20260921090000_msgr_ugc_report.sql(유일한 정의) — 조건 한 줄만 바꾼다.
create or replace function public.msgr_report_message(msg bigint, reason text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); m public.msgr_messages; rid uuid;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into m from public.msgr_messages where id = msg;
  -- 읽을 수 없는 글과 없는 글은 같은 오류(검수 L1: 존재 여부를 드러내지 않는다)
  if m.id is null or not public.msgr_can_read_channel(m.channel_id) or m.deleted_at is not null or (m.kind = 'system' and m.author_kind <> 'user') then
    raise exception 'msgr_report_no_message' using errcode = '22023';
  end if;
  if m.author_kind = 'user' and m.author_user_id = me then
    raise exception 'msgr_report_own' using errcode = '42501';
  end if;
  select id into rid from public.msgr_reports where message_id = m.id and reporter_user_id = me and status = 'open';
  if rid is not null then return rid; end if; -- 같은 글 반복 신고는 하나로(검수 L2)
  insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id, author_user_id, author_crew_id, body_snapshot, reason)
    values (m.id, m.channel_id, m.org_id, me, m.author_user_id, m.crew_id, left(m.body, 1000), nullif(left(btrim(coalesce(reason, '')), 500), ''))
    returning id into rid;
  return rid;
end $$;

-- ── 4. 푸시 수신자는 그 채널을 읽을 수 있는 사람만 ─────────────────────────────────────────
-- 원인: mentions의 user uuid를 열람 가능 여부와 상관없이 더했다(엣지 msgr-push가 본문 140자를 보낸다) — 채널 밖 사람·다른 조직 사람에게 본문이 갔다.
-- 처방: 수신자(멘션·참여자 모두)마다 msgr_can_read_channel과 같은 판정을 그 사람 기준으로 건다. msgr_can_read_channel은 auth.uid() 기준이라
--   같은 조건을 수신자 uid로 옮겨 적는다(msgr_role = 조직 삭제 안 됨·removed_at 없음·만료 안 됨). 참여 행은 있어도 조직에서 나간 사람도 빠진다(열 수 없는 알림).
--   두 판정이 갈라지지 않게 시험이 수신자 집합 ⊆ "그 사람으로 msgr_can_read_channel이 참"을 표로 잠근다.
-- 정의 출처: 20260927120000_msgr_mute_crew_notify.sql(마지막). invoker 함수 그대로(호출자 msgr_push_enqueue·msgr_push_recipients_of가 definer).
-- 부하: 글 1건당 후보 수신자마다 채널 1행 + 조직 멤버 행 1~2회 기본 키·색인 조회. 후보 수는 종전과 같다(참여자 + 멘션).
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    -- 공개 채널도 채널 멤버 기준(종전에는 조직원 전원이었다 — 안 들어간 채널의 알림까지 갔다)
    select cm.member_id as u from public.msgr_channel_members cm
      where cm.channel_id = m.channel_id and cm.member_kind = 'user'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = m.channel_id and p.user_id = s.u and p.muted)
    and not public.msgr_on_desktop(s.u) -- PC 앞이면 그 화면의 배너로 이미 안다
    and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = s.u and b.blocked = m.author_user_id))
    and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = s.u and b.blocked_crew = m.crew_id))
    -- 수신자가 이 채널을 읽을 수 있어야 한다 — msgr_can_read_channel(20260916150000)을 수신자 기준으로
    and exists (
      select 1 from public.msgr_channels c
       where c.id = m.channel_id and (
         (c.kind = 'public' and c.org_id is not null and not (s.u = any (c.excluded_user_ids))
          and exists (select 1 from public.msgr_org_members om join public.msgr_orgs o on o.id = om.org_id and o.deleted_at is null
                       where om.org_id = c.org_id and om.user_id = s.u and om.removed_at is null
                         and (om.expires_at is null or om.expires_at > now()) and om.role in ('owner', 'admin', 'member')))
         or (exists (select 1 from public.msgr_channel_members cm2
                      where cm2.channel_id = c.id and cm2.member_kind = 'user' and cm2.member_id = s.u)
             and (c.org_id is null
                  or exists (select 1 from public.msgr_org_members om join public.msgr_orgs o on o.id = om.org_id and o.deleted_at is null
                              where om.org_id = c.org_id and om.user_id = s.u and om.removed_at is null
                                and (om.expires_at is null or om.expires_at > now()))))
       ))
$$;
