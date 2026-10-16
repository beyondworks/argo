-- 메신저 서비스 일시 중단 스위치(2026-10-16 유건 결정: 안정화를 위해 "공지 후 바로" 멈춘다. 데이터 이관은 별도).
-- 배포된 메신저 앱(0.1.60~0.1.63)에는 원격 점검 화면이 없어 서버만으로 막는다.
--
-- 스위치: public.msgr_settings 한 줄 — key = 'msgr_paused', value = 공지 시각(ISO 문자열, 예 '2026-10-16T17:00:00+09:00').
--   행이 없으면 이 마이그레이션 전과 똑같이 동작한다(모든 판정이 "행 있음"일 때만 갈린다).
--   켜기: insert into public.msgr_settings (key, value) values ('msgr_paused', '<시각>');  → 이어서 select public.msgr_pause_announce('<ko>', '<en>');
--   끄기: delete from public.msgr_settings where key = 'msgr_paused';   (공지 글은 기록으로 남는다 — 기억 데이터는 지우지 않는다)
--
-- 켜져 있는 동안
--   1) 쓰기 거부 — 아래 표의 INSERT를 트리거 a0_msgr_pause_guard가 맨 먼저(이름 순) 막는다. RLS(사람 직접 쓰기)·security definer 함수(크루·봇·초대 RPC)·
--      service_role(엣지 msgr-bot) 모두 이 트리거를 지나므로 경로별로 따로 막지 않는다. 오류: errcode 42501 'msgr_forbidden (… row-level security …, messenger service paused)' — 기존 앱·엣지 응답은 PR 본문 표.
--        msgr_messages(새 글 — 사람·크루·봇·자동화), msgr_channels(방 만들기), msgr_channel_members(초대·참여), msgr_invites·msgr_invite_uses·msgr_org_members·msgr_orgs
--        (조직 초대·가입·만들기), msgr_friends(친구 요청 — 차단 'blocked'은 안전 기능이라 그대로), msgr_channel_crew_requests·msgr_crew_requests·msgr_executions·
--        msgr_automations·msgr_automation_runs·msgr_crew_routine_edits(크루 지시), msgr_org_announcements(조직 공지), msgr_attachments(첨부 행 — 새 글에 딸린다)
--      예외: msgr_pause_announce가 넣는 kind='system' 공지(트랜잭션 설정 msgr.pause_notice='1'). 사용자는 PostgREST로 set_config를 부를 수 없다.
--   2) 크루·봇이 새 턴을 돌리지 않는다(서버만으로 — 옛 본체 앱도) — 받은 글(msgr_crew_inbox·msgr_crew_inbox_many)·봇 업데이트(msgr_bot_updates)는 빈 결과,
--      자동화 디스패치(msgr_automation_dispatch_due·_cloud)는 빈 배열. 중단 전에 쌓인 글로 턴을 돌린 뒤 답 쓰기가 막혀 같은 턴을 되풀이하는 것(AI 비용)을 막는다.
--   3) 기기 심박(msgr_device_beat)은 쓰지 않고 {"paused": true, "since": …}를 돌려준다 — 새 본체 앱은 이 표지를 보고 30분에 한 번만 확인한다(src/gateway/msgr.mjs).
--   읽기(메시지·방·첨부·목록)는 막지 않는다 — 이관(Argo가 사용자 데이터를 읽어 감)이 끝날 때까지 그대로.
--
-- 감싸기 방식: 큰 함수(msgr_crew_inbox_many 6천 자·msgr_bot_updates 4천 자·msgr_device_beat)를 본문째 다시 정의하지 않는다 — 저장소와 운영 정의가 조금이라도 다르면
--   본문 복사가 운영 함수를 바꾼다. 대신 이름을 _<이름>_core로 바꾸고(본문·소유자·security definer 그대로), 같은 이름·인자·기본값의 얇은 감싸개를 둔다.
--   core는 사용자 역할에서 실행 권한을 거둔다(감싸개를 건너뛰지 못하게). 감싸개는 core를 부를 때 중단이 아니면 결과를 그대로 넘긴다.
--   주의: 이후 마이그레이션이 이 다섯 함수를 create or replace로 본문째 다시 정의하면 감싸개가 사라진다 — 그때는 core를 고치거나 같은 판정을 넣는다.
-- 되돌리기(스위치 말고 이 마이그레이션 자체): scripts/rollback/20261016170000_msgr_service_pause.down.sql(한 트랜잭션 — 감싸개 drop → core 원래 이름 → 원래 권한 →
--   트리거·판정·공지 함수 drop → 디스패치 base 본문). 시험 test/msgr-service-pause-rollback-pg.test.mjs가 '적용 → 되돌림 = 적용 전'을 잠근다.
set local lock_timeout = '5s';

-- 판정 한 곳. msgr_settings는 RLS 켬·정책 없음(비밀값 행이 같은 표에 있다)이라 security definer로 정해진 키 하나만 본다.
create or replace function public._msgr_paused() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_settings where key = 'msgr_paused')
$$;
revoke all on function public._msgr_paused() from public, anon, authenticated;

-- 앱·본체가 읽는 상태(argo_min_app_version과 같은 방식) — 켜짐 {"paused":true,"since":"<값>"}, 꺼짐 null. 로그인 전에도 부를 수 있다.
create or replace function public.msgr_service_pause() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('paused', true, 'since', s.value) from public.msgr_settings s where s.key = 'msgr_paused'
$$;
revoke all on function public.msgr_service_pause() from public;
grant execute on function public.msgr_service_pause() to anon, authenticated, service_role;

-- 2)·3) 감싸개 — core로 이름을 바꾼다(다시 적용해도 한 번만: core가 이미 있으면 건너뛴다)
do $$
begin
  if to_regprocedure('public._msgr_crew_inbox_core(text,uuid,bigint,integer)') is null and to_regprocedure('public.msgr_crew_inbox(text,uuid,bigint,integer)') is not null then
    alter function public.msgr_crew_inbox(text, uuid, bigint, integer) rename to _msgr_crew_inbox_core;
  end if;
  if to_regprocedure('public._msgr_crew_inbox_many_core(text,jsonb,integer)') is null and to_regprocedure('public.msgr_crew_inbox_many(text,jsonb,integer)') is not null then
    alter function public.msgr_crew_inbox_many(text, jsonb, integer) rename to _msgr_crew_inbox_many_core;
  end if;
  if to_regprocedure('public._msgr_bot_updates_core(text,bigint,integer)') is null and to_regprocedure('public.msgr_bot_updates(text,bigint,integer)') is not null then
    alter function public.msgr_bot_updates(text, bigint, integer) rename to _msgr_bot_updates_core;
  end if;
  if to_regprocedure('public._msgr_device_beat_core(text,text,uuid[],text)') is null and to_regprocedure('public.msgr_device_beat(text,text,uuid[],text)') is not null then
    alter function public.msgr_device_beat(text, text, uuid[], text) rename to _msgr_device_beat_core;
  end if;
end $$;
revoke all on function public._msgr_crew_inbox_core(text, uuid, bigint, integer) from public, anon, authenticated;
revoke all on function public._msgr_crew_inbox_many_core(text, jsonb, integer) from public, anon, authenticated;
revoke all on function public._msgr_bot_updates_core(text, bigint, integer) from public, anon, authenticated; -- service_role은 건드리지 않는다(되돌림이 원래 권한을 그대로 복원하게 — scripts/rollback)
revoke all on function public._msgr_device_beat_core(text, text, uuid[], text) from public, anon, authenticated;

create or replace function public.msgr_crew_inbox(p_ws text, p_crew uuid, p_after bigint default 0, p_limit integer default 100) returns setof public.msgr_messages
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._msgr_paused() then return; end if; -- 중단 중: 새 턴 없음(읽기 권한 판정·쓰기도 하지 않는다)
  return query select * from public._msgr_crew_inbox_core(p_ws, p_crew, p_after, p_limit);
end $$;
revoke all on function public.msgr_crew_inbox(text, uuid, bigint, integer) from public, anon;
grant execute on function public.msgr_crew_inbox(text, uuid, bigint, integer) to authenticated;

create or replace function public.msgr_crew_inbox_many(p_ws text, p_items jsonb, p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 중단 중: 에이전트마다 빈 목록(응답 모양은 유휴 틱과 같다 — 옛 앱이 그대로 읽는다). 소유 판정 없이 빈 것만 돌려주므로 남의 에이전트 정보도 나가지 않는다
  if public._msgr_paused() then
    return jsonb_build_object('messages', '[]'::jsonb, 'crews', coalesce((
      select jsonb_agg(jsonb_build_object('crew', e->>'crew', 'ids', '[]'::jsonb) order by o)
        from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) with ordinality as t(e, o)), '[]'::jsonb));
  end if;
  return public._msgr_crew_inbox_many_core(p_ws, p_items, p_limit);
end $$;
revoke all on function public.msgr_crew_inbox_many(text, jsonb, integer) from public, anon;
grant execute on function public.msgr_crew_inbox_many(text, jsonb, integer) to authenticated;

create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if public._msgr_paused() then return; end if; -- 중단 중: 봇(Hermes 등)에 새 업데이트 없음 — 엣지 롱폴은 빈 결과로 끝난다
  return query select * from public._msgr_bot_updates_core(token, after_id, lim);
end $$;
revoke all on function public.msgr_bot_updates(text, bigint, integer) from public;
grant execute on function public.msgr_bot_updates(text, bigint, integer) to anon, authenticated; -- 원래 권한(20261001140000)과 같다

create or replace function public.msgr_device_beat(p_ws text, p_device text, p_crews uuid[], p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare since text;
begin
  select s.value into since from public.msgr_settings s where s.key = 'msgr_paused';
  if found then
    if auth.uid() is null then raise exception 'msgr_device_beat_forbidden' using errcode = '42501'; end if; -- 원래 함수와 같은 거절(로그인 없음)
    return jsonb_build_object('paused', true, 'since', since); -- 쓰기 0
  end if;
  return public._msgr_device_beat_core(p_ws, p_device, p_crews, p_app_version);
end $$;
revoke all on function public.msgr_device_beat(text, text, uuid[], text) from public, anon;
grant execute on function public.msgr_device_beat(text, text, uuid[], text) to authenticated;

-- 자동화 디스패치(작은 함수라 본문째 — 20260913110000과 같고 중단 판정만 더한다). 크론(매분 _cloud)이 중단 중에 오류를 내지 않게 빈 배열.
create or replace function public.msgr_automation_dispatch_due(p_ws text) returns jsonb
language sql security definer set search_path = public, pg_temp as $$
  select case when public._msgr_paused() then '[]'::jsonb else public.msgr_automation_dispatch_internal(p_ws, false) end
$$;
create or replace function public.msgr_automation_dispatch_cloud() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare result jsonb;
begin
  result := case when public._msgr_paused() then '[]'::jsonb else public.msgr_automation_dispatch_internal(null, true) end;
  insert into public.msgr_automation_scheduler(id, last_tick_at) values (true, now()) on conflict (id) do update set last_tick_at = excluded.last_tick_at; -- 크론 상태 표시는 그대로(종전 쓰기)
  return result;
end $$;

-- 4) 공지 글 — 켠 뒤 서비스 계정(service_role·운영자)이 한 번 부른다. 문구는 인자(ko·en 두 줄, 승인 대기). 활성 방마다 kind='system' 1건, 다시 불러도 같은 방에는 넣지 않는다
--    (meta.msgr_pause = 스위치 값 — 같은 중단 회차의 공지는 한 번). 활성 방 = 보관·삭제되지 않은 방(아래 조건). 반환: 넣은 방 수.
create or replace function public.msgr_pause_announce(p_ko text, p_en text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare since text; n int;
begin
  select s.value into since from public.msgr_settings s where s.key = 'msgr_paused';
  if not found then raise exception 'msgr_not_paused' using errcode = '22023'; end if;
  if coalesce(btrim(p_ko), '') = '' or coalesce(btrim(p_en), '') = '' or length(p_ko) > 2000 or length(p_en) > 2000 then raise exception 'msgr_pause_text_invalid' using errcode = '22023'; end if;
  perform set_config('msgr.pause_notice', '1', true);
  insert into public.msgr_messages (channel_id, author_kind, kind, body, meta)
  select ch.id, 'system', 'system', p_ko || E'\n' || p_en, jsonb_build_object('msgr_pause', since, 'ko', p_ko, 'en', p_en)
    from public.msgr_channels ch
   where ch.archived_at is null
     and not exists (select 1 from public.msgr_messages m where m.channel_id = ch.id and m.kind = 'system' and m.meta->>'msgr_pause' = since);
  get diagnostics n = row_count;
  perform set_config('msgr.pause_notice', '', true);
  return n;
end $$;
revoke all on function public.msgr_pause_announce(text, text) from public, anon, authenticated;
grant execute on function public.msgr_pause_announce(text, text) to service_role;

-- 1) 쓰기 거부 트리거 — 파일 끝에 둔다(시험 msgr-bot-err-contract는 함수 본문을 다음 create function까지 읽는다 — 트리거 함수 뒤에 다른 함수 이름이 섞이지 않게)
create or replace function public.msgr_pause_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  if not public._msgr_paused() then return new; end if;
  r := to_jsonb(new); -- 표마다 열이 달라 new.<열>을 직접 읽지 않는다(PL/pgSQL은 and 앞이 거짓이어도 뒤 식의 열을 찾는다)
  if tg_table_name = 'msgr_messages' and r->>'kind' = 'system' and coalesce(current_setting('msgr.pause_notice', true), '') = '1' then return new; end if;
  if tg_table_name = 'msgr_friends' and r->>'status' = 'blocked' then return new; end if; -- 차단은 안전 기능(msgr_friend_remove)
  -- 문구·코드는 이미 배포된 쪽이 아는 모양에 맞췄다(PR 표): 42501 = 메신저 글 보내기 카드 "이 방에 보낼 수 없습니다"(다시 시도 없음)·본체 큐 영구 오류(재시도 없음),
  -- 첫 토큰 msgr_forbidden = 엣지 msgr-bot ERR의 403(모르는 이름이면 500 → Hermes outbox 재시도, msgr-bot-err-contract), 'row-level security' = 토스트·초대 창 "권한이 없습니다".
  -- 'messenger service paused'로 새 앱은 가려 읽을 수 있다. 'read-only'는 넣지 않는다("읽기 전용(계정 상태)"로 오해).
  raise exception 'msgr_forbidden (new row violates row-level security policy, messenger service paused)' using errcode = '42501';
end $$;
revoke all on function public.msgr_pause_guard() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['msgr_messages', 'msgr_channels', 'msgr_channel_members', 'msgr_invites', 'msgr_invite_uses', 'msgr_org_members', 'msgr_orgs',
                           'msgr_friends', 'msgr_channel_crew_requests', 'msgr_crew_requests', 'msgr_executions', 'msgr_automations', 'msgr_automation_runs',
                           'msgr_crew_routine_edits', 'msgr_org_announcements', 'msgr_attachments'] loop
    if to_regclass('public.' || t) is null then continue; end if; -- 일부 표만 있는 시험 DB
    execute format('drop trigger if exists a0_msgr_pause_guard on public.%I', t);
    execute format('create trigger a0_msgr_pause_guard before insert on public.%I for each row execute function public.msgr_pause_guard()', t);
  end loop;
end $$;

notify pgrst, 'reload schema';
