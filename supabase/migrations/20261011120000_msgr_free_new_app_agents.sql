-- 무료 계정도 최신 앱이면 메신저 에이전트 4명까지(유건 2026-10-11 결정).
-- 배경: #941(20261010200000)은 Pro가 아닌 계정의 사람 에이전트를 전부 paused로 두었다(옛 게이트웨이의 15초 조회를 멈추려고).
--   #943(게이트웨이 Realtime 깨우기)이 들어간 앱부터는 쉬는 동안 호출이 회사당 분당 약 4건이고 에이전트 수와 무관하다 — 그 앱이면 무료 계정도 비용이 감당된다.
-- 규칙(무료 = public.is_pro_for가 false. Pro·운영자 부여·유료 조직 좌석·남은 체험은 지금처럼 제한 없음):
--   ① 최신 앱: 그 주인의 기기 중 최근 30분 안에 최소 버전 이상으로 심박을 보낸 기기가 있을 때만 사람 에이전트가 active일 수 있다.
--      버전은 게이트웨이가 기기 심박(msgr_device_beat, #924)에 함께 싣는다(p_app_version). 옛 앱(0.1.101 이하)은 버전을 싣지 않는다 → 지금처럼 멈춘다.
--   ② 4명: active 에이전트(같은 회사·같은 이름 = 한 명 — 조직 행·개인 행이 여럿이어도)는 최대 4명.
--   ③ 봇 연결(Hermes·OpenClaw, hosting='bot')은 지금처럼 Pro 전용(msgr_bot_gate 그대로, 이 파일은 손대지 않는다).
-- 값(한 곳 — _msgr_free_agent_policy):
--   최소 버전 = 설정 msgr_settings.free_agent_min_app(없거나 형식이 틀리면 '0.1.102'). 발행 때 설정 한 줄로 바꾼다(함수를 다시 만들 필요 없음).
--     버전을 고른 이유: 서버가 따로 아는 것 없이 "이 앱이 #943을 담았나"를 발행 번호 하나로 정할 수 있다. 개발 빌드(상주 :3001)는 package.json이
--     직전 발행 번호라 옛 앱으로 판정된다 — 무료 계정으로 개발 빌드를 시험하려면 시험 DB의 설정 값을 낮춘다(Pro 계정은 상관없다).
--   한도 = 4(무료 플랜의 기존 수 — msgr_personal_room_cap '나를 포함해 4명'과 같은 숫자. 그쪽은 방 인원이라 함수 안의 숫자로 따로 있다).
--   창 = 30분. 기기 심박 기록 간격(쉬는 동안 40~55초, #924·#943)의 약 35배이고 10분 크론 세 번이다 — 재시작·업데이트 설치·짧은 잠자기로는 멈추지 않는다.
--     더 길면 옛 앱만 남은 계정(맥 새 앱 꺼짐 + VPS 옛 CLI)이 그만큼 더 옛 방식으로 조회한다. 그보다 오래 꺼져 있다 켜지면 재개 때 커서를 끝으로 옮기므로
--     (#941 _msgr_crew_plan_resume) 꺼진 동안 에이전트에게 온 글에는 답하지 않는다(글은 남는다).
-- 반영 시점:
--   · 새 앱 심박이 처음 들어오면(이 주인이 새 앱 판정이 아니었다가 이 심박으로 바뀌면) 심박 함수 안에서 그 주인만 바로 sweep — 10분 기다리지 않는다.
--   · 그 밖(새 앱이 30분 넘게 없음 → 멈춤, 설정 값 변경 등)은 기존 10분 크론 msgr_crews_plan_sweep.
--   · 사람의 연결(설정 카드·메신저 파견 — available·paused→active)은 그 자리에서 그 주인만 sweep(4-1) — 같은 에이전트의 다른 공간 행이 함께 연결된다(화면 검수 A).
--   · 재개·정지는 #941 경로 그대로: 멈춤 = status 'paused'(기록은 msgr_crews_pro_gate_log), 재개 = _msgr_crew_plan_resume(커서 끝으로·기록 닫기·밀린 자동화 정리). 데이터는 지우지 않는다.
-- 누구를 재개하나: 그 주인의 에이전트가 전부 멈춘 상태(active 0명)일 때만 최근 대화 순 4명 — 실행 기록 msgr_executions의 마지막 글·사람이 고른 순간 중 늦은 것 →
--   (동점이면) 교체로 멈춘 뒤 대화가 없는 에이전트는 뒤로 → 고른 순간 → 만든 순. 커서는 쓰지 않는다 — 재개가 커서를 끝으로 옮기므로 대화가 아니다(화면 검수 C, 10/11).
--   연결된 에이전트가 하나라도 있으면 빈자리를 자동으로 채우지 않는다 — 사람이 해제해 비운 자리에 다른 에이전트가 끼어들지 않게. 사람이 고른 에이전트를 연결하는 것
--   (설정의 연결·메신저의 파견)은 한도 안에서 허용하고, 한도를 넘는 사람의 연결(available→active)은 msgr_free_agent_limit으로 거절한다.
--   active가 4명을 넘으면(Pro→무료 전환 등) 최근 대화가 적은 쪽부터 멈춘다.
-- 오류 문구: 'msgr_free_agent_limit msgr_pro_required' / 'msgr_app_update_required msgr_pro_required' — 뒤의 msgr_pro_required는 설치된 메신저·본체가 이미 알아보는 코드라
--   옛 앱에서도 원문 대신 "Pro가 필요합니다" 안내가 보이게 둔다. 새 앱은 앞 코드를 먼저 본다.
-- 메신저 안내: msgr_my_agent_pause() — 로그인한 사람의 멈춘 에이전트 수와 이유('app' 옛 앱 · 'off' 새 앱이 꺼져 있음 · 'limit' 4명 한도 · null).
--
-- 부하(DB 위생):
--   · 심박: 버전은 같은 갱신 문장의 열 두 개(app_version·app_seen_at)라 쓰기 수가 늘지 않는다(기록 기한 35초 그대로). 버전이 실린 심박은 이 주인의 기기 행을
--     한 번 더 읽는다(주인당 50행 상한, 기본 키 앞부분). 새 앱 판정이 바뀌는 심박에서만 그 주인 sweep(읽기 + 바뀐 행만 쓰기).
--   · 옛 읽기 호환(행 last_seen_at)은 active 행만 — 새 앱이 멈춘 행 id도 심박에 싣기 때문(멈춘 에이전트만 있는 회사도 기기 행이 있어야 새 앱을 안다).
--   · 관문: 무료 계정의 active 전환에서만 기기 행 조회 + 주인 행 수 세기(행이 바뀔 때만).
--   · 크론: 10분마다 주인마다 질의 1번(그 주인 행 + 실행 기록 색인). 바뀔 것이 없으면 쓰기 0(시험 [유휴]).
-- 적용: bash scripts/msgr-live-apply.sh 20261011120000_msgr_free_new_app_agents — drop function이 있어 스크립트가 선잠금·재시도를 한다(#872).
--   적용만으로는 아무도 재개되지 않는다(새 앱 심박이 아직 없다). 최소 버전 설정은 발행 직전에(아래 PR 본문 순서).
-- 되돌리기(데이터를 지우지 않는다): 20261010200000의 msgr_crews_pro_gate·msgr_crews_plan_sweep 정의를 다시 적용하면 무료 계정은 다시 전부 멈춘다(다음 크론).
--   심박 함수는 새 정의를 그대로 둬도 된다(버전 칸만 더 쓴다). 열 두 개(app_version·app_seen_at)는 남겨도 무해하다.

-- 0) 값 한 곳 + 버전 비교
create or replace function public._msgr_app_ver(v text) returns int[]
  language sql immutable set search_path = public, pg_temp as $$
  select case when v ~ '^v?[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}' then (regexp_match(v, '^v?([0-9]{1,6})\.([0-9]{1,6})\.([0-9]{1,6})'))::int[] end
$$;
revoke all on function public._msgr_app_ver(text) from public, anon, authenticated;

create or replace function public._msgr_free_agent_policy(out min_app text, out agent_limit int, out window_s int)
  language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select s.value from public.msgr_settings s where s.key = 'free_agent_min_app' and public._msgr_app_ver(s.value) is not null), '0.1.102'),
         4,     -- 무료 플랜의 에이전트 수(머리말)
         1800   -- 새 앱 심박 창 30분(머리말)
$$;
revoke all on function public._msgr_free_agent_policy() from public, anon, authenticated;

-- 1) 기기 심박에 앱 버전 — 열 두 개(빈 값 허용, 표 다시 쓰기 없음). app_seen_at = 버전이 실린 마지막 심박(옛 앱 심박은 seen_at만 고친다 — 같은 기기에서
--    옛 CLI와 새 앱이 함께 돌아도 옛 심박이 새 앱 판정을 늘리지 않게).
alter table public.msgr_device_beats add column if not exists app_version text;
alter table public.msgr_device_beats add column if not exists app_seen_at timestamptz;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'msgr_device_beats_app_version_len') then
    alter table public.msgr_device_beats add constraint msgr_device_beats_app_version_len check (app_version is null or length(app_version) <= 40);
  end if;
end $$;

-- 2) 판정 — 그 주인이 지금 새 앱을 켜 두었나 / active 에이전트 수(같은 회사·이름 = 한 명)
create or replace function public._msgr_free_app_ok(p_uid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_device_beats d, public._msgr_free_agent_policy() p
                  where d.owner_user_id = p_uid and d.app_seen_at > now() - make_interval(secs => p.window_s)
                    and public._msgr_app_ver(d.app_version) >= public._msgr_app_ver(p.min_app))
$$;
revoke all on function public._msgr_free_app_ok(uuid) from public, anon, authenticated;

create or replace function public._msgr_free_active_agents(p_uid uuid) returns int
  language sql stable security definer set search_path = public, pg_temp as $$
  select count(distinct (c.ws_id, c.slug))::int from public.msgr_crews c where c.owner_user_id = p_uid and c.hosting <> 'bot' and c.status = 'active'
$$;
revoke all on function public._msgr_free_active_agents(uuid) from public, anon, authenticated;

-- 2-1) 사람이 고른 에이전트(검수 #945 MEDIUM-1·LOW-3) — 무료 계정의 사람이 연결을 누른 순간을 '지금 대화한 것'으로 센다(chosen_msg = 그때의 마지막 글 id —
--      실행 기록의 글 id와 같은 축). 자동 재개·한도 초과 정리·교체 대상 고르기가 모두 이 점수(실행 기록과 고른 순간 중 늦은 것)를 쓴다 —
--      설정에서 연결한 에이전트가 뒤이은 심박 재개나 크론에 밀려나지 않게. swapped_out = 이 연결로 쉬게 된 에이전트(교체 안내).
--      보존: 에이전트 행 하나에 한 줄(행이 지워지면 함께), 사람이 연결을 누를 때만 쓴다.
create table if not exists public.msgr_free_choices (
  crew_id uuid primary key references public.msgr_crews(id) on delete cascade,
  owner_user_id uuid not null,
  chosen_msg bigint not null default 0,
  chosen_at timestamptz not null default now(),
  swapped_out uuid,
  swapped_at timestamptz
);
alter table public.msgr_free_choices enable row level security; -- 정책 없음 = 클라이언트 접근 0 (정의자 함수만)
revoke all on public.msgr_free_choices from public, anon, authenticated;
create index if not exists msgr_free_choices_owner_idx on public.msgr_free_choices (owner_user_id); -- 주인 하나의 교체 기록(아래 _msgr_free_benched — sweep·관문)

-- 2-1-1) 교체로 멈춘 뒤 대화가 없는 에이전트(화면 검수 C, 10/11) — 순위 동점에서 뒤로 둔다(sweep은 남길 순서의 뒤, 관문은 교체 대상의 앞).
--        사람이 다른 에이전트를 고르며 이 에이전트를 멈췄고(swapped_out), 그 순간의 마지막 글(chosen_msg) 뒤로 이 에이전트의 대화·선택이 없으면 true.
--        Pro 재개가 커서를 끝으로 옮겨도 '최근 대화'로 앞서지 않게 하려는 것 — 그 뒤 실제로 대화하거나 사람이 다시 고르면 점수가 chosen_msg 이상이 되어 풀린다.
create or replace function public._msgr_free_benched(p_uid uuid, p_ws text, p_slug text, p_score bigint) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_free_choices ch join public.msgr_crews v on v.id = ch.swapped_out
                  where ch.owner_user_id = p_uid and v.owner_user_id = p_uid and v.ws_id = p_ws and v.slug = p_slug
                    and (p_score is null or p_score < ch.chosen_msg))
$$;
revoke all on function public._msgr_free_benched(uuid, text, text, bigint) from public, anon, authenticated;

-- 2-1-2) 교체 대상 순서 한 곳 — 관문의 교체(4)와 설정 카드의 미리 알림(4-3)이 같은 순서를 쓴다. sweep이 남길 순서(5)의 거꾸로:
--        점수 낮은 것 → 교체로 멈춘 뒤 대화 없음(2-1-1) → 고른 순간이 오래된 것 → 나중에 만든 것. p_keep = 대상에서 뺄 에이전트('회사:이름'), p_n = 몇 명.
create or replace function public._msgr_free_victims(p_uid uuid, p_keep text[], p_n int)
  returns table(ws_id text, slug text, any_id uuid, display_name text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select a.ws_id, a.slug, a.any_id, a.name
    from (select c.ws_id, c.slug, min(c.id::text)::uuid any_id, max(ch.chosen_at) chosen_at, min(c.created_at) born, min(c.display_name) name,
                 greatest(max((select max(e.source_msg_id) from public.msgr_executions e where e.crew_id = c.id)), max(ch.chosen_msg)) score
            from public.msgr_crews c left join public.msgr_free_choices ch on ch.crew_id = c.id
           where c.owner_user_id = p_uid and c.hosting <> 'bot' and c.status = 'active'
             and not ((c.ws_id || ':' || c.slug) = any(coalesce(p_keep, '{}'::text[])))
           group by c.ws_id, c.slug) a
   order by a.score asc nulls first, public._msgr_free_benched(p_uid, a.ws_id, a.slug, a.score) desc,
            a.chosen_at asc nulls first, a.born desc, a.ws_id, a.slug
   limit greatest(coalesce(p_n, 0), 0)
$$;
revoke all on function public._msgr_free_victims(uuid, text[], int) from public, anon, authenticated;

-- 2-2) 재개 처리(커서 밖의 일) — #941 _msgr_crew_plan_resume에서 떼어 냈다. 중지 기록 닫기·멈추기 전에 줄 선 자동화 실행 닫기·지난 예정 시각 옮기기.
--      sweep 재개와 사람의 직접 연결(paused→active, 관문 뒤 AFTER 트리거)이 같은 함수를 쓴다(검수 #945 HIGH-1).
create or replace function public._msgr_crew_resume_side(p_crew uuid, p_top bigint) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.msgr_crew_pauses set resumed_at = now(), resume_after = p_top where crew_id = p_crew and resumed_at is null;
  update public.msgr_automation_runs ru set status = 'blocked', error = 'paused', finished_at = now()
    from public.msgr_automations au
   where au.id = ru.automation_id and au.crew_id = p_crew and ru.status = 'queued' and ru.message_id <= p_top
     and not exists (select 1 from public.msgr_executions e where e.source_msg_id = ru.message_id);
  update public.msgr_automations set next_run_at = public.msgr_automation_next(schedule, now()), updated_at = now()
   where crew_id = p_crew and enabled and deleted_at is null and next_run_at <= now();
end $$;
revoke all on function public._msgr_crew_resume_side(uuid, bigint) from public, anon, authenticated;

create or replace function public._msgr_crew_plan_resume(p_crew uuid, p_top bigint) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.msgr_crews
     set status = case when status = 'paused' then 'active' else status end,
         cursor_msg_id = greatest(coalesce(cursor_msg_id, 0), p_top)
   where id = p_crew;
  perform public._msgr_crew_resume_side(p_crew, p_top);
end $$;
revoke all on function public._msgr_crew_plan_resume(uuid, bigint) from public, anon, authenticated;

-- 3) 기기 심박 — 20261010120000 정의 + 버전 인자(기본값 null: 옛 앱의 3인자 호출이 그대로 이 함수로 온다). 이 PR이 이 함수의 유일한 정의다(#943은 정의하지 않는다).
--    3인자 함수를 지우고 만든다 — 둘이 함께 있으면 3인자 이름 호출이 두 함수에 다 맞아 PostgREST가 고르지 못한다(PGRST203). 시험이 함수 1개를 잠근다.
--    바뀐 곳: 버전 칸 쓰기(같은 문장), 옛 읽기 호환을 active 행만·개인 행 기한도 35초(#943 검수 LOW-1: 쉬는 동안 심박이 45초 간격이면 50초 기한에서 개인 행이
--    90초마다 써져 부재중 판정(90초)과 여유가 없다), 돌려주는 값 { resume: true } = 처음 들어온 새 앱 심박이고 멈춘 사람 에이전트가 있음.
--    재개는 여기서 돌리지 않는다(검수 #945 LOW-6) — 게이트웨이가 신호를 보고 msgr_free_resume()을 따로 부른다. 재개가 느리거나 실패해도 심박은 성공한다.
--    부르는 쪽이 신호를 놓쳐도 10분 크론이 같은 재개를 한다.
drop function if exists public.msgr_device_beat(text, text, uuid[]);
drop function if exists public.msgr_device_beat(text, text, uuid[], text);
create function public.msgr_device_beat(p_ws text, p_device text, p_crews uuid[], p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); s text[]; v text; was_ok boolean := true;
begin
  if me is null then raise exception 'msgr_device_beat_forbidden' using errcode = '42501'; end if;
  if p_ws is null or p_ws !~ '^[a-z0-9][a-z0-9-]{0,127}$' or p_device is null or length(p_device) not between 1 and 200
     or coalesce(cardinality(p_crews), 0) > 2000 then raise exception 'msgr_device_beat_invalid' using errcode = '22023'; end if; -- 회사 id 규칙 = workspace.mjs WS_ID_RE
  -- 앱 버전 — 형식이 맞는 것만(아니면 옛 앱처럼 버전 없음). 심박 자체는 실패시키지 않는다
  v := case when length(p_app_version) <= 40 and public._msgr_app_ver(p_app_version) is not null then p_app_version end;
  if v is not null then was_ok := public._msgr_free_app_ok(me); end if; -- 이 심박 전에 이미 새 앱 판정이었나(재개 신호는 바뀐 때만)
  -- 이 기기가 맡은 에이전트 = 받은 행 중 내 행·이 회사 행의 slug(남의 에이전트·다른 회사를 '접속'으로 만들 수 없다). 상태는 보지 않는다 —
  -- 새 앱은 멈춘 행도 싣는다(멈춘 에이전트만 있는 회사도 기기 행이 있어야 새 앱이 켜진 것을 안다). 접속 표시는 읽는 쪽이 active 행만 본다(_msgr_device_seen 호출부).
  select coalesce(array_agg(distinct c.slug order by c.slug), '{}') into s
    from public.msgr_crews c where c.id = any(coalesce(p_crews, '{}')) and c.owner_user_id = me and c.ws_id = p_ws;
  update public.msgr_device_beats d
     set slugs = s, seen_at = now(),
         app_version = coalesce(v, d.app_version),
         app_seen_at = case when v is not null then now() else d.app_seen_at end
   where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device
     and (d.slugs is distinct from s or d.seen_at < now() - interval '35 seconds'
          -- 버전이 바뀌었거나, 같은 기기의 옛 심박이 seen_at만 새로 고쳐 새 앱 시각이 밀린 경우(5분 — 30분 창보다 넉넉히 짧게)
          or (v is not null and (d.app_version is distinct from v or d.app_seen_at is null or d.app_seen_at < now() - interval '5 minutes')));
  if not found and s <> '{}' and not exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device) then
    -- 새 (회사, 기기) — 주인당 50행 상한: 가장 오래 안 뛴 것부터 비운다(넣을 때만 — 쉬는 틱은 여기 오지 않는다)
    delete from public.msgr_device_beats d where d.owner_user_id = me and (d.ws_id, d.device_id) in (
      select o.ws_id, o.device_id from public.msgr_device_beats o where o.owner_user_id = me order by o.seen_at desc offset 49);
    insert into public.msgr_device_beats (owner_user_id, ws_id, device_id, slugs, app_version, app_seen_at)
      values (me, p_ws, p_device, s, v, case when v is not null then now() end) on conflict do nothing;
  end if;
  -- 옛 읽기 호환(20261010120000 머리말) — 기한(35초)이 지난 active 행만(멈춘 행은 접속으로 보이지 않게, 쓰지도 않는다)
  update public.msgr_crews c set last_seen_at = now()
   where c.id = any(p_crews) and c.owner_user_id = me and c.ws_id = p_ws and c.status = 'active'
     and (c.last_seen_at is null or c.last_seen_at < now() - interval '35 seconds');
  -- 업무 기능 표시 — msgr_work_heartbeat와 같은 일(조직 행만, 같은 값은 쓰지 않는다)
  update public.msgr_crews set work_protocol = 1
   where id = any(p_crews) and owner_user_id = me and ws_id = p_ws and org_id is not null and status = 'active' and work_protocol is distinct from 1;
  -- 처음 들어온 새 앱 심박 + 멈춘 사람 에이전트 있음 → 재개 신호(재개는 msgr_free_resume — 위 머리말)
  if not was_ok and public._msgr_free_app_ok(me)
     and exists (select 1 from public.msgr_crews c where c.owner_user_id = me and c.status = 'paused' and c.hosting <> 'bot') then
    return jsonb_build_object('resume', true);
  end if;
  return '{}'::jsonb;
end $$;
revoke all on function public.msgr_device_beat(text, text, uuid[], text) from public, anon;
grant execute on function public.msgr_device_beat(text, text, uuid[], text) to authenticated;

-- 3-1) 재개 — 로그인한 사람 자신만(그 주인 하나의 sweep). 게이트웨이가 심박의 재개 신호를 받았을 때, 본체 설정이 연결 결과를 다시 볼 때 부른다.
--      멈춘 사람 에이전트가 없으면 아무것도 하지 않는다(쓰기 0). 비용: 그 주인 행 한 번 훑기 + 바뀐 행만 쓰기 — 운영 무료 주인 최대 259명 에이전트(10/11) 기준
--      바뀌는 행은 에이전트 4명의 행과 중지 기록. 실패(시간 초과 포함)해도 심박에는 영향이 없다(따로 부른다).
create or replace function public.msgr_free_resume() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_free_resume_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr_crews c where c.owner_user_id = me and c.status = 'paused' and c.hosting <> 'bot') then
    return jsonb_build_object('resumed', 0);
  end if;
  return public.msgr_crews_plan_sweep(me);
end $$;
revoke all on function public.msgr_free_resume() from public, anon;
grant execute on function public.msgr_free_resume() to authenticated;

-- 4) 쓰기 관문 — 20261010200000 정의 + 무료 계정의 새 앱·4명 갈래 + 사람의 직접 재개 처리. 나머지(봇·끄기·paused 직접 쓰기·이미 active)는 그대로.
--    사람의 연결 = UPDATE available→active(메신저 파견·설정 연결) 또는 paused→active(설정 연결). 미러는 insert와 detached→active만 쓴다(#941 소비자 표).
--    paused→active를 허용할 때는 무료·Pro 상관없이 커서를 지금 끝으로(BEFORE에서 NEW에), 나머지 재개 처리는 AFTER 트리거(msgr_crews_resume_side) —
--    sweep 재개와 같은 결과(검수 #945 HIGH-1: 설정의 연결로 바로 active가 되면 멈춘 동안의 글에 몰아 답했다).
--    무료 + 새 앱 + 4명이 찬 상태의 사람 연결: 오류 대신 가장 오래 대화하지 않은 에이전트(점수 = 실행 기록·사람이 고른 순간 중 늦은 것)를 멈추고 연결한다
--    (교체 — 채널 참여·기록은 그대로, msgr_free_choices.swapped_out으로 안내). 교체할 수 없을 때만 msgr_free_agent_limit(검수 #945 MEDIUM-1 총괄 결정).
create or replace function public.msgr_crews_pro_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare human boolean; victim record; prev text;
begin
  if new.hosting = 'bot' then return new; end if; -- 봇은 엣지 관문(msgr_bot_gate)
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' then return new; end if; -- sweep 자신의 재개·중지·교체, 그리고 전체 끄기
  if to_regprocedure('public.is_pro_for(uuid)') is null then return new; end if; -- 요금제 함수가 없는 DB(요금제 마이그레이션을 안 태운 테스트)
  if tg_op = 'UPDATE' and new.status = 'paused' and old.status is distinct from 'paused' then
    new.status := old.status;
    return new;
  end if;
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return new; end if; -- 이미 active인 행(상태를 그대로 다시 쓰는 갱신)은 sweep이 정리한다
  -- 사람의 연결 = 그 에이전트 주인 자신의 쓰기만(보안 점검 10/11). 조직 관리자(msgr_crews_update_admin)가 남의 에이전트를 연결하는 쓰기는
  -- 주인의 선택으로 기록하지 않고 교체도 하지 않는다(관리자 행동으로 주인의 다른 에이전트가 멈추지 않게) — 한도 안이면 허용, 넘으면 msgr_free_agent_limit.
  -- 멈춘 행의 재개(paused→active)는 주인과 서버(sweep — 이 관문을 끈다)만: 주인이 아닌 쓰기는 조용히 그대로 둔다(커서·기록도 손대지 않는다).
  if tg_op = 'UPDATE' and old.status = 'paused' and auth.uid() is distinct from new.owner_user_id then new.status := 'paused'; return new; end if;
  human := tg_op = 'UPDATE' and old.status in ('available', 'paused') and auth.uid() = new.owner_user_id;
  if public.is_pro_for(new.owner_user_id) then
    if tg_op = 'UPDATE' and old.status = 'paused' then new.cursor_msg_id := greatest(coalesce(old.cursor_msg_id, 0), (select coalesce(max(m.id), 0) from public.msgr_messages m)); end if;
    return new;
  end if;
  -- 무료 계정(2026-10-11): 사람이 누른 연결은 '지금 대화한 것'으로 기록(자동 재개·교체 순위 — 2-1). 아래에서 거절되면 함께 되돌려진다.
  if human then
    insert into public.msgr_free_choices (crew_id, owner_user_id, chosen_msg, chosen_at)
      values (new.id, new.owner_user_id, (select coalesce(max(m.id), 0) from public.msgr_messages m), now())
    on conflict (crew_id) do update set chosen_msg = excluded.chosen_msg, chosen_at = now(), swapped_out = null, swapped_at = null;
  end if;
  -- 최신 앱이 켜져 있으면 4명까지. 같은 주인의 동시 연결·sweep은 주인 단위 잠금으로 줄 세운다(sweep도 같은 잠금 — 검수 #945 LOW-1).
  if public._msgr_free_app_ok(new.owner_user_id) then
    perform pg_advisory_xact_lock(hashtext('msgr_free_agents:' || new.owner_user_id::text));
    if not (exists (select 1 from public.msgr_crews c where c.owner_user_id = new.owner_user_id and c.ws_id = new.ws_id and c.slug = new.slug
                      and c.hosting <> 'bot' and c.status = 'active' and c.id is distinct from new.id) -- 이미 연결된 에이전트의 다른 행 — 한 명으로 센다
            or public._msgr_free_active_agents(new.owner_user_id) < (select agent_limit from public._msgr_free_agent_policy())) then
      if not human then
        if tg_op = 'UPDATE' and old.status = 'available' then -- 관리자가 남의 에이전트를 연결 — 교체하지 않고 이유를 보인다
          raise exception 'msgr_free_agent_limit msgr_pro_required' using errcode = 'P0001', detail = 'Free accounts can connect up to 4 agents to Messenger';
        end if;
        new.status := 'paused'; return new; -- 미러 insert·되살리기는 교체하지 않는다
      end if;
      -- 교체 대상: 같은 주인(new.owner_user_id = 연결을 누른 사람 자신)의 연결된 에이전트 중 점수가 가장 낮은 것(대화도 선택도 없던 것 먼저)
      -- 순서는 한 곳(2-1-2 _msgr_free_victims) — 설정 카드의 미리 알림(4-3)과 같은 결과
      select v.ws_id, v.slug, v.any_id into victim from public._msgr_free_victims(new.owner_user_id, array[new.ws_id || ':' || new.slug], 1) v;
      if victim.slug is null then
        raise exception 'msgr_free_agent_limit msgr_pro_required' using errcode = 'P0001', detail = 'Free accounts can connect up to 4 agents to Messenger';
      end if;
      prev := current_setting('msgr.pro_gate', true);
      perform set_config('msgr.pro_gate', 'off', true); -- 교체 대상의 active→paused가 이 관문에 되돌려지지 않게(기록은 msgr_crews_pro_gate_log)
      begin
        update public.msgr_crews set status = 'paused'
         where owner_user_id = new.owner_user_id and ws_id = victim.ws_id and slug = victim.slug and hosting <> 'bot' and status = 'active';
      exception when others then
        perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
        raise exception 'msgr_free_agent_limit msgr_pro_required' using errcode = 'P0001', detail = 'Free accounts can connect up to 4 agents to Messenger';
      end;
      perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
      update public.msgr_free_choices set swapped_out = victim.any_id, swapped_at = now() where crew_id = new.id;
    end if;
    if tg_op = 'UPDATE' and old.status = 'paused' then new.cursor_msg_id := greatest(coalesce(old.cursor_msg_id, 0), (select coalesce(max(m.id), 0) from public.msgr_messages m)); end if;
    return new;
  elsif tg_op = 'UPDATE' and old.status = 'available' then
    raise exception 'msgr_app_update_required msgr_pro_required' using errcode = 'P0001',
      detail = 'Free accounts need the latest Argo app running to connect agents to Messenger';
  end if;
  -- 사람이 누른 연결이 아닌 쓰기(미러 insert·되살리기·업서트 충돌)와 새 앱이 없을 때의 paused→active는 조용히 paused — 오류로 던지면 옛 미러가 15초마다 같은 쓰기를 다시 보낸다(#941)
  new.status := 'paused';
  return new;
end $$;
revoke all on function public.msgr_crews_pro_gate() from public, anon, authenticated;

-- 4-1) 관문이 연결(available·paused·detached→active)을 허용한 뒤 처리 — sweep(관문 끔)이 바꾼 행은 건너뛴다(sweep이 같은 일을 한다).
--   ① 멈춘 행을 직접 연결했으면 재개 처리(커서는 관문이 NEW에 옮겼다).
--   ② 그 주인 하나를 크론과 같은 판정(msgr_crews_plan_sweep)으로 같은 트랜잭션에서 맞춘다(화면 검수 A, 10/11) — 연결한 에이전트의 다른 공간 행(무료: 한도 안의
--      '연결된 에이전트의 멈춘 다른 행', Pro: 멈춘 것 전부)을 크론까지 기다리지 않는다. 고른 행만 active이고 다른 행은 10분 동안 paused라 메신저 목록 수와
--      안내 수가 어긋났다. 교체된 에이전트의 행은 관문이 이미 전부 멈췄다. sweep은 바뀌는 행만 쓰고(유휴 0), 관문과 같은 주인 잠금을 다시 잡는다(같은 트랜잭션 — 재진입),
--      자기 쓰기에는 관문을 꺼서(msgr.pro_gate=off) 이 트리거로 다시 들어오지 않는다. 실패해도 연결은 그대로 두고(경고만) 10분 크론이 맞춘다.
--   부하: 사람·관리자의 연결과 미러의 되살리기(detached→active)에서만, 주인 하나 질의 1번 + 바뀐 행 쓰기. insert(미러가 새 행을 넣음)는 부르지 않는다 — 크론이 맞춘다.
--   ③ 지금도 active인 행만 재개 처리한다(분리 검수 P3) — 한 문장이 여러 행을 연결하면 AFTER는 문장 끝에 몰려 오는데, 그사이 뒤 행의 교체로 다시 멈춘 행의
--      중지 기록을 닫으면 멈춘 행에 열린 기록이 없어진다.
--   ④ 여기서 부르는 sweep은 남이 잠근 행을 건너뛴다(msgr.sweep_skip_locked — 분리 검수 P2). 같은 에이전트의 다른 행을 다른 연결이 BEFORE에서 잠근 채 주인 잠금을
--      기다리면, 주인 잠금을 쥔 이쪽이 그 행을 기다려 교착이 났다. 건너뛴 행은 그 연결이 스스로 맞추거나 10분 크론이 맞춘다.
create or replace function public.msgr_crews_resume_side() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text;
begin
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' then return new; end if;
  if to_regprocedure('public.is_pro_for(uuid)') is null then return new; end if;
  if old.status = 'paused' and exists (select 1 from public.msgr_crews c where c.id = new.id and c.status = 'active') then
    perform public._msgr_crew_resume_side(new.id, coalesce(new.cursor_msg_id, 0));
  end if;
  prev := current_setting('msgr.sweep_skip_locked', true);
  perform set_config('msgr.sweep_skip_locked', 'on', true);
  begin
    perform public.msgr_crews_plan_sweep(new.owner_user_id);
  exception when others then
    raise warning 'msgr_crews_resume_side: owner % sweep skipped (%: %)', new.owner_user_id, sqlstate, sqlerrm;
  end;
  perform set_config('msgr.sweep_skip_locked', coalesce(prev, ''), true);
  return new;
end $$;
revoke all on function public.msgr_crews_resume_side() from public, anon, authenticated;
drop trigger if exists msgr_crews_resume_side on public.msgr_crews;
create trigger msgr_crews_resume_side after update of status on public.msgr_crews
  for each row when (new.status = 'active' and old.status is distinct from 'active' and new.hosting <> 'bot') execute function public.msgr_crews_resume_side();

-- 4-2) 교체 안내 — 방금 연결한 내 에이전트 때문에 쉬게 된 에이전트 이름(5분 안). 본체 설정·메신저가 연결 직후 한 번 부른다.
create or replace function public.msgr_agent_swap_notes(p_crews uuid[]) returns table(crew_id uuid, victim_name text)
  language sql stable security definer set search_path = public, pg_temp as $$
  select ch.crew_id, v.display_name
    from public.msgr_free_choices ch join public.msgr_crews v on v.id = ch.swapped_out
   where ch.crew_id = any(coalesce(p_crews, '{}')) and ch.owner_user_id = auth.uid() and ch.swapped_at > now() - interval '5 minutes'
$$;
revoke all on function public.msgr_agent_swap_notes(uuid[]) from public, anon;
grant execute on function public.msgr_agent_swap_notes(uuid[]) to authenticated;

-- 4-3) 교체 미리 알림(검수 스택 화면 4차, 10/11) — 설정 카드에서 이 회사(p_ws)의 에이전트들(p_slugs)을 연결하면 무료 4명 한도 때문에 멈출 에이전트 이름.
--      관문과 같은 순서(_msgr_free_victims)로, 필요한 수(연결된 수 + 새로 연결될 수 − 4)만큼. 고른 에이전트는 후보에서 뺀다.
--      Pro·새 앱 없음(연결이 멈춘 채 남아 교체가 일어나지 않음)·자리 남음이면 빈 목록. 읽기만 — 연결을 누를 때 한 번.
create or replace function public.msgr_free_swap_preview(p_ws text, p_slugs text[]) returns text[]
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); n_new int; n_over int;
begin
  if me is null or p_ws is null or coalesce(cardinality(p_slugs), 0) = 0 or cardinality(p_slugs) > 200 then return '{}'; end if;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' or to_regprocedure('public.is_pro_for(uuid)') is null
     or public.is_pro_for(me) or not public._msgr_free_app_ok(me) then return '{}'; end if;
  select count(distinct s) into n_new from unnest(p_slugs) s
   where not exists (select 1 from public.msgr_crews c where c.owner_user_id = me and c.ws_id = p_ws and c.slug = s and c.hosting <> 'bot' and c.status = 'active');
  n_over := public._msgr_free_active_agents(me) + n_new - (select agent_limit from public._msgr_free_agent_policy());
  if n_over <= 0 then return '{}'; end if;
  return array(select v.display_name from public._msgr_free_victims(me, array(select p_ws || ':' || s from unnest(p_slugs) s), n_over) v);
end $$;
revoke all on function public.msgr_free_swap_preview(text, text[]) from public, anon;
grant execute on function public.msgr_free_swap_preview(text, text[]) to authenticated;

-- 5) 정리 함수 — 20261010200000 정의를 주인 단위로. Pro·봇 갈래는 그대로, 무료 사람 에이전트만 새 규칙(머리말 '누구를 재개하나').
--    주인마다 관문과 같은 잠금을 잡는다(검수 #945 LOW-1 — 사람의 연결과 겹쳐 5명이 되던 경합). 순위 점수 = 실행 기록·사람이 고른 순간 중 늦은 것(2-1).
--    바뀌어야 하는 행만 쓴다(유휴 쓰기 0). 행마다 따로 처리한다(한 행이 다른 트리거에 걸려도 나머지는 계속).
create or replace function public.msgr_crews_plan_sweep(p_uid uuid default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o record; r record; top bigint; prev text := current_setting('msgr.pro_gate', true);
  n_paused int := 0; n_resumed int := 0; n_failed int := 0; n_skipped int := 0; pro boolean; ok boolean; lim int;
  skip_locked boolean := coalesce(current_setting('msgr.sweep_skip_locked', true), '') = 'on'; -- 연결 트리거에서 부를 때만(4-1 ④)
begin
  if coalesce(prev, '') = 'off' then return jsonb_build_object('skipped', 'msgr.pro_gate=off'); end if; -- 전체 끄기
  perform set_config('msgr.pro_gate', 'off', true); -- 재개 update가 관문에 다시 걸리지 않게(판정은 아래 조건이 한다). 끝에서 되돌린다.
  select agent_limit into lim from public._msgr_free_agent_policy();
  for o in
    select distinct c.owner_user_id uid from public.msgr_crews c
     where (p_uid is null or c.owner_user_id = p_uid)
       and (c.status in ('active', 'paused') or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null))
     order by 1
  loop
    pro := public.is_pro_for(o.uid);
    ok := not pro and public._msgr_free_app_ok(o.uid);
    if not pro then perform pg_advisory_xact_lock(hashtext('msgr_free_agents:' || o.uid::text)); end if;
    for r in
      with mine as (
        select c.id, c.hosting, c.status, c.ws_id, c.slug, c.created_at, ch.chosen_msg, ch.chosen_at,
               exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null) open_pause
          from public.msgr_crews c left join public.msgr_free_choices ch on ch.crew_id = c.id
         where c.owner_user_id = o.uid
           and (c.status in ('active', 'paused') or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null))
      ), ident as ( -- 무료 사람 에이전트 = (회사, 이름) 한 명. 점수 = 실행 기록의 마지막 글(기본 키 색인 거꾸로 1행)·사람이 고른 순간 중 늦은 것
        select m.ws_id, m.slug, bool_or(m.status = 'active') act,
               greatest(max((select max(e.source_msg_id) from public.msgr_executions e where e.crew_id = m.id)), max(m.chosen_msg)) score,
               max(m.chosen_at) chosen_at, min(m.created_at) born
          from mine m where not pro and m.hosting <> 'bot' and m.status in ('active', 'paused') group by m.ws_id, m.slug
      ), ranked as ( -- 점수 → 교체로 멈춘 뒤 대화 없음은 뒤로(2-1-1) → 고른 순간 → 만든 순. 커서는 쓰지 않는다(재개가 끝으로 옮긴다 — 화면 검수 C)
        select i.ws_id, i.slug, i.act,
               row_number() over (partition by i.act order by i.score desc nulls last, public._msgr_free_benched(o.uid, i.ws_id, i.slug, i.score),
                                  i.chosen_at desc nulls last, i.born, i.ws_id, i.slug) rk,
               count(*) filter (where i.act) over () n_act
          from ident i
      )
      select m.id, m.hosting, case
          when pro then case when m.status = 'paused' or m.open_pause then 'resume' end                       -- Pro: 멈춘 것 전부(#941)
          when m.hosting = 'bot' then case when m.status = 'active' and not m.open_pause then 'pause' end      -- 무료 봇: 중지 기록만(#941)
          when not ok then case when m.status = 'active' then 'pause' end                                      -- 무료 + 새 앱 없음: 전부 멈춤
          when m.status = 'active' and k.rk > lim then 'pause'                                                 -- 4명 넘는 active — 점수가 낮은 쪽부터
          when m.status = 'paused' and k.act and k.rk <= lim then 'resume'                                     -- 연결된 에이전트의 멈춘 다른 행
          when m.status = 'paused' and not k.act and k.n_act = 0 and k.rk <= lim then 'resume'                 -- 전부 멈춘 상태 → 점수 순 4명
        end act
        from mine m left join ranked k on k.ws_id = m.ws_id and k.slug = m.slug
       order by m.id
    loop
      continue when r.act is null;
      if skip_locked and r.hosting <> 'bot' then -- 남이 잠근 행은 건너뛴다(교착 방지 — 그 쓰기가 끝나면 그쪽 트리거·크론이 맞춘다)
        perform 1 from public.msgr_crews where id = r.id for update skip locked;
        if not found then n_skipped := n_skipped + 1; continue; end if;
      end if;
      begin
        if r.act = 'pause' then
          if r.hosting <> 'bot' then
            update public.msgr_crews set status = 'paused' where id = r.id and status = 'active'; -- 기록은 msgr_crews_pro_gate_log
          else
            insert into public.msgr_crew_pauses (crew_id, owner_user_id, cursor_at_pause)
              select id, owner_user_id, cursor_msg_id from public.msgr_crews where id = r.id
            on conflict (crew_id) do update set paused_at = now(), cursor_at_pause = excluded.cursor_at_pause, resumed_at = null, resume_after = null;
          end if;
          n_paused := n_paused + 1;
        else
          if top is null then select coalesce(max(id), 0) into top from public.msgr_messages; end if;
          perform public._msgr_crew_plan_resume(r.id, top);
          n_resumed := n_resumed + 1;
        end if;
      exception when others then
        n_failed := n_failed + 1;
        raise warning 'msgr_crews_plan_sweep: crew % skipped (%: %)', r.id, sqlstate, sqlerrm;
      end;
    end loop;
  end loop;
  -- 사람이 paused 행을 직접 다른 상태로 바꿨으면(파견 해제 등) 열린 기록을 닫는다 — 바뀐 행만
  update public.msgr_crew_pauses k set resumed_at = now()
   where k.resumed_at is null and (p_uid is null or k.owner_user_id = p_uid)
     and exists (select 1 from public.msgr_crews c where c.id = k.crew_id and c.hosting <> 'bot' and c.status <> 'paused');
  if p_uid is null then delete from public.msgr_crew_pauses where resumed_at < now() - interval '30 days'; end if; -- 보존 기간
  perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
  return jsonb_build_object('paused', n_paused, 'resumed', n_resumed, 'failed', n_failed) || case when n_skipped > 0 then jsonb_build_object('skipped', n_skipped) else '{}'::jsonb end;
end $$;
revoke all on function public.msgr_crews_plan_sweep(uuid) from public, anon, authenticated;

-- 6) 메신저·본체 안내 — 로그인한 사람의 멈춘 에이전트와 이유. 읽기만. 메신저가 로그인·재연결·에이전트 탭 진입 때 한 번 부른다(주기 호출 없음).
--    paused = 멈춘 에이전트 수(같은 회사·이름 = 한 명, 연결된 행이 있는 에이전트는 빼고), active = 연결된 에이전트 수, limit = 4, min_app = 최소 버전
--    (본체가 자기 버전과 비교해 '이 앱이 새 앱인가'를 안다 — 멈춘 회사의 브리지를 켤지 정할 때, 검수 #945 MEDIUM-2),
--    reason = null(Pro·관문 꺼짐·멈춘 에이전트 없음) | 'app'(최소 버전 이상 앱 기기가 없음 — 업데이트 안내) | 'off'(새 앱은 있었지만 30분 넘게 꺼짐)
--      | 'limit'(새 앱 켜짐 + 4명 다 참) | 'room'(새 앱 켜짐 + 자리 남음 + 멈춘 에이전트 있음 — 지금 연결할 수 있다, 분리 검수 3차 LOW).
--    옛 메신저·본체는 모르는 이유를 안내 없음으로 읽는다(agentPauseNote·FREE_REASON_CODE 표에 없음).
create or replace function public.msgr_my_agent_pause() returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); n_act int; n_paused int; pol record; why text;
begin
  if me is null then return null; end if;
  select * into pol from public._msgr_free_agent_policy();
  with ids as (
    select c.ws_id, c.slug, bool_or(c.status = 'active') a, bool_or(c.status = 'paused') p
      from public.msgr_crews c where c.owner_user_id = me and c.hosting <> 'bot' and c.status in ('active', 'paused') group by 1, 2
  ) select count(*) filter (where a), count(*) filter (where p and not a) into n_act, n_paused from ids;
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' or to_regprocedure('public.is_pro_for(uuid)') is null or public.is_pro_for(me) then why := null;
  elsif not public._msgr_free_app_ok(me) then
    why := case when exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me
                               and public._msgr_app_ver(d.app_version) >= public._msgr_app_ver(pol.min_app)) then 'off' else 'app' end;
  elsif n_act >= pol.agent_limit then why := 'limit';
  elsif n_paused > 0 then why := 'room';
  end if;
  return jsonb_build_object('paused', n_paused, 'active', n_act, 'limit', pol.agent_limit, 'reason', why, 'min_app', pol.min_app);
end $$;
revoke all on function public.msgr_my_agent_pause() from public, anon;
grant execute on function public.msgr_my_agent_pause() to authenticated;

notify pgrst, 'reload schema';
