-- 메신저 사람 채팅(Pro 전용) 스위치 + 첫 글 첨부 기다림(R5 결함 1) — 2026-10-20 총괄 결정("사람 채팅까지 만든 뒤 한 번에 공개", 유건 12:1x KST).
-- 정책: 사람 채팅도 Pro 전용(무료 = 서버 안 씀). Pro가 무료를 초대하면 그 사람은 Pro가 돼야 참여한다. 약속 v1.1·본체(src/)는 바꾸지 않는다.
--
-- 1) 스위치 msgr_settings 'msgr2_people' = 'on'(없으면 꺼짐 — 지금 A+ 그대로).
--    켜면 lite(1:1·회의방만, 20261019160000)가 풀린다: _msgr2_lite()가 거짓을 돌려준다 → 팀 공간·초대·방·사람 1:1·일 만들기·백필 거부(msgr2_backfill_lite)가 lite 판정에서 빠진다.
--    대신 사람 문맥의 쓰기에 Pro 관문을 건다(같은 트리거 msgr2_lite_guard 한 곳):
--      · 내가 무료: 팀 공간 만들기·초대 만들기·공간 들어가기(초대 수락)·방 들어가기·사람 글 → 'msgr2_pro_required'
--      · 무료인 다른 사람을 바로 넣기(1:1 열기·방 만들기 p_users·멤버 추가) → 'msgr2_member_not_pro'
--      · 초대 만들기는 받는 사람의 요금제를 보지 않는다(요금제를 새지 않고, 수락 전에 Pro로 바꿀 수 있게) — 수락 때 위 관문
--    서비스 문맥(auth.uid() 없음: 백필·관리)은 관문을 지나지 않는다. msgr2_pro_gate = 'off'면 Pro 판정이 늘 참이다(_msgr2_pro_ok).
--    끄기: 'msgr2_people' 행을 지우거나 'off' → 다음 요청부터 lite로 돌아간다(이미 만든 팀 공간·방은 그대로 남고, lite 판정이 사람 글·일을 막는다).
-- 2) 사람 방 상한(켬일 때, 설정으로 낮출 수 있고 최대값은 넘지 못한다 — 넘치면 'msgr2_limit', detail 괄호 안):
--    공간 활동 멤버 ≤ 50(최대 200, space_members) · 방 사람 멤버 ≤ 50(최대 50, room_members — 팀 open 방은 공간 인원) · 1:1(direct)은 2 ·
--    사람 글 분당 사람마다 ≤ 30(최대 120, user_messages) · 방마다 ≤ 60(최대 300, room_messages) · 초대 만들기 사람마다 하루 ≤ 50(최대 200, invites_day).
--    첨부는 기존 상한(글당 20개, 개당 50MB — msgr2_attachment_add). 입력 중 표시는 없다. 접속 표시는 Realtime Presence(저장 0, U6b).
--    퍼짐: 팀 open 방 글은 인원과 무관하게 공간 토픽 1번, private ≤ 50·direct 2는 사람마다(6절). 알림: 글당 엣지 1번, 사람 채팅 켬이면 같은 방·같은 글쓴이 text는 10초 안 1번(6절).
--    회의방 상한(봇 금지·참가자 ≤ 5)은 lite와 상관없이 늘 건다(종전에는 lite 켬일 때만).
-- 3) 첫 글 첨부(R5 결함 1): 사람 글 insert 정책이 meta = '{}'를 강제하므로 새 열 files_expected(0..20)로 첨부 수를 받는다.
--    files_expected > 0인 글은 넣을 때 일을 만들지 않고 기다림 표(msgr2_msg_waits)에 둔다. 앱이 모든 파일을 올린 뒤 msgr2_message_ready(글)를 부르면
--    첨부 객체가 다 있는지 보고 일을 만든다(없으면 'msgr2_attachment_missing' — 다시 올리고 재시도). files_expected = 0이면 종전대로 넣는 순간 일을 만든다(옛 앱 그대로).
--    폴백(기한 msgr2_files_wait_s 기본 120초): 기한이 지난 기다림은 다음 사건에 얹어 첨부 없이 일을 만들고 방에 안내 1줄('msg.files_missing')을 남긴다 —
--      ① 그 방의 다음 사람 글 ② 같은 사람의 msgr2_message_ready(성공한 호출 — 거부되면 트랜잭션과 함께 취소된다) ③ 하루 1번 도는 기존 정리 작업(msgr2_retention_prune). 새 주기 작업·폴링은 없다(쉬는 동안 쓰기 0).
-- 4) 이관(U8 백필): _msgr2_bf_begin은 _msgr2_lite()를 보므로 사람 채팅을 켜면 백필도 허용된다(lite 켬 + 사람 채팅 꺼짐이면 종전대로 거부).
--    이관 범위는 메신저 채널·에이전트 자리가 있는 조직만(7절 — 오피스 전용 조직을 팀 공간으로 섞지 않는다).
-- 되돌림: scripts/rollback/20261020120000_msgr2_people.down.sql · 시험: test/msgr2-people-pg.test.mjs

-- ── 1. 스위치·판정 ─────────────────────────────────────────────────────────────
create or replace function public._msgr2_people() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public._msgr2_setting('msgr2_people'), 'off') = 'on' $$;

-- lite = 켬(기본) 그리고 사람 채팅 꺼짐. 사람 채팅을 켜면 lite 판정(1:1·회의방만, 백필 거부)이 모두 풀린다.
create or replace function public._msgr2_lite() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(public._msgr2_setting('msgr2_lite'), 'on') <> 'off' and not public._msgr2_people() $$;

-- ── 2. 열·표 ───────────────────────────────────────────────────────────────────
alter table public.msgr2_messages add column if not exists files_expected smallint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'msgr2_messages_files_expected_check') then
    alter table public.msgr2_messages add constraint msgr2_messages_files_expected_check check (files_expected between 0 and 20);
  end if;
end $$;
grant insert (files_expected) on public.msgr2_messages to authenticated;
grant select (files_expected) on public.msgr2_messages to authenticated;
-- 사람 글 분당 상한 판정용(작성자·시각). 사람 글만.
create index if not exists msgr2_messages_author_recent on public.msgr2_messages (author_user_id, created_at) where author_kind = 'user';
create index if not exists msgr2_messages_room_recent on public.msgr2_messages (room_id, created_at) where author_kind = 'user'; -- 방마다 분당 글 판정

-- 첨부를 기다리는 사람 글(일을 아직 만들지 않음). 일을 만들면 행을 지운다(기억 데이터 아님 — 글 본문은 msgr2_messages에 있다).
create table if not exists public.msgr2_msg_waits (
  message_id bigint primary key references public.msgr2_messages(id) on delete cascade,
  room_id uuid not null,
  author_user_id uuid not null,
  created_at timestamptz not null default now()
);
create index if not exists msgr2_msg_waits_room on public.msgr2_msg_waits (room_id, created_at);
create index if not exists msgr2_msg_waits_author on public.msgr2_msg_waits (author_user_id, created_at);
alter table public.msgr2_msg_waits enable row level security; -- 정책 없음: 서버 함수만
revoke all on public.msgr2_msg_waits from public, anon, authenticated;

-- ── 3. 관문 트리거(한 곳) ───────────────────────────────────────────────────────
create or replace function public.msgr2_lite_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); s public.msgr2_spaces; r public.msgr2_rooms; n int; lite boolean; people boolean;
begin
  if uid is null then return new; end if; -- 서비스·이전 문맥
  lite := public._msgr2_lite(); people := public._msgr2_people();
  if not lite and not people and tg_table_name <> 'msgr2_room_members' then return new; end if;

  if tg_table_name = 'msgr2_spaces' then
    if lite and new.kind <> 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people and new.kind = 'team' and not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_space_invites' then
    if lite then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_space_invites i where i.created_by = uid and i.created_at > now() - interval '1 day';
      if n >= public._msgr2_clamp('msgr2_limit_invites_day', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'invites_day'; end if;
    end if;
    return new; -- 받는 사람의 요금제는 보지 않는다(수락 때 공간 멤버 관문)
  end if;

  if tg_table_name = 'msgr2_space_members' then
    if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if; -- 들어오기·되살리기만
    if people and exists (select 1 from public.msgr2_spaces x where x.id = new.space_id and x.kind = 'team') then -- 개인 공간(주인 1행)은 관문 밖
      if not public._msgr2_pro_ok(new.user_id) then
        raise exception '%', case when new.user_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
      end if;
      select count(*) into n from public.msgr2_space_members m
       where m.space_id = new.space_id and m.removed_at is null and m.user_id <> new.user_id and (m.expires_at is null or m.expires_at > now());
      if n >= public._msgr2_clamp('msgr2_limit_space_members', 50, 200) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'space_members'; end if;
    end if;
    return new;
  end if;

  if tg_table_name = 'msgr2_messages' then
    if new.author_kind <> 'user' then return new; end if;
    if lite and not public._msgr2_lite_room_ok(new.room_id) then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if people then
      if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.author_kind = 'user' and m.author_user_id = uid and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_user_msg_min', 30, 120) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'user_messages'; end if;
      select count(*) into n from public.msgr2_messages m
       where m.room_id = new.room_id and m.author_kind = 'user' and m.created_at > now() - interval '1 minute';
      if n >= public._msgr2_clamp('msgr2_limit_room_msg_min', 60, 300) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_messages'; end if;
    end if;
    return new;
  end if;

  -- msgr2_room_members: 새로 넣거나 빠졌던 멤버를 되살릴 때
  if tg_op = 'UPDATE' and (new.removed_at is not null or old.removed_at is null) then return new; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  if people and new.member_kind = 'user' then
    if not public._msgr2_pro_ok(new.member_id) then
      raise exception '%', case when new.member_id = uid then 'msgr2_pro_required' else 'msgr2_member_not_pro' end using errcode = '42501';
    end if;
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'user' and m.removed_at is null and m.member_id <> new.member_id;
    if n >= public._msgr2_clamp('msgr2_limit_room_members', 50, 50) then raise exception 'msgr2_limit' using errcode = '22023', detail = 'room_members'; end if;
  end if;
  if lite then
    if s.kind is distinct from 'personal' then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
    if new.member_kind = 'user' then
      if new.member_id <> s.owner_user_id then raise exception 'msgr2_lite_only' using errcode = '42501'; end if;
      return new;
    end if;
    if not exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.owner_user_id = s.owner_user_id) then
      raise exception 'msgr2_lite_only' using errcode = '42501';
    end if;
  end if;
  if new.member_kind = 'agent' then
    select count(*) into n from public.msgr2_room_members m
     where m.room_id = new.room_id and m.member_kind = 'agent' and m.removed_at is null and m.member_id <> new.member_id;
    if r.meeting then -- 회의방 상한은 lite와 상관없이 늘
      if exists (select 1 from public.msgr2_agents a where a.id = new.member_id and a.hosting = 'bot') then
        raise exception 'msgr2_meeting_no_bot' using errcode = '22023';
      end if;
      if n >= public._msgr2_clamp('msgr2_meeting_agents', 5, 5) then raise exception 'msgr2_meeting_full' using errcode = '22023'; end if;
    elsif lite and n >= 1 then
      raise exception 'msgr2_lite_only' using errcode = '42501'; -- lite: 회의방이 아닌 방은 에이전트 1명(1:1)
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.msgr2_lite_guard() from public, anon, authenticated;
drop trigger if exists msgr2_lite_guard on public.msgr2_space_members;
create trigger msgr2_lite_guard before insert or update of removed_at on public.msgr2_space_members for each row execute function public.msgr2_lite_guard();

-- ── 4. 사람 글 → 일: 첨부를 기다리는 글은 미룬다 ─────────────────────────────────
-- 사람 글 한 개의 일 만들기(20261019160000 msgr2_on_user_message 본문 그대로, new → m). 만든 일 수를 돌려준다.
create or replace function public._msgr2_user_offers(m public.msgr2_messages) returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare ag uuid; targets uuid[]; v_meeting boolean; parts uuid[]; k int := 0; w uuid;
begin
  if m.deleted_at is not null or m.author_kind <> 'user' then return 0; end if;
  select r.meeting into v_meeting from public.msgr2_rooms r where r.id = m.room_id;
  if coalesce(v_meeting, false) then
    select array_agg(q.member_id order by q.added_at, q.member_id) into parts from (
      select mm.member_id, mm.added_at from public.msgr2_room_members mm join public.msgr2_agents g on g.id = mm.member_id and g.status = 'active' and g.hosting = 'local'
       where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null
         and (cardinality(m.mentions) = 0 or mm.member_id = any (m.mentions))
       order by mm.added_at, mm.member_id limit public._msgr2_clamp('msgr2_meeting_agents', 5, 5)) q;
    if cardinality(parts) > 0 then
      w := public._msgr2_make_offer_x(m.room_id, m.topic_id, parts[1], 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0, parts);
      if w is not null then k := 1; end if;
    end if;
    return k;
  end if;
  if cardinality(m.mentions) > 0 then
    select array_agg(distinct mm.member_id) into targets from public.msgr2_room_members mm
      where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null and mm.member_id = any (m.mentions);
  elsif (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'user' and mm.removed_at is null and mm.member_id <> m.author_user_id) = 0
        and (select count(*) from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null) = 1 then
    select array_agg(mm.member_id) into targets from public.msgr2_room_members mm where mm.room_id = m.room_id and mm.member_kind = 'agent' and mm.removed_at is null;
  end if;
  foreach ag in array coalesce(targets, '{}') loop
    w := public._msgr2_make_offer(m.room_id, m.topic_id, ag, 'user', m.author_user_id, m.author_user_id, m.body, m.id, null, 0);
    if w is not null then k := k + 1; end if;
  end loop;
  return k;
end $$;

-- 기한이 지난 기다림을 첨부 없이 일로 만든다(방에 안내 1줄). p_room·p_user가 null이면 전부(하루 정리). 처리한 기다림 수.
-- 기다림이 없으면 읽기만 한다(쓰기 0).
create or replace function public._msgr2_flush_waits(p_room uuid, p_user uuid) returns int
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare x record; m public.msgr2_messages; k int := 0; got int;
begin
  for x in delete from public.msgr2_msg_waits w
            where w.created_at < now() - make_interval(secs => greatest(public._msgr2_setting_int('msgr2_files_wait_s', 120), 10))
              and (p_room is null or w.room_id = p_room) and (p_user is null or w.author_user_id = p_user)
            returning w.message_id loop
    select * into m from public.msgr2_messages where id = x.message_id;
    if m.id is null or m.deleted_at is not null then continue; end if;
    select count(*) into got from public.msgr2_attachments a where a.message_id = m.id
       and exists (select 1 from storage.objects o where o.bucket_id = split_part(a.storage_path, '/', 1) and o.name = substr(a.storage_path, position('/' in a.storage_path) + 1));
    perform public._msgr2_system_msg(m.room_id, m.topic_id, null, jsonb_build_object('code', 'msg.files_missing', 'message', m.id, 'expected', m.files_expected, 'got', got));
    perform public._msgr2_user_offers(m);
    k := k + 1;
  end loop;
  return k;
end $$;

create or replace function public.msgr2_on_user_message() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if; -- 이전(U8) 백필: offer·카운터 쓰기 없음
  if new.author_kind <> 'user' then return null; end if;
  update public.msgr2_room_counters set agent_streak = 0, streak_noted = false where room_id = new.room_id and (agent_streak <> 0 or streak_noted);
  if exists (select 1 from public.msgr2_msg_waits w where w.room_id = new.room_id) then perform public._msgr2_flush_waits(new.room_id, null); end if; -- 폴백 ①
  if new.files_expected > 0 then
    insert into public.msgr2_msg_waits (message_id, room_id, author_user_id) values (new.id, new.room_id, new.author_user_id) on conflict do nothing;
    return null; -- 첨부를 다 올린 뒤 msgr2_message_ready가 일을 만든다
  end if;
  perform public._msgr2_user_offers(new);
  return null;
end $$;

-- 앱: 모든 첨부를 올린 뒤 한 번. 같은 글로 다시 불러도 안전하다(두 번째부터 offers 0).
create or replace function public.msgr2_message_ready(p_message bigint) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m public.msgr2_messages; w public.msgr2_msg_waits; have int; ok int; k int;
begin
  if uid is null or not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if public._msgr2_paused() then raise exception 'service_paused' using errcode = '42501'; end if;
  select * into m from public.msgr2_messages where id = p_message;
  if m.id is null or m.author_kind <> 'user' or m.author_user_id <> uid then raise exception 'msgr2_message_not_found' using errcode = '42501'; end if;
  if exists (select 1 from public.msgr2_msg_waits x where x.author_user_id = uid and x.message_id <> p_message) then perform public._msgr2_flush_waits(null, uid); end if; -- 폴백 ②
  select * into w from public.msgr2_msg_waits where message_id = p_message for update;
  if w.message_id is null then return jsonb_build_object('ok', true, 'offers', 0); end if; -- 이미 만들었다(또는 기다림 없는 글)
  select count(*), count(*) filter (where exists (select 1 from storage.objects o
           where o.bucket_id = split_part(a.storage_path, '/', 1) and o.name = substr(a.storage_path, position('/' in a.storage_path) + 1)))
    into have, ok from public.msgr2_attachments a where a.message_id = m.id;
  if have < m.files_expected or ok < have then raise exception 'msgr2_attachment_missing' using errcode = '22023', detail = format('%s/%s', ok, m.files_expected); end if;
  delete from public.msgr2_msg_waits where message_id = p_message;
  k := public._msgr2_user_offers(m);
  return jsonb_build_object('ok', true, 'offers', k);
end $$;
revoke all on function public.msgr2_message_ready(bigint) from public, anon;
grant execute on function public.msgr2_message_ready(bigint) to authenticated;

-- 폴백 ③: 하루 1번 도는 기존 정리 작업에 얹는다(크론을 새로 만들지 않는다). 반환 = 지운 사건 수(종전과 같은 뜻).
create or replace function public.msgr2_retention_prune() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with d as (
    delete from public.msgr2_work_events e
     where e.created_at < now() - interval '30 days'
       and (e.work_id is null or exists (select 1 from public.msgr2_works w where w.id = e.work_id
              and (w.state in ('done', 'failed', 'cancelled') or (w.state = 'offered' and w.expires_at < now() - interval '30 days'))))
    returning 1)
  select count(*)::int into n from d;
  if exists (select 1 from public.msgr2_msg_waits) then perform public._msgr2_flush_waits(null, null); end if;
  return n;
end $$;


-- ── 6. 퍼짐·속도·알림 상한(2026-10-20 유건 "폭주 안되게 막는 게 제일 중요해") ─────────────
-- 퍼짐: 사람 채팅 켬이면 팀 open 방의 글·일·첨부 표지는 인원과 무관하게 공간 토픽(v2:s:) 1번 + 그 토픽을 못 받는 손님만 따로.
--   앱은 내 팀 공간마다 v2:s:<공간>을 구독한다(link/machine.mjs setSpaces). private 방은 사람 ≤ 50(아래 방 인원 상한), 1:1(direct)은 2라 사람마다 보내도 ≤ 50.
--   꺼짐(A+)이면 종전 문턱 msgr2_fanout_max(기본 50).
create or replace function public._msgr2_fanout_max() returns int
  language sql stable security definer set search_path = public, pg_temp as $$
  select case when public._msgr2_people() then 0 else public._msgr2_setting_int('msgr2_fanout_max', 50) end $$;

create or replace function public.msgr2_on_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid; p jsonb;
begin
  -- 이전(U8) 백필: 서비스 문맥(auth.uid() 없음)에서 msgr2.backfill = on이면 방송하지 않는다(옛 글 수백만 건 = 방송 폭주). 사람 문맥은 이 설정과 무관하게 방송한다.
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if;
  if tg_op = 'UPDATE' and (new.body, new.meta, new.edited_at, new.deleted_at) is not distinct from (old.body, old.meta, old.edited_at, old.deleted_at) then return null; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  p := public._msgr2_msg_payload(new);
  select count(*) into n from public._msgr2_room_humans(new.room_id);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_fanout_max() then
    perform public._msgr2_send_s(s.id, 'msg', p);
    -- v2:s:를 못 받는 사람(그 공간의 owner·admin·member가 아닌 방 멤버 — 손님 등)에게는 따로(검수 #1076 중간)
    for u in select h from public._msgr2_room_humans(new.room_id) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, 'msg', p);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(new.room_id) loop perform public._msgr2_send_u(u, 'msg', p); end loop;
  end if;
  return null;
end $$;

create or replace function public._msgr2_fanout(p_room uuid, p_event text, p_payload jsonb) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid;
begin
  select * into r from public.msgr2_rooms where id = p_room;
  select * into s from public.msgr2_spaces where id = r.space_id;
  select count(*) into n from public._msgr2_room_humans(p_room);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_fanout_max() then
    perform public._msgr2_send_s(s.id, p_event, p_payload);
    for u in select h from public._msgr2_room_humans(p_room) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, p_event, p_payload);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(p_room) loop perform public._msgr2_send_u(u, p_event, p_payload); end loop;
  end if;
end $$;

-- 알림 묶음 장부(방·글쓴이마다 마지막 엣지 호출 시각 1행). 기억 데이터 아님. 쉬는 동안 쓰기 0.
create table if not exists public.msgr2_push_gate (
  room_id uuid not null,
  author uuid not null,
  at timestamptz not null default now(),
  primary key (room_id, author)
);
alter table public.msgr2_push_gate enable row level security;
revoke all on public.msgr2_push_gate from public, anon, authenticated;

create or replace function public.msgr2_push_enqueue() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; who uuid := coalesce(new.author_user_id, new.author_agent_id);
begin
  if new.deleted_at is not null or not public._msgr2_push_target(new.kind, new.meta) then return new; end if;
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return new; end if; -- 이전(U8) 백필: 옛 글 수백만 건에 알림을 보내지 않는다
  if public._msgr2_paused() then return new; end if;
  select value into url from public.msgr_settings where key = 'msgr2_push_url';
  if url is null or url = '' then return new; end if;
  -- 묶음: 같은 방·같은 글쓴이의 text 글은 msgr2_push_gap_s(기본 10초, 최대 60) 안에 한 번만 엣지를 부른다(받는 기기의 알림은 방 단위로 접힌다 — apns-collapse-id).
  -- 결재 카드는 묶지 않는다. 글쓴이가 다르면 따로(대화 상대의 답은 바로 알린다).
  if new.kind = 'text' and who is not null and public._msgr2_people() then -- 사람 채팅 켬일 때만(꺼짐 = A+ 알림 그대로)
    if exists (select 1 from public.msgr2_push_gate g where g.room_id = new.room_id and g.author = who
                and g.at > now() - make_interval(secs => public._msgr2_clamp('msgr2_push_gap_s', 10, 60))) then return new; end if;
    insert into public.msgr2_push_gate as g (room_id, author, at) values (new.room_id, who, now())
      on conflict (room_id, author) do update set at = excluded.at;
  end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(), body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 20000);
  return new;
exception when others then return new;
end $$;
revoke all on function public.msgr2_push_enqueue(), public._msgr2_fanout_max(), public._msgr2_fanout(uuid, text, jsonb), public.msgr2_on_message_broadcast() from public, anon, authenticated;

-- 초대 하루 상한 판정용
create index if not exists msgr2_space_invites_creator on public.msgr2_space_invites (created_by, created_at);


-- ── 7. 이관 범위: 메신저에서 쓴 조직만(2026-10-20 총괄 — 오피스 외래키가 office_orgs로 옮겨진 뒤에도 msgr_orgs에는 오피스 전용 조직이 남는다) ─────
-- 옮기는 조직 = 메신저 채널이나 에이전트 자리(msgr_crews.org_id)가 하나라도 있는 조직(지운 조직 포함). 그 밖(오피스에서만 쓴 조직·대화가 없는 빈 조직)은
-- 팀 공간·멤버·개인 공간을 만들지 않는다. 옛 표는 그대로다. 검증(missing)도 같은 기준으로 센다. 방·글·자리 단계는 채널·자리에서 출발하므로 원래 이 조직들만 본다.
create or replace function public._msgr2_org_in_msgr(p_org uuid) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return exists (select 1 from public.msgr_channels c where c.org_id = p_org) or exists (select 1 from public.msgr_crews c where c.org_id = p_org);
end $$;

create or replace function public._msgr2_bf_spaces(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_spaces as t (id, kind, name, slug, owner_user_id, created_at, deleted_at)
  select o.id, 'team', o.name, o.slug, o.owner_user_id, o.created_at, o.deleted_at from public.msgr_orgs o where public._msgr2_org_in_msgr(o.id)
  on conflict (id) do update set name = excluded.name, slug = excluded.slug, owner_user_id = excluded.owner_user_id, deleted_at = excluded.deleted_at
  where (t.name, t.slug, t.owner_user_id, t.deleted_at) is distinct from (excluded.name, excluded.slug, excluded.owner_user_id, excluded.deleted_at);
  get diagnostics written = row_count;
  insert into public.msgr2_spaces (kind, owner_user_id)
  select 'personal', u from (
    select user_id as u from public.msgr_org_members where public._msgr2_org_in_msgr(org_id)
    union select member_id from public.msgr_channel_members where member_kind = 'user'
    union select created_by from public.msgr_channels
    union select owner_user_id from public.msgr_crews
    union select user_id from public.msgr_profiles) x
   where u is not null and not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')
  on conflict (owner_user_id) where kind = 'personal' do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

create or replace function public._msgr2_bf_space_members(p_after text, p_limit int, out written bigint, out next text, out done boolean)
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  insert into public.msgr2_space_members as t (space_id, user_id, role, display_name, joined_at, removed_at, expires_at)
  select m.org_id, m.user_id, m.role, m.display_name, m.joined_at, m.removed_at, m.expires_at from public.msgr_org_members m where public._msgr2_org_in_msgr(m.org_id)
  on conflict (space_id, user_id) do update set role = excluded.role, display_name = excluded.display_name, removed_at = excluded.removed_at, expires_at = excluded.expires_at
  where (t.role, t.display_name, t.removed_at, t.expires_at) is distinct from (excluded.role, excluded.display_name, excluded.removed_at, excluded.expires_at);
  get diagnostics written = row_count;
  update public.msgr2_space_members t set removed_at = now()
   where t.removed_at is null and exists (select 1 from public.msgr_orgs o where o.id = t.space_id)
     and not exists (select 1 from public.msgr_org_members m where m.org_id = t.space_id and m.user_id = t.user_id);
  get diagnostics k = row_count; written := written + k;
  insert into public.msgr2_space_members (space_id, user_id, role, joined_at)
  select s.id, s.owner_user_id, 'owner', s.created_at from public.msgr2_spaces s
   where s.kind = 'personal' and not exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id = s.owner_user_id)
  on conflict do nothing;
  get diagnostics k = row_count; written := written + k;
  done := true;
end $$;

create or replace function public.msgr2_backfill_verify(p_sample int default 200) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare miss jsonb; rooms_bad bigint; sample_bad bigint; ok boolean; oc jsonb;
begin
  if auth.uid() is not null then raise exception 'msgr2_backfill_service_only' using errcode = '42501'; end if;
  miss := jsonb_build_object(
    'agents', (select count(*) from public.msgr_agents a where not exists (select 1 from public.msgr2_agents v where v.id = a.id)),
    'spaces_team', (select count(*) from public.msgr_orgs o where public._msgr2_org_in_msgr(o.id) and not exists (select 1 from public.msgr2_spaces s where s.id = o.id and s.kind = 'team')),
    'spaces_personal', (select count(*) from (select created_by u from public.msgr_channels where org_id is null union select user_id from public.msgr_org_members where public._msgr2_org_in_msgr(org_id)) x
                          where not exists (select 1 from public.msgr2_spaces s where s.owner_user_id = x.u and s.kind = 'personal')),
    'space_members', (select count(*) from public.msgr_org_members m where public._msgr2_org_in_msgr(m.org_id) and not exists (select 1 from public.msgr2_space_members v
                        where v.space_id = m.org_id and v.user_id = m.user_id and v.role = m.role and v.removed_at is not distinct from m.removed_at and v.expires_at is not distinct from m.expires_at)),
    'seats', (select count(*) from public.msgr_crews c where c.org_id is not null and not exists (select 1 from public.msgr2_agent_seats s where s.agent_id = c.agent_id and s.space_id = c.org_id and s.removed_at is null)),
    'rooms', (select count(*) from public.msgr_channels c where not exists (select 1 from public.msgr2_rooms r where r.id = c.id)),
    'room_members', (select count(*) from public._msgr2_bf_room_members_src() s where not exists (select 1 from public.msgr2_room_members v
                       where (v.room_id, v.member_kind, v.member_id) = (s.room_id, s.member_kind, s.member_id) and v.removed_at is null)),
    'messages', (select count(*) from public.msgr_messages m where not exists (select 1 from public.msgr2_messages v where v.id = m.id)),
    'attachments', (select count(*) from public.msgr_attachments a where not exists (select 1 from public.msgr2_attachments v where v.message_id = a.message_id and v.storage_path = 'msgr/' || a.storage_path)),
    'reads', (select count(*) from public.msgr_reads x where not exists (select 1 from public.msgr2_reads v where v.room_id = x.channel_id and v.user_id = x.user_id and v.last_read_id >= x.last_read_id)),
    'reactions', (select count(*) from public.msgr_reactions x where not exists (select 1 from public.msgr2_reactions v where (v.message_id, v.user_id, v.emoji) = (x.message_id, x.user_id, x.emoji))),
    'prefs', (select count(*) from public.msgr_channel_prefs x where not exists (select 1 from public.msgr2_prefs v where v.room_id = x.channel_id and v.user_id = x.user_id and v.muted = x.muted and (v.pinned or not x.pinned))),
    'approvals', (select count(*) from public.msgr_crew_approvals a where a.status = 'pending' and not exists (select 1 from public.msgr2_approvals v where v.id = a.id and v.state = 'expired')),
    'identity', (select case when coalesce((select max(id) from public.msgr_messages), 0) = 0 then 0
                     when (select last_value from pg_sequences where schemaname = 'public' and sequencename = split_part(pg_get_serial_sequence('public.msgr2_messages', 'id'), '.', 2))
                          >= greatest(coalesce((select max(id) from public.msgr2_messages), 0), (select max(id) from public.msgr_messages)) then 0 else 1 end));
  -- 방별 (id, md5(body)) — 옛 채널 글과 같은 방의 v2 글 중 옛 id인 것
  select count(*) into rooms_bad from (
    select o.channel_id, md5(string_agg(o.id::text || ':' || md5(o.body), ',' order by o.id)) h from public.msgr_messages o group by o.channel_id) old
    full join (
    select v.room_id, md5(string_agg(v.id::text || ':' || md5(v.body), ',' order by v.id)) h from public.msgr2_messages v
     where exists (select 1 from public.msgr_messages o where o.id = v.id) group by v.room_id) nw on nw.room_id = old.channel_id
   where old.h is distinct from nw.h;
  select count(*) into sample_bad from (select * from public.msgr_messages order by random() limit greatest(1, least(coalesce(p_sample, 200), 10000))) o
    left join public.msgr2_messages v on v.id = o.id
   where v.id is null or (v.room_id, v.body, v.created_at, v.edited_at, v.deleted_at, coalesce(v.author_user_id, '00000000-0000-0000-0000-000000000000'))
         is distinct from (o.channel_id, o.body, o.created_at, o.edited_at, o.deleted_at,
                           coalesce(case when o.author_kind = 'user' then o.author_user_id end, '00000000-0000-0000-0000-000000000000'))
      or v.reply_to is distinct from coalesce(o.reply_to, o.thread_root);
  oc := jsonb_build_object('msgr_orgs', (select count(*) from public.msgr_orgs), 'msgr_org_members', (select count(*) from public.msgr_org_members),
    'msgr_channels', (select count(*) from public.msgr_channels), 'msgr_channel_members', (select count(*) from public.msgr_channel_members),
    'msgr_crews', (select count(*) from public.msgr_crews), 'msgr_agents', (select count(*) from public.msgr_agents),
    'msgr_messages', (select count(*) from public.msgr_messages), 'msgr_attachments', (select count(*) from public.msgr_attachments),
    'msgr_reads', (select count(*) from public.msgr_reads), 'msgr_reactions', (select count(*) from public.msgr_reactions),
    'msgr_channel_prefs', (select count(*) from public.msgr_channel_prefs), 'msgr_target_prefs', (select count(*) from public.msgr_target_prefs),
    'msgr_crew_approvals', (select count(*) from public.msgr_crew_approvals));
  ok := rooms_bad = 0 and sample_bad = 0 and not exists (select 1 from jsonb_each_text(miss) e where e.value <> '0');
  if ok then update public.msgr2_backfill_jobs set verified_at = now(), updated_at = now(); end if;
  return jsonb_build_object('ok', ok, 'missing', miss, 'rooms_mismatch', rooms_bad, 'sample_mismatch', sample_bad, 'sample', p_sample, 'old_counts', oc);
end $$;
revoke all on function public._msgr2_org_in_msgr(uuid), public._msgr2_bf_spaces(text, int), public._msgr2_bf_space_members(text, int), public.msgr2_backfill_verify(int)
  from public, anon, authenticated;
grant execute on function public.msgr2_backfill_verify(int) to service_role;

revoke all on function public._msgr2_people(), public._msgr2_lite(), public._msgr2_user_offers(public.msgr2_messages), public._msgr2_flush_waits(uuid, uuid),
  public.msgr2_retention_prune() from public, anon, authenticated;

notify pgrst, 'reload schema';
