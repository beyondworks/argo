-- 개인 공간에 내 외부 에이전트(2026-10-01 유건 요청 3번): 조직에 연결한 내 Hermes·OpenClaw(hosting='bot')가 개인 공간 '내 에이전트'에
-- 자동으로 보이고 개인 공간에서도 대화된다. 규칙은 개인 Argo 크루(#779, 20260930210000)와 같다 — 지시는 주인만, 크루 1:1은 모든 글,
-- 친구 방은 @로만, 무료 방 4명 한도, 개인 방 AI 동의는 명시적 동의만. 같은 에이전트를 여러 조직에 연결했으면 조직 이름을 붙여 각각 보인다.
--
-- 구조(A안 — 봇마다 개인 쌍둥이 크루 행): 조직 봇 크루는 그 조직에만 그대로 두고, 같은 주인·같은 slug의 개인 행(org_id NULL, hosting 'bot',
--   allow 'owner' 고정)을 하나 더 둔다. #779 함수(크루 org = 채널 org)는 손대지 않는다. 같은 봇 토큰이 방의 종류로 크루를 고른다:
--   조직 채널 → 조직 봇 크루(지금과 같다), 개인 방 → 쌍둥이. 쌍둥이와 봇의 연결은 새 표 msgr_bot_personal(msgr_bots에 열을 더하지 않는다 —
--   rowtype을 반환·인자로 쓰는 함수가 많아 1회성 500이 났던 이력, 1b 머리 주석).
--
-- 반대 검토(critique-personal-bots) 반영:
--   H1 새 오류 이름을 만들지 않는다. 쌍둥이를 쓸 수 없으면 엣지 ERR 표에 이미 있는 msgr_not_allowed(403)·msgr_bot_not_member(403)를 쓴다 —
--      엣지가 모르는 이름은 500이 되고 Hermes·OpenClaw outbox가 5xx를 재시도하며 그 봇의 조직 배달까지 멈춘다. 계약 테스트(test/msgr-bot-err-contract)가
--      "봇 RPC가 raise하는 이름은 모두 ERR에 있다"를 잠근다. 결재 카드·파일은 지금도 403(msgr_not_allowed·msgr_bot_bad_attach_target)이라 재정의하지 않는다.
--   H2 쌍둥이의 지시 범위는 'owner'로 고정한다(표 제약 + 잠금 트리거). 주인이 allow를 넓히거나 조직 허용 잠금을 우회해 친구가 회사 서버 에이전트에게
--      지시할 수 없다. 이름·역할·상태도 주인이 직접 못 바꾼다(조직 봇 이름·역할을 바꾸는 RPC만 같이 바꾼다).
--   H3 쌍둥이 커서 = greatest(커서, least(ack, coalesce(personal_sent_id, 커서))) — least()는 NULL을 무시해 ack로 뛰던 식을 고쳤다.
--   H4 다시 핀(개인 쪽 토큰 고정)은 "호출자 = 쌍둥이 주인"일 때만. 서버 연결 승인은 그에 더해 "연결을 만든 사람 = 승인자".
--   M1 개인 경로에도 지문 게이트. 같은 지문이고 보류 중인 것(순차 멘션 대기·결과 미도착 실행)이 없으면 다시 훑지도 쓰지도 않는다(30초 갱신도 없음).
--      안내 글은 if not exists 뒤에만 넣는다(on conflict do nothing은 트리거·시퀀스를 태운다).
--   M3 백필은 근거가 있는 봇만 핀한다(마지막 회전이 주인, 서버 연결 봇은 연결 기록의 만든 사람 = 주인). 근거가 없으면 쌍둥이만 만들고
--      '다시 연결 필요'로 둔다 — 주인이 회전하거나 연결 명령을 다시 실행하면 살아난다.
--   M4 친구에게는 쌍둥이의 역할 문구(조직이 쓴 것)를 보이지 않는다. 쌍둥이에게 주는 문맥은 주인 글과 주인의 크루 글뿐(친구 글은 넣지 않는다).
--   M5 멈춘 쌍둥이를 부르면 서버가 그 방에 안내를 한 번 남긴다(옛 앱에서도 보인다).
--   M6 조직 상태: #779 개인 크루와 똑같이 개인 사용은 조직 상태(주인의 조직 탈퇴·연체 잠금·조직 소프트 삭제)에 묶지 않는다(유건 승인 원칙
--      "규칙은 #779와 같다"). 근거 — #779 개인 크루는 조직 행이 오프보딩으로 detached가 돼도(20260924100000:36은 org_id = 그 조직 행만) 개인 행은
--      그대로이고, 배달 판정의 잠금은 채널 조직 기준이라 개인 방은 잠기지 않으며(20260930210000:211 msgr_org_locked(ch.org_id), :292), 개인 방 분기는
--      조직 멤버십 대신 방 사람을 본다(:213-216, :175-181 지시 판정, :253 받은 글). 조직의 통제는 그대로 남는다: 관리자 폐기(쌍둥이 detached)·
--      다른 관리자의 회전(핀 불일치로 개인만 멈춤)·조직 완전 삭제(봇 연쇄 삭제 → 쌍둥이 detached).
--   LOW 쌍둥이 제약은 NOT VALID → VALIDATE, lock_timeout. org_sent_id 갱신은 greatest() 원자 갱신.
--
-- 오프셋(텔레그램 규율 offset = 마지막 update_id + 1 = ack): update_id는 메시지 id라 조직 글과 개인 글이 한 수열에 섞인다.
--   개인 글을 받은 적이 있는 봇은 조직 커서를 "실제로 보낸 조직 글의 최댓값(org_sent_id)"까지만, 쌍둥이 커서를 "실제로 보낸 개인 글의 최댓값
--   (personal_sent_id)"까지만 ack로 올린다 — 한쪽 ack가 다른 쪽의 보류 글을 건너뛰지 않게. 한 응답에 조직 글과 개인 글을 섞지 않는다
--   (조직 쪽이 0건일 때만 개인 쪽을 본다). 개인 배달은 실행 기록(msgr_executions)으로 한 번만 간다(개인 방에는 cc 배달이 없다).
--
-- DB 위생(부하): 봇 N대 × getUpdates(엣지 롱폴 대기 중 1초마다 RPC).
--   유휴: 개인 지문이 같고 보류가 없으면 msgr_bot_personal 한 행 + 지문 계산(쌍둥이 방의 (channel_id, id) 인덱스 범위·실행 기록 수)만 읽고 끝, 쓰기 0.
--   쓰기: 개인 배달 1건마다 실행 기록 1행 + msgr_bot_personal 1행(personal_sent_id), 조직 배달이 있는 호출마다 msgr_bot_personal 1행(org_sent_id —
--   쌍둥이가 있는 봇만), 지문이 바뀐 개인 스캔마다 msgr_bot_personal 1행(지문), 보류가 있으면 30초마다 1행(최대 순차 대기 2분·결과 미도착 10분).
--   쌍둥이 접속 표시는 조직 봇 행 시각을 빌린다(쓰기 0, msgr_personal_room_crews).
--   행 수: 쌍둥이·매핑은 살아 있는 봇 수만큼(폐기된 봇의 쌍둥이는 detached로 남는다 — 그 쌍둥이가 쓴 대화의 작성자 보존. 기억 데이터라 보존 기간 없음).

set local lock_timeout = '5s'; -- msgr_crews는 심박·폴링이 잦다 — 잠금을 오래 기다리며 뒤 요청을 줄 세우지 않고 실패한다(다시 실행하면 된다)

-- 1) 표 — 개인 행에 봇 쌍둥이를 허용하되 지시 범위는 주인만(H2). 제약 이름은 그대로(test/msgr-personal-crews-pg가 이 이름을 본다).
alter table public.msgr_crews drop constraint if exists msgr_crews_personal_local;
alter table public.msgr_crews add constraint msgr_crews_personal_local check (
  org_id is not null or hosting = 'local'
  or (hosting = 'bot' and allow = 'owner' and coalesce(cardinality(allow_users), 0) = 0)) not valid;
alter table public.msgr_crews validate constraint msgr_crews_personal_local;

create table if not exists public.msgr_bot_personal (
  bot_id uuid primary key references public.msgr_bots (id) on delete cascade,
  crew_id uuid not null unique references public.msgr_crews (id) on delete cascade, -- 쌍둥이(org_id NULL, hosting 'bot')
  pin_hash text not null,          -- 개인 쪽에서 받아 주는 토큰 해시. msgr_bots.token_hash와 같을 때만 개인 배달·발신(다른 관리자가 회전하면 개인만 멈춘다)
  org_sent_id bigint,              -- 실제로 보낸 조직 글의 최댓값(쌍둥이가 있는 봇만 기록) — 개인 글 ack가 조직 보류 글을 건너뛰지 않게
  personal_sent_id bigint,         -- 실제로 보낸 개인 글의 최댓값 — 조직 글 ack가 쌍둥이 커서를 밀지 않게(H3)
  scan_key text,                   -- 개인 경로 유휴 지문(M1)
  scan_at timestamptz,
  scan_pending boolean not null default false, -- 지문 밖의 시간 조건(순차 멘션 대기·결과 미도착)을 기다리는 중 — 이때만 30초마다 다시 훑는다
  created_at timestamptz not null default now()
);
alter table public.msgr_bot_personal enable row level security; -- 정책 없음: RPC만
revoke all on public.msgr_bot_personal from public, anon, authenticated;

-- 2) 쌍둥이 잠금(H2) — 지시 범위·이름·역할·상태는 RPC(트랜잭션 플래그 msgr.bot_twin)만 바꾼다. 얼굴·사진·소개는 주인이 바꿔도 된다.
--    WHEN 절로 쌍둥이 행만 함수를 부른다(하트비트마다 행 전체를 풀지 않게 — 20260916210000 TOAST 사고).
create or replace function public.msgr_bot_twin_lock() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('msgr.bot_twin', true), '') = '1' then return new; end if;
  if (new.allow, new.allow_users, new.status, new.display_name, new.role_text)
     is distinct from (old.allow, old.allow_users, old.status, old.display_name, old.role_text) then
    raise exception 'msgr_not_allowed' using errcode = '42501', detail = 'personal copy of an org agent follows the org agent (owner-only, name and role from the org)';
  end if;
  return new;
end $$;
revoke all on function public.msgr_bot_twin_lock() from public, anon, authenticated;
drop trigger if exists msgr_bot_twin_lock on public.msgr_crews;
create trigger msgr_bot_twin_lock before update on public.msgr_crews
  for each row when (old.hosting = 'bot' and old.org_id is null) execute function public.msgr_bot_twin_lock();

-- 3) 내부 함수
-- 쓸 수 있는 쌍둥이(없으면 NULL): 핀 = 지금 토큰, 봇 폐기 안 됨, 쌍둥이 active, 쌍둥이 주인 = 조직 봇 크루 주인.
-- 조직 상태(주인 탈퇴로 조직 행 detached·연체 잠금·소프트 삭제)는 보지 않는다 — #779 개인 크루와 같다(머리 주석 M6 근거).
create or replace function public._msgr_bot_twin(p_bot uuid) returns uuid
  language sql stable security definer set search_path = public, pg_temp as $$
  select t.id
    from public.msgr_bots b
    join public.msgr_bot_personal p on p.bot_id = b.id and p.pin_hash = b.token_hash
    join public.msgr_crews oc on oc.id = b.crew_id and oc.hosting = 'bot'
    join public.msgr_crews t on t.id = p.crew_id and t.status = 'active' and t.org_id is null and t.hosting = 'bot' and t.owner_user_id = oc.owner_user_id
   where b.id = p_bot and b.revoked_at is null
$$;
revoke all on function public._msgr_bot_twin(uuid) from public, anon, authenticated;

-- 쌍둥이를 만들고(없으면) 개인 쪽 토큰을 지금 토큰으로 고정한다. 호출자 판정(주인인가)은 부르는 쪽이 한다.
-- 새로 만들거나 핀이 바뀌면 쌍둥이 커서를 지금 끝으로 — 멈춰 있던 동안 쌓인 옛 글에 뒤늦게 답하지 않는다.
create or replace function public._msgr_bot_twin_pin(p_bot uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; oc public.msgr_crews; tw uuid; tail bigint;
begin
  select * into b from public.msgr_bots where id = p_bot;
  if b.id is null or b.revoked_at is not null then return null; end if;
  select * into oc from public.msgr_crews where id = b.crew_id;
  if oc.id is null or oc.hosting <> 'bot' then return null; end if;
  select coalesce(max(id), 0) into tail from public.msgr_messages;
  select crew_id into tw from public.msgr_bot_personal where bot_id = b.id;
  perform set_config('msgr.bot_twin', '1', true);
  if tw is null then
    perform set_config('msgr.bot_create', '1', true); -- msgr_crews_bot_guard: 봇 행은 RPC만
    insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow, allow_users, avatar_url, face, cursor_msg_id)
      values (null, oc.owner_user_id, 'bot', oc.slug, oc.display_name, oc.role_text, 'bot', 'active', 'owner', '{}', oc.avatar_url, oc.face, tail)
      returning id into tw;
    perform set_config('msgr.bot_create', '', true);
    insert into public.msgr_bot_personal (bot_id, crew_id, pin_hash) values (b.id, tw, b.token_hash);
  else
    update public.msgr_bot_personal set pin_hash = b.token_hash, scan_key = null where bot_id = b.id and pin_hash is distinct from b.token_hash;
    if found then update public.msgr_crews set cursor_msg_id = tail where id = tw and cursor_msg_id < tail; end if;
  end if;
  perform set_config('msgr.bot_twin', '', true);
  return tw;
end $$;
revoke all on function public._msgr_bot_twin_pin(uuid) from public, anon, authenticated;

-- 쌍둥이 상태 정리(폐기·봇 삭제): detached + 방 참여 행 삭제. 크루 행은 지우지 않는다(쌍둥이가 쓴 대화의 작성자 보존).
create or replace function public._msgr_bot_twin_detach(p_twin uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_twin is null then return; end if;
  perform set_config('msgr.bot_twin', '1', true);
  update public.msgr_crews set status = 'detached' where id = p_twin and status <> 'detached';
  perform set_config('msgr.bot_twin', '', true);
  delete from public.msgr_channel_members where member_kind = 'crew' and member_id = p_twin;
end $$;
revoke all on function public._msgr_bot_twin_detach(uuid) from public, anon, authenticated;

-- 봇이 지워지면(조직 삭제 연쇄 포함) 매핑도 지워진다 → 쌍둥이를 detached로.
create or replace function public.msgr_bot_personal_gone() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._msgr_bot_twin_detach(old.crew_id);
  return null;
end $$;
revoke all on function public.msgr_bot_personal_gone() from public, anon, authenticated;
drop trigger if exists msgr_bot_personal_gone on public.msgr_bot_personal;
create trigger msgr_bot_personal_gone after delete on public.msgr_bot_personal for each row execute function public.msgr_bot_personal_gone();

-- 개인 경로 유휴 지문(M1): 쌍둥이 방의 커서 뒤 글(최댓값·수), 쌍둥이 실행 기록(전체·진행 중), 참여 행 수, 주인의 AI 동의 시각, 배달 규약.
create or replace function public._msgr_bot_personal_key(p_twin uuid, p_after bigint, p_owner uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
  select (select coalesce(max(m.id), 0) || ':' || count(*) from public.msgr_channel_members cm
            join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > p_after
           where cm.member_kind = 'crew' and cm.member_id = p_twin)
    || ':' || (select count(*) || '/' || count(*) filter (where e.state = 'running') from public.msgr_executions e where e.crew_id = p_twin)
    || ':' || (select count(*) from public.msgr_channel_members where member_kind = 'crew' and member_id = p_twin)
    || ':' || coalesce((select extract(epoch from consent_at)::bigint::text from public.msgr_ai_consent where user_id = p_owner), '-')
    || ':' || coalesce(current_setting('argo.msgr_delivery_protocol', true), '')
$$;
revoke all on function public._msgr_bot_personal_key(uuid, bigint, uuid) from public, anon, authenticated;

-- 개인 쪽 getUpdates — msgr_bot_updates_before_work(조직)와 같은 판정을 쌍둥이 기준으로. before_work는 건드리지 않는다
-- (여러 브랜치가 번갈아 덮어써 게이트가 사라진 이력 — 20260927130000 머리 주석).
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
        '{"execution_status":"unknown","disposition":"done"}');
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
            '앱을 업데이트하고 AI 이용에 동의하면 크루에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to a crew.',
            jsonb_build_object('disposition', 'done'));
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
      'attachments', '[]'::jsonb, -- 개인 방 첨부는 아직 없다(msgr_attachments.org_id NOT NULL)
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
  -- 보류: 결과를 기다리는 실행(안내 전)이 있으면 30초마다 다시 본다
  pending := pending or exists (select 1 from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
     where e.crew_id = p_twin and e.state = 'running'
       and not exists (select 1 from public.msgr_messages x where x.channel_id = m.channel_id and x.client_msg_id = 'unknown:' || p_twin || ':' || m.id));
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

-- 멈춘 쌍둥이를 부르면 그 방에 안내를 한 번(M5) — 봇이 폴링하지 않아도(폐기 전 회전·주인 탈퇴) 사람 글 저장 시점에 남긴다.
-- 개인 방 사람 글에만 돈다(WHEN 절 — 조직 글은 함수를 부르지 않는다). 토큰이 바뀔 때마다(회전 시각) 새 안내 한 번.
create or replace function public.msgr_bot_twin_paused_notice() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare t record; k text;
begin
  for t in select p.bot_id, p.crew_id, b.rotated_at, b.created_at
             from public.msgr_channel_members cm join public.msgr_bot_personal p on p.crew_id = cm.member_id join public.msgr_bots b on b.id = p.bot_id
            where cm.channel_id = new.channel_id and cm.member_kind = 'crew' loop
    if public._msgr_bot_twin(t.bot_id) is not null then continue; end if;
    if not coalesce(public.msgr_delivery_target(t.crew_id, new.id), false) then continue; end if;
    k := 'paused:' || t.crew_id || ':' || new.channel_id || ':' || extract(epoch from coalesce(t.rotated_at, t.created_at))::bigint;
    if exists (select 1 from public.msgr_messages x where x.channel_id = new.channel_id and x.client_msg_id = k) then continue; end if;
    insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body, meta)
      values (new.channel_id, 'crew', t.crew_id, 'system', k,
        '이 외부 에이전트는 개인 공간에서 쓰려면 다시 연결해야 합니다. 조직에서 연결 명령을 다시 실행하거나 토큰을 새로 받으세요. / This external agent needs to be reconnected before it can answer in your personal space. Run the connect command again or get a new token in the organization.',
        jsonb_build_object('disposition', 'done'));
  end loop;
  return null;
end $$;
revoke all on function public.msgr_bot_twin_paused_notice() from public, anon, authenticated;
drop trigger if exists msgr_bot_twin_paused_notice on public.msgr_messages;
create trigger msgr_bot_twin_paused_notice after insert on public.msgr_messages
  for each row when (new.org_id is null and new.author_kind = 'user' and new.kind = 'text') execute function public.msgr_bot_twin_paused_notice();

-- 4) 봇 쪽 RPC 재정의 — 각각 가장 늦은 정의를 복사해 "방의 종류로 크루 고르기"만 더했다. 조직 채널 경로는 종전과 같다.

-- msgr_bot_updates: 20260929130000 본문 그대로 + (a) 개인 글을 받은 적 있는 봇은 조직 ack를 org_sent_id까지만 (b) 조직 배달 기록 (c) 조직 0건이면 개인 쪽.
create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item jsonb; w public.msgr_work_runs; bot public.msgr_bots; roster text; lead_name text; instruction text; root_row jsonb; goal_text text; crit_text text; relay_via text;
  bp public.msgr_bot_personal; org_after bigint := after_id; got int := 0; maxorg bigint := 0; twin uuid;
begin
  bot := public.msgr_bot_auth(token);
  if bot.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select * into bp from public.msgr_bot_personal where bot_id = bot.id;
  if bp.personal_sent_id is not null then org_after := least(coalesce(after_id, 0), coalesce(bp.org_sent_id, 0)); end if; -- 개인 글 ack가 조직 보류 글을 건너뛰지 않게
  for item in select * from public.msgr_bot_updates_before_work(token,org_after,lim) loop
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
    -- D5(크루 계약 1-a) — 다른 봇이 멘션해 1:1 방으로 전달된 글은 작성자가 사람(원 요청자)으로 기록된다(meta.relay). 받는 봇이
    -- 사람의 직접 지시로 착각하지 않게 전달한 봇 이름을 싣는다(2026-09-29 실측: 효원 멘션 → 각 봇이 "김유건 요청"으로 보고 거절·실행이 갈림).
    select m.meta->'relay'->>'via_name' into relay_via from public.msgr_messages m where m.id = (item->'message'->>'message_id')::bigint;
    if relay_via is not null then item := jsonb_set(item, '{message,relayed_by}', to_jsonb(relay_via)); end if;
    got := got + 1; maxorg := greatest(maxorg, coalesce((item->>'update_id')::bigint, 0));
    return next item;
  end loop;
  if bp.bot_id is null then return; end if; -- 쌍둥이 없는 봇은 종전과 똑같다
  if maxorg > 0 then -- 조직 배달 기록(원자 갱신 — 동시 호출에도 뒤로 가지 않는다)
    update public.msgr_bot_personal set org_sent_id = greatest(coalesce(org_sent_id, 0), maxorg) where bot_id = bot.id and coalesce(org_sent_id, 0) < maxorg;
  end if;
  if got > 0 then return; end if; -- 한 응답에 조직 글과 개인 글을 섞지 않는다
  twin := public._msgr_bot_twin(bot.id);
  if twin is null then return; end if;
  return query select * from public._msgr_bot_personal_updates(bot.id, twin, after_id, lim);
end $$;
revoke all on function public.msgr_bot_updates(text,bigint,int) from public;
grant execute on function public.msgr_bot_updates(text,bigint,int) to anon,authenticated;

-- msgr_bot_finish: 20260929120000 본문 그대로 + 개인 방이면 쌍둥이로(쓸 수 없으면 msgr_not_allowed). 개인 방은 조직 자격·확대 넘김 상한을 보지 않는다.
create or replace function public.msgr_bot_finish(token text, channel uuid, body text, src_id bigint, attempt uuid, disposition text, mentions jsonb default '[]') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; s public.msgr_messages; e public.msgr_executions; rid bigint; root_id bigint; origin_user uuid; hop int; target jsonb; dest uuid; cap int := 5; dropped int; reason text; n int; ch_kind text;
  cid uuid; personal boolean := false;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  personal := exists (select 1 from public.msgr_channels where id = channel and org_id is null);
  if personal then
    cid := public._msgr_bot_twin(b.id);
    if cid is null then raise exception 'msgr_not_allowed' using detail = 'personal use of this agent needs a reconnect'; end if;
  else cid := b.crew_id; end if;
  s := public.msgr_bot_source(cid, src_id, channel);
  select * into e from public.msgr_executions where crew_id = cid and source_msg_id = src_id for update;
  if attempt is null or e.attempt is distinct from attempt then raise exception 'msgr_execution_not_owner'; end if;
  if e.state = 'completed' then return e.reply_id; end if;
  if not personal and not coalesce(public.msgr_org_entitled(b.org_id), true) then
    update public.msgr_executions set state = 'completed', heartbeat_at = now() where crew_id = b.crew_id and source_msg_id = src_id;
    return null; -- 미자격 — 실행 행을 닫아 running으로 남기지 않는다(M3). 호출부(core.js)가 null을 403 msgr_org_unentitled로 바꾼다(LOW).
  end if;
  if disposition not in ('handoff', 'done') or disposition is null or jsonb_typeof(mentions) <> 'array' or mentions is null then raise exception 'msgr_bot_bad_disposition'; end if;
  if body is null or length(trim(body)) = 0 or length(body) > 20000 then raise exception 'msgr_bot_bad_body'; end if;
  root_id := case when s.author_kind = 'user' then s.id else s.thread_root end;
  select author_user_id into origin_user from public.msgr_messages where id = root_id;
  select count(*) into hop from public.msgr_messages where thread_root = root_id and channel_id=channel and author_kind = 'crew' and kind = 'text' and id>coalesce(public.msgr_work_round_start(root_id,channel),0);
  if disposition = 'done' then mentions := '[]'; end if;
  -- 사람이 직접 시킨 턴(원문이 사람 글)이고 그 사람이 봇 소유자·조직 소유자/관리자면 조직의 활성 에이전트 수까지 넘길 수 있다(전체 공지).
  -- 에이전트끼리 넘길 때(원문이 크루 글)는 5명 그대로 — 서로 부르며 폭주하는 것을 막는 상한.
  -- 에이전트가 DM에서 넘기면 전달 트리거가 받는 쪽 1:1에 사람 글(meta.relay.via_crew_id)을 새로 만든다 — 이건 사람 지시가 아니다(검수 #752 HIGH-1).
  -- 채널은 스레드 10홉 상한이 받은 답까지 막으므로 확대 상한을 9명으로 둔다(넘김 1 + 답 9). DM 넘김은 각자의 1:1로 전달되어 그 상한이 없다(검수 MEDIUM-2).
  -- 개인 방(2026-10-01)은 방 안의 크루만 부를 수 있어(무료 4명) 5명 그대로.
  select kind into ch_kind from public.msgr_channels where id = channel;
  if not personal and s.author_kind = 'user' and coalesce(s.meta->'relay'->>'via_crew_id', '') = ''
     and (s.author_user_id = (select owner_user_id from public.msgr_crews where id = b.crew_id)
      or exists (select 1 from public.msgr_org_members m where m.org_id = b.org_id and m.user_id = s.author_user_id
                 and m.removed_at is null and (m.expires_at is null or m.expires_at > now()) and m.role in ('owner', 'admin'))) then
    cap := (select count(*)::int from public.msgr_crews where org_id = b.org_id and status = 'active' and id <> b.crew_id);
    cap := greatest(5, case when ch_kind = 'dm' and (select count(*) from public.msgr_channel_members where channel_id = channel and member_kind = 'crew') = 1
                            then cap else least(cap, 9 - hop) end); -- 같은 방에서 답하는 넘김(채널·크루 여럿인 그룹 대화)은 10홉 안(재검수 MEDIUM-2)
  end if;
  -- 중복을 없앤 배열로 바꾼 뒤 센다 — 같은 크루 반복으로 상한을 피하거나 큰 배열이 반복문·저장을 키우지 않게(검수 LOW-4, 재검수 MEDIUM-1: 2만 개 반복 12초)
  select coalesce(jsonb_agg(v order by o), '[]'::jsonb) into mentions
    from (select distinct on (value->>'id') value as v, o from jsonb_array_elements(mentions) with ordinality e(value, o) order by value->>'id', (value->>'role' = 'cc'), o) d; -- 같은 크루가 cc·to로 겹치면 to를 남긴다(3차 검수 LOW)
  n := jsonb_array_length(mentions);
  -- 한도를 넘어도 답은 버리지 않는다 — 전달(멘션)만 빼고 일반 답으로 저장해 사장이 답과 사유를 본다.
  -- 종전엔 예외로 답 전체가 사라져 10분 뒤 "결과 미도착" 안내만 떴다(2026-09-29 페퍼 - v, 멘션 9명 → 409).
  if disposition = 'handoff' and (hop >= 10 or n > cap) then
    dropped := n; reason := case when hop >= 10 then 'hop' else 'mentions' end;
    mentions := '[]'; disposition := 'done';
  end if;
  for target in select value from jsonb_array_elements(mentions) loop
    if target->>'kind' is distinct from 'crew' then raise exception 'msgr_not_allowed'; end if;
    begin dest := (target->>'id')::uuid; exception when invalid_text_representation then raise exception 'msgr_not_allowed'; end;
    if dest is null or dest = cid or not exists (select 1 from public.msgr_crews c join public.msgr_channels ch on ch.id = channel
      where c.id = dest and c.status = 'active' and public.msgr_can_instruct(c.id, origin_user, channel)
      and public.msgr_can_instruct(c.id, (select owner_user_id from public.msgr_crews where id = cid), channel)
      and (case when personal then c.org_id is null and public.msgr_crew_in_channel(channel, c.id) -- 개인 방: 방 안의 개인 크루만
                else c.org_id = b.org_id and (ch.kind = 'dm' or public.msgr_crew_in_channel(channel, c.id)) end)) then raise exception 'msgr_not_allowed'; end if;
  end loop;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values(channel, 'crew', cid, 'text', src_id, root_id, 'reply:' || cid::text || ':' || src_id::text, body, mentions,
      jsonb_build_object('origin', origin_user, 'hop', hop, 'disposition', disposition)
        || case when dropped is null then '{}'::jsonb else jsonb_build_object('handoff_dropped', dropped, 'handoff_reason', reason) end) returning id into rid;
  update public.msgr_executions set state = 'completed', reply_id = rid, heartbeat_at = now() where crew_id = cid and source_msg_id = src_id;
  return rid;
end $$;
revoke all on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) from public;
grant execute on function public.msgr_bot_finish(text, uuid, text, bigint, uuid, text, jsonb) to anon, authenticated;

-- msgr_bot_send: 20260917090000 본문 그대로 + 개인 방이면 쌍둥이로. 먼저 보내기(답글 아님)는 쌍둥이가 그 방에 있고 주인과 방의 다른 사람 사이에 차단이 없을 때만.
create or replace function public.msgr_bot_send(token text, channel uuid, body text, src_id bigint default null) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; mid bigint; legacy_attempt uuid; cid uuid; personal boolean;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  personal := exists (select 1 from public.msgr_channels where id = channel and org_id is null and archived_at is null);
  if personal then
    cid := public._msgr_bot_twin(b.id);
    if cid is null then raise exception 'msgr_not_allowed' using detail = 'personal use of this agent needs a reconnect'; end if;
  else cid := b.crew_id; end if;
  if src_id is not null then
    select e.attempt into legacy_attempt from public.msgr_executions e where e.crew_id = cid and e.source_msg_id = src_id;
    return public.msgr_bot_finish(token, channel, body, src_id, legacy_attempt, 'done', '[]');
  end if;
  if personal then
    if not public.msgr_crew_in_channel(channel, cid) then raise exception 'msgr_bot_not_member'; end if;
    if exists (select 1 from public.msgr_channel_members u join public.msgr_crews t on t.id = cid
                 join public.msgr_friends f on f.a = least(t.owner_user_id, u.member_id) and f.b = greatest(t.owner_user_id, u.member_id) and f.status = 'blocked'
                where u.channel_id = channel and u.member_kind = 'user' and u.member_id <> t.owner_user_id) then raise exception 'msgr_not_allowed'; end if;
    if body is null or length(trim(body)) = 0 or length(body) > 20000 then raise exception 'msgr_bot_bad_body'; end if;
    insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, body, mentions, meta)
      values(channel, 'crew', cid, 'text', body, '[]', '{"disposition":"done"}') returning id into mid;
    return mid;
  end if;
  if not exists (select 1 from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
  if public.msgr_org_locked(b.org_id) or not exists (select 1 from public.msgr_crews c join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = c.owner_user_id and m.removed_at is null where c.id = b.crew_id and c.status = 'active') then raise exception 'msgr_not_allowed'; end if;
  if not exists (select 1 from public.msgr_channels ch where ch.id = channel and public.msgr_crew_in_channel(channel, b.crew_id)) then raise exception 'msgr_bot_not_member'; end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, body, mentions, meta)
    values(channel, 'crew', b.crew_id, 'text', body, '[]', '{"disposition":"done"}') returning id into mid;
  return mid;
end $$;

-- msgr_bot_typing 두 판: 20260918190000 본문 그대로 + 개인 방이면 쌍둥이로. 토픽은 msgr_room_topic(개인 방 = dm:<채널>).
create or replace function public.msgr_bot_typing(token text, channel uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; cid uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if exists (select 1 from public.msgr_channels where id = channel and org_id is null and archived_at is null) then
    cid := public._msgr_bot_twin(b.id);
    if cid is null then raise exception 'msgr_not_allowed'; end if;
    if not public.msgr_crew_in_channel(channel, cid) then raise exception 'msgr_bot_not_member'; end if;
    perform realtime.send(jsonb_build_object('channel_id', channel, 'crew_id', cid), 'typing', public.msgr_room_topic(channel), true);
    return;
  end if;
  if not exists (select 1 from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
  if not public.msgr_crew_in_channel(channel, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  perform realtime.send(jsonb_build_object('channel_id', channel, 'crew_id', b.crew_id), 'typing', public.msgr_room_topic(channel), true);
end $$;

create or replace function public.msgr_bot_typing(token text,channel uuid,src_id bigint,attempt uuid) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; cid uuid;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 if exists(select 1 from msgr_channels where id=channel and org_id is null and archived_at is null) then
   cid:=public._msgr_bot_twin(b.id);
   if cid is null then raise exception 'msgr_not_allowed'; end if;
 else
   if not exists(select 1 from msgr_channels where id=channel and org_id=b.org_id and archived_at is null) then raise exception 'msgr_bot_no_channel'; end if;
   cid:=b.crew_id;
 end if;
 if not msgr_crew_in_channel(channel,cid) and not exists(select 1 from msgr_executions e join msgr_messages s on s.id=e.source_msg_id
 where e.crew_id=cid and e.source_msg_id=src_id and e.attempt=$4 and e.state='running' and s.channel_id=channel and msgr_delivery_allowed(cid,s.id)) then raise exception 'msgr_bot_not_member'; end if;
 perform realtime.send(jsonb_build_object('channel_id',channel,'crew_id',cid),'typing',public.msgr_room_topic(channel),true);
end $$;

-- 5) 관리자 RPC — 쌍둥이 생성·핀·이름·역할·폐기
-- msgr_bot_create: 20260924180000 본문 그대로 + 쌍둥이(만든 사람 = 주인 = 토큰을 받은 사람이므로 바로 핀).
create or replace function public.msgr_bot_create(org uuid, kind text, name text, role_text text default null, external_id text default null) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare me uuid := auth.uid(); token text; crew uuid; bid uuid; nm text := btrim(coalesce(name, '')); ext text := nullif(btrim(coalesce(external_id, '')), '');
  dflt text := coalesce((select p.allow_default from public.msgr_org_policies p where p.org_id = org), 'owner');
begin
  if me is null or public.msgr_is_admin(org) is not true then raise exception 'msgr_admin_only' using detail = 'only org owner/admin can add an agent bot'; end if;
  if public.msgr_org_locked(org) then raise exception 'msgr_org_locked'; end if;
  if nm = '' or nm ~ '[\n\r]' then raise exception 'msgr_bot_name' using detail = 'bot name is required (single line)'; end if;
  if ext is not null and exists (select 1 from public.msgr_bots b where b.org_id = org and b.external_id = ext and b.revoked_at is null) then
    raise exception 'msgr_bot_exists' using detail = 'a bot for this agent already exists — rotate it instead';
  end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  perform set_config('msgr.bot_create', '1', true);
  insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow)
    values (org, me, 'bot', 'bot-' || left(replace(gen_random_uuid()::text, '-', ''), 12), nm, coalesce(nullif(btrim(role_text), ''), kind || ' agent'), 'bot', 'active', dflt)
    returning id into crew;
  perform set_config('msgr.bot_create', '', true);
  insert into public.msgr_bots (org_id, crew_id, kind, name, token_hash, token_hint, created_by, external_id)
    values (org, crew, kind, nm, public.msgr_bot_hash(token), left(token, 12), me, ext) returning id into bid;
  perform public.msgr_audit(org, 'bot.create', 'bot', bid::text, jsonb_build_object('kind', kind, 'name', nm, 'crew', crew, 'external_id', ext));
  perform public._msgr_bot_twin_pin(bid); -- 개인 공간 '내 에이전트'(2026-10-01)
  return jsonb_build_object('bot_id', bid, 'crew_id', crew, 'token', token);
end $$;

-- msgr_bot_rotate: 20260908120000 본문 그대로 + 호출자가 쌍둥이 주인일 때만 다시 핀(H4 — 다른 관리자가 받은 토큰으로 주인의 개인 대화가 가지 않게).
create or replace function public.msgr_bot_rotate(bot uuid) returns text
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare b public.msgr_bots; token text;
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  if b.revoked_at is not null then raise exception 'msgr_bot_revoked'; end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  update public.msgr_bots set token_hash = public.msgr_bot_hash(token), token_hint = left(token, 12), rotated_at = now() where id = bot;
  perform public.msgr_audit(b.org_id, 'bot.rotate', 'bot', bot::text, '{}'::jsonb);
  if auth.uid() = (select owner_user_id from public.msgr_crews where id = b.crew_id) then perform public._msgr_bot_twin_pin(bot); end if;
  return token;
end $$;

-- msgr_bot_revoke: 20260908120000 본문 그대로 + 쌍둥이도 detached·방에서 빠짐.
create or replace function public.msgr_bot_revoke(bot uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  update public.msgr_bots set revoked_at = coalesce(revoked_at, now()) where id = bot;
  update public.msgr_crews set status = 'detached' where id = b.crew_id; -- 기존 게이트 전부 status='active'를 보므로 지시·답글·멤버 자동 차단
  delete from public.msgr_channel_members where member_kind = 'crew' and member_id = b.crew_id;
  perform public._msgr_bot_twin_detach((select crew_id from public.msgr_bot_personal where bot_id = bot));
  perform public.msgr_audit(b.org_id, 'bot.revoke', 'bot', bot::text, '{}'::jsonb);
end $$;

-- msgr_bot_rename: 20260920071438 본문 그대로 + 쌍둥이 표기도 같이.
create or replace function public.msgr_bot_rename(bot uuid, new_name text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; nm text := btrim(coalesce(new_name, ''));
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then
    raise exception 'msgr_admin_only';
  end if;
  if public.msgr_org_locked(b.org_id) then raise exception 'msgr_org_locked'; end if;
  if b.revoked_at is not null then raise exception 'msgr_bot_revoked'; end if;
  if nm = '' or nm ~ '[\n\r]' or char_length(nm) > 80 then
    raise exception 'msgr_bot_name' using detail = 'bot name must be a single line of at most 80 characters';
  end if;

  update public.msgr_bots set name = nm where id = b.id;
  update public.msgr_crews set display_name = nm where id = b.crew_id;
  perform set_config('msgr.bot_twin', '1', true);
  update public.msgr_crews set display_name = nm where id = (select crew_id from public.msgr_bot_personal where bot_id = b.id) and display_name is distinct from nm;
  perform set_config('msgr.bot_twin', '', true);
  perform public.msgr_audit(b.org_id, 'bot.rename', 'bot', b.id::text, jsonb_build_object('name', nm, 'crew', b.crew_id));
end $$;

-- msgr_bot_set_role: 20260920073108 본문 그대로 + 쌍둥이 역할도 같이(친구에게는 msgr_personal_room_crews가 숨긴다 — M4).
create or replace function public.msgr_bot_set_role(bot_crew uuid, new_role_text text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; rt text := btrim(coalesce(new_role_text, ''));
begin
  select * into b from public.msgr_bots where crew_id = bot_crew and revoked_at is null;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then
    raise exception 'msgr_admin_only';
  end if;
  if public.msgr_org_locked(b.org_id) then raise exception 'msgr_org_locked'; end if;
  if rt = '' or rt ~ '[\n\r]' or char_length(rt) > 60 then
    raise exception 'msgr_bot_role' using detail = 'bot role must be a single line of at most 60 characters';
  end if;

  perform set_config('msgr.bot_role', '1', true);
  update public.msgr_crews set role_text = rt where id = b.crew_id;
  perform set_config('msgr.bot_twin', '1', true);
  update public.msgr_crews set role_text = rt where id = (select crew_id from public.msgr_bot_personal where bot_id = b.id) and role_text is distinct from rt;
  perform set_config('msgr.bot_twin', '', true);
  perform public.msgr_audit(b.org_id, 'bot.role', 'bot', b.id::text, jsonb_build_object('role_text', rt, 'crew', b.crew_id));
end $$;

-- msgr_server_link_approve: 20260923120000 본문 그대로 + 다시 핀은 "연결을 만든 사람 = 승인자 = 쌍둥이 주인"일 때만(H4).
--   새 봇: 만든 사람(승인자)이 주인이고 토큰은 연결 명령을 실행한 서버에 있다 — 연결을 만든 사람과 승인자가 같을 때만 핀.
--   재사용(같은 서버·같은 에이전트): 다른 관리자가 자기 연결을 자기가 승인해도 주인의 개인 쪽은 그 서버로 가지 않는다(멈춘다).
create or replace function public.msgr_server_link_approve(link uuid, picks jsonb) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare l public.msgr_server_links; p jsonb; a jsonb; ext text; b public.msgr_bots; made jsonb; out jsonb := '[]'::jsonb;
begin
  select * into l from public.msgr_server_links where id = link for update;
  if l.id is null or auth.uid() is null or public.msgr_is_admin(l.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  if l.expires_at <= now() then raise exception 'msgr_link_invalid'; end if;
  if l.status <> 'reported' then raise exception 'msgr_link_used'; end if;
  if jsonb_typeof(picks) is distinct from 'array' or jsonb_array_length(picks) = 0 then raise exception 'msgr_link_no_picks'; end if;
  for p in select * from jsonb_array_elements(picks) loop
    select e into a from jsonb_array_elements(l.agents) e where e->>'kind' = p->>'kind' and e->>'id' = p->>'id';
    if a is null then raise exception 'msgr_link_no_picks' using detail = 'unknown agent'; end if;
    if out @> jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id')) then continue; end if; -- 같은 에이전트 두 번 고름
    ext := 'vps:' || l.host || ':' || (a->>'kind') || ':' || (a->>'id');
    select * into b from public.msgr_bots where org_id = l.org_id and external_id = ext and revoked_at is null;
    if b.id is not null then
      update public.msgr_bots set token_hash = a->>'token_hash', token_hint = a->>'token_hint', rotated_at = now() where id = b.id;
      perform public.msgr_audit(l.org_id, 'bot.rotate', 'bot', b.id::text, jsonb_build_object('via', 'server_link', 'link', l.id));
      if l.created_by = auth.uid() and auth.uid() = (select owner_user_id from public.msgr_crews where id = b.crew_id) then perform public._msgr_bot_twin_pin(b.id); end if;
      out := out || jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id', 'bot_id', b.id, 'reused', true));
    else
      made := public.msgr_bot_create(l.org_id, a->>'kind', a->>'name', null, ext); -- 크루·봇·감사는 기존 경로 그대로. 원문 토큰은 버리고 서버가 만든 해시로 바꾼다
      update public.msgr_bots set token_hash = a->>'token_hash', token_hint = a->>'token_hint' where id = (made->>'bot_id')::uuid;
      if l.created_by = auth.uid() then perform public._msgr_bot_twin_pin((made->>'bot_id')::uuid); end if; -- 아니면 버린 원문 토큰의 핀에 머문다(멈춤 — 주인이 다시 연결)
      out := out || jsonb_build_array(jsonb_build_object('kind', a->>'kind', 'id', a->>'id', 'bot_id', made->>'bot_id', 'reused', false));
    end if;
  end loop;
  update public.msgr_server_links set status = 'approved', approved = out where id = l.id;
  return out;
end $$;

-- 6) 개인 공간 목록 — 20260930210000 정의 + bot_kind·org_label·ready(주인에게만). 친구에게는 쌍둥이 역할 문구를 숨긴다(M4).
--    org_label: 주인의 살아 있는 쌍둥이 중 같은 이름(대소문자 무시) 또는 같은 external_id가 둘 이상이면 조직 이름.
--    반환 열이 바뀌므로 drop 후 다시 만들고 권한을 다시 건다.
drop function if exists public.msgr_personal_room_crews();
create function public.msgr_personal_room_crews()
returns table(id uuid, org_id uuid, slug text, display_name text, role_text text, owner_user_id uuid, hosting text, status text,
              avatar_url text, face jsonb, department text, last_seen_at timestamptz, commands jsonb, bot_kind text, org_label text, ready boolean)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.org_id, c.slug, c.display_name,
         case when c.hosting = 'bot' and c.owner_user_id is distinct from auth.uid() then null else c.role_text end,
         c.owner_user_id, c.hosting, c.status, c.avatar_url, c.face, c.department,
         -- 접속: 방에 들지 않은 개인 행은 심박을 쓰지 않는다 — 같은 크루(주인·회사·slug)의 조직 행 시각을 빌린다(쓰기 0). 쌍둥이는 조직 봇 행 시각.
         greatest(c.last_seen_at, (select max(o.last_seen_at) from public.msgr_crews o where o.owner_user_id = c.owner_user_id and o.ws_id = c.ws_id and o.slug = c.slug and o.org_id is not null)),
         case when c.owner_user_id = auth.uid() then c.commands else null end,
         case when c.owner_user_id = auth.uid() then bb.kind end,
         case when c.owner_user_id = auth.uid() and bb.id is not null and exists (
                select 1 from public.msgr_bot_personal p2 join public.msgr_bots b2 on b2.id = p2.bot_id join public.msgr_crews c2 on c2.id = p2.crew_id
                 where c2.owner_user_id = c.owner_user_id and c2.status = 'active' and p2.bot_id <> bb.id
                   and (lower(c2.display_name) = lower(c.display_name) or (b2.external_id is not null and b2.external_id = bb.external_id)))
              then (select o.name from public.msgr_orgs o where o.id = bb.org_id) end,
         case when c.owner_user_id = auth.uid() and bp.bot_id is not null then public._msgr_bot_twin(bp.bot_id) is not distinct from c.id end
    from public.msgr_crews c
    left join public.msgr_bot_personal bp on bp.crew_id = c.id
    left join public.msgr_bots bb on bb.id = bp.bot_id
   where c.org_id is null and c.status <> 'available'
     and (c.owner_user_id = auth.uid()
          or exists (select 1 from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = ch.id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where cm.member_kind = 'crew' and cm.member_id = c.id))
$$;
revoke all on function public.msgr_personal_room_crews() from public, anon;
grant execute on function public.msgr_personal_room_crews() to authenticated;

-- 7) 기존 봇 백필(M3) — 폐기 안 된 봇(주인 = 만든 사람)마다 쌍둥이 하나. 조직 상태는 보지 않는다(#779와 같다, M6).
--    핀은 근거가 있을 때만: 마지막 회전 행위자가 주인(또는 회전 없음)이고, 그 회전이 서버 연결이면 그 연결을 만든 사람이 주인,
--    서버 연결로 만든 봇(external_id 'vps:%')은 연결 기록(approved에 이 봇)의 만든 사람이 주인. 아니면 '다시 연결 필요'(핀 'unpinned').
--    적용 전 운영 읽기 전용 대상 수 쿼리는 PR 본문에 있다. 다시 실행해도 같다(on conflict do nothing).
do $$
declare r record; tw uuid; tail bigint; pin boolean; last_rot record;
begin
  select coalesce(max(id), 0) into tail from public.msgr_messages;
  perform set_config('msgr.bot_create', '1', true);
  perform set_config('msgr.bot_twin', '1', true);
  for r in select b.id as bot_id, b.token_hash, b.external_id, b.org_id, oc.owner_user_id, oc.slug, oc.display_name, oc.role_text, oc.avatar_url, oc.face
             from public.msgr_bots b
             join public.msgr_crews oc on oc.id = b.crew_id and oc.hosting = 'bot' and oc.owner_user_id = b.created_by
            where b.revoked_at is null
              and not exists (select 1 from public.msgr_bot_personal p where p.bot_id = b.id) loop
    select a.actor_user_id, a.meta into last_rot from public.msgr_audit_log a
     where a.org_id = r.org_id and a.target_kind = 'bot' and a.target_id = r.bot_id::text and a.action = 'bot.rotate' order by a.at desc, a.id desc limit 1;
    pin := case
      when last_rot.actor_user_id is not null then last_rot.actor_user_id = r.owner_user_id
        and (coalesce(last_rot.meta->>'via', '') <> 'server_link'
             or exists (select 1 from public.msgr_server_links l where l.id::text = last_rot.meta->>'link' and l.created_by = r.owner_user_id))
      when r.external_id like 'vps:%' then exists (select 1 from public.msgr_server_links l
             where l.org_id = r.org_id and l.created_by = r.owner_user_id and l.approved @> jsonb_build_array(jsonb_build_object('bot_id', r.bot_id::text)))
      else true end;
    insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow, allow_users, avatar_url, face, cursor_msg_id)
      values (null, r.owner_user_id, 'bot', r.slug, r.display_name, r.role_text, 'bot', 'active', 'owner', '{}', r.avatar_url, r.face, tail)
      on conflict do nothing returning id into tw;
    if tw is not null then
      insert into public.msgr_bot_personal (bot_id, crew_id, pin_hash) values (r.bot_id, tw, case when pin then r.token_hash else 'unpinned' end) on conflict do nothing;
    end if;
    tw := null; last_rot := null;
  end loop;
  perform set_config('msgr.bot_create', '', true);
  perform set_config('msgr.bot_twin', '', true);
end $$;

notify pgrst, 'reload schema';
