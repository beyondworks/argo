-- 0.1.106 이하 본체 앱 사용 중지 장치(유건 2026-10-18 "보내고 업데이트 안하면 사용 중지된다고 말해" — 안내 메일 뒤 2026-10-25 23:59 KST).
-- 0.1.106 이하에는 서버가 정하는 최소 버전 관문(src/app-gate.mjs, 0.1.107부터)이 없어, 서버가 무슨 오류를 돌려줘도 같은 주기로 다시 부르거나
-- 더 자주 부른다(msgr_crews 실패 → 120초 쉼이 15초 조회로, Storage 읽기 거절 → 리스 쓰기 8초마다, refresh 기타 오류 → 2분 상한 무한 재시도).
-- 옛 판이 스스로 멈추는 거절은 하나뿐이다: 로그인 세션이 서버에서 폐기됨("Refresh Token Not Found" → 사유 revoked) → 죽음 표지 →
-- 동기화·메신저·알림·리스 호출 0, 같은 토큰 refresh는 1시간에 1번, 화면은 사이드바 "세션 만료 · 재로그인"(v0.1.106 devicesession.mjs:136-185).
-- 그래서 이 장치는 옛 앱의 로그인 세션만 골라 폐기한다. 같은 계정의 새 앱·메신저·오피스 세션은 건드리지 않는다.
--
-- 옛 앱 판별(운영 로그 2026-10-17 14:00~10-18 14:00 KST로 확인, 분리 검수 반영):
--   · 0.1.107 이상은 argo_min_app_version을 기기 세션 JWT로 30분마다 부른다(실패하면 5분 뒤) → 부른 세션을 argo_gate_sessions에 남긴다
--     (세션당 6시간에 1번 쓰기). 관문 요청(/rpc/argo_min_app_version) 자체는 절대 폐기를 일으키지 않는다.
--   · 판별 대상은 PostgREST POST 요청 중 x-client-info가 옛 판의 동결된 서명 'supabase-js/2.110.2; runtime=node…'인 사용자 세션뿐이다.
--     로그인이 생긴 2026-07-12부터 v0.1.113까지 본체의 supabase-js는 2.110.2 그대로다(package-lock). 다른 Node 클라이언트
--     (오피스 서버의 supabase-js 2.117.2, Vercel·스크립트), 메신저 앱·웹(runtime=web), plain fetch(x-client-info 없음),
--     OAuth 클라이언트 토큰(claims.client_id — 원격 MCP), ' argo/<버전>'·x-argo-app-version을 단 앱은 모두 제외한다.
--     0.1.107~0.1.113도 2.110.2이지만 관문 기록으로 제외된다.
--   · argo_gate_sessions에 없고 세션이 생긴 지 2시간이 지났으면(같은 계정이 이미 한 번 끊겼으면 바로) "의심"으로 표시하고 35분 뒤 다시 본다.
--     35분 = 관문 주기 30분 + 실패 재시도 5분: 그동안 한 번이라도 관문을 부르면 새 앱이고, 관문 호출이 표시를 지운다(argo_min_app_version).
--   · 35분 뒤의 POST에서도 관문 기록이 없으면 그 세션을 폐기한다(auth.sessions 행 삭제 = GoTrue 로그아웃과 같은 처리, refresh_tokens는 FK로 함께 지워짐).
--     요청 자체는 거절하지 않는다(거절하면 옛 판이 더 자주 부르는 경로가 있다). 접근 토큰이 끝나는 최대 1시간 뒤 refresh가 거절되며 호출이 멈춘다.
--   · GET·HEAD와 STABLE 함수 POST는 읽기 전용 트랜잭션이라 표시가 남지 않는다. 옛 판은 쓰기 함수(msgr_notification_claim·routes_sync, 30초마다)를
--     부르므로 거기서 표시된다. 본 요청이 실패해 롤백되면 표시도 함께 사라진다(다음 요청에서 다시). 옛 세션 24개 중 21~22개가 대상이다.
--
-- 폐기 기준 버전(2026-10-19 — 0.1.114 발행 뒤 "0.1.113 이하"로 넓힌다, 마이그레이션 없이 설정 한 줄):
--   msgr_settings 'old_app_cutoff_max' = 'x.y.z'. 없거나 형식이 틀리면 '0.1.106'(위 판별 그대로 — 기본 동작은 이 값이 생기기 전과 같다).
--   0.1.114 이상 값은 0.1.113으로 낮춰 읽는다(새 앱은 어떤 설정으로도 폐기되지 않는다).
--   넓히기: insert into public.msgr_settings (key, value) values ('old_app_cutoff_max', '0.1.113') on conflict (key) do update set value = excluded.value;
--   요청의 앱 버전을 이렇게 읽는다:
--     · X-Client-Info 끝의 ' argo/<버전>'(#1065, 0.1.114부터 동기화·메신저 요청, 0.1.114부터 관문 요청) — 이 꼬리가 있는 요청은 버전과 무관하게 절대 폐기하지 않는다
--       (0.1.114 이상과, main 코드로 도는 개발 빌드·상주 :3001 — package.json이 직전 발행 번호여도 꼬리가 있다).
--     · x-argo-app-version 헤더(#1050, 0.1.112·0.1.113 메신저 요청) — 그 값 ≤ 기준이면 바로 폐기, 크면 건너뛴다.
--     · 관문 기록(argo_gate_sessions)의 app_version — 관문 요청에 꼬리가 있었으면 그 버전이 남는다(0.1.114부터). 버전이 남은 세션은 폐기하지 않는다
--       (0.1.114의 꼬리 없는 요청을 지킨다 — 0.1.114부터는 본체 모든 요청에 꼬리가 붙는다, src/supabase-client.mjs). 버전 없이 관문 기록만 있는 세션 = 0.1.107~0.1.113
--       → 기준이 0.1.113 이상일 때 '의심 → 35분 → 폐기'(바로 끊지 않는다 — 같은 로그인으로 0.1.114에 업데이트한 세션은 35분 안의 꼬리 있는 관문이 지킨다).
--       이 모드에서는 꼬리 없는 관문 호출이 의심 표시를 지우지 않는다(0.1.107~0.1.113도 관문을 부르므로).
--     · 셋 다 없으면 위 '의심 → 35분 → 폐기' 그대로(0.1.106 이하, 또는 아직 관문을 부르지 않은 새 세션 — 관문 호출이 표시를 지운다).
--   기준을 0.1.113으로 넓히기 전 조건: 0.1.114 발행 + 상주 :3001을 0.1.114 코드로 맞춤(옛 코드의 관문 요청은 꼬리가 없다).
--
-- 스위치(이 한 줄이 전부다, 값은 소문자 'on'만 켜짐):
--   켜기:  insert into public.msgr_settings (key, value) values ('old_app_cutoff', 'on') on conflict (key) do update set value = excluded.value;
--   끄기:  delete from public.msgr_settings where key = 'old_app_cutoff';
--   "끄면 원래대로" = 끈 시각 이후 새로 표시·폐기하는 세션 0. 이미 폐기된 세션은 되살아나지 않는다(사용자가 다시 로그인하면 된다).
--   켜기 전 조건: 이 파일을 적용하고 하루 이상 지나 실행 중인 새 앱이 모두 관문 기록을 남긴 뒤(argo_gate_sessions 행 수 확인)에 켠다.
-- 장치 제거: scripts/rollback/20261018130000_argo_old_app_cutoff.down.sql(함수를 지우지 않고 빈 본문으로 바꾼다).
-- 등록은 pgrst.db_pre_request가 비어 있거나 이미 이 함수일 때만 한다. 다른 값이 있으면 멈춘다(덮어쓰지 않는다).

-- 1) 관문을 부른 세션(= 0.1.107 이상). 30일 지난 행은 아래 cron이 지운다.
create table if not exists public.argo_gate_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  seen_at timestamptz not null default now(),
  app_version text check (app_version is null or length(app_version) <= 20) -- 관문 요청의 X-Client-Info ' argo/<버전>'(0.1.114부터). 없으면 null
);
alter table public.argo_gate_sessions add column if not exists app_version text check (app_version is null or length(app_version) <= 20);
alter table public.argo_gate_sessions enable row level security; -- 정책 없음: 클라이언트는 읽고 쓰지 못한다(보안 정의자 함수만)
revoke all on table public.argo_gate_sessions from anon, authenticated;

-- 2) 옛 앱으로 본 세션(의심 → 폐기). 90일 지난 행은 아래 cron이 지운다.
create table if not exists public.argo_old_app_sessions (
  session_id uuid primary key,
  user_id uuid not null,
  marked_at timestamptz not null default now(),
  due_at timestamptz not null,
  cut_at timestamptz,
  session_created_at timestamptz,
  client_info text check (client_info is null or length(client_info) <= 160)
);
create index if not exists argo_old_app_sessions_user_cut on public.argo_old_app_sessions (user_id) where cut_at is not null;
alter table public.argo_old_app_sessions enable row level security;
revoke all on table public.argo_old_app_sessions from anon, authenticated;

-- 2-b) 버전 읽기(x.y.z → 정수 배열, 형식이 틀리면 null)와 폐기 기준(머리말 '폐기 기준 버전') — 한 곳.
create or replace function public._argo_ver(v text) returns int[]
  language sql immutable as $$ select case when v ~ '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' then string_to_array(v, '.')::int[] end $$;
revoke all on function public._argo_ver(text) from public, anon, authenticated;
create or replace function public._argo_cutoff_max() returns int[]
  language sql stable security definer set search_path = public, pg_temp as $$
    select least(coalesce((select public._argo_ver(s.value) from public.msgr_settings s where s.key = 'old_app_cutoff_max'), array[0,1,106]), array[0,1,113])
$$;
revoke all on function public._argo_cutoff_max() from public, anon, authenticated;
-- 요청 X-Client-Info 끝의 ' argo/<버전>'(withArgoClientInfo) — 없으면 null
create or replace function public._argo_tail_ver(xci text) returns text
  language sql immutable as $$ select substring(coalesce(xci, '') from ' argo/([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})') $$;
revoke all on function public._argo_tail_ver(text) from public, anon, authenticated;

-- 3) 최소 버전 — 20261013190000 본문 그대로 + 부른 세션 기록(값을 돌려주는 동작은 같다). 기록이 실패해도 값은 돌려준다.
--    PostgREST POST(supabase-js rpc 기본)에서만 쓴다. GET으로 부르면 읽기 전용이라 쓰기가 실패하고, 예외 처리로 값만 돌려준다.
create or replace function public.argo_min_app_version(p_app text default 'desktop') returns text
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v text; claims json; sid uuid; uid uuid; tv text;
begin
  select s.value into v from public.msgr_settings s
   where s.key = case p_app when 'desktop' then 'min_app_version' when 'messenger' then 'min_app_version_messenger' end;
  begin
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
    sid := (claims->>'session_id')::uuid;
    uid := (claims->>'sub')::uuid;
    tv := public._argo_tail_ver(nullif(current_setting('request.headers', true), '')::json->>'x-client-info'); -- 0.1.114부터 관문 요청에도 꼬리
    -- 먼저 읽고 필요할 때만 쓴다: ON CONFLICT DO UPDATE는 WHERE가 거짓이어도 행을 잠가(xmax) 쓰기가 생긴다 — 6시간 안의 같은 버전 재호출은 쓰기 0
    if sid is not null and uid is not null and claims->>'role' = 'authenticated'
       and not exists (select 1 from public.argo_gate_sessions g where g.session_id = sid and g.seen_at >= now() - interval '6 hours'
                         and g.app_version is not distinct from coalesce(tv, g.app_version)) then
      insert into public.argo_gate_sessions as g (session_id, user_id, app_version) values (sid, uid, tv)
        on conflict (session_id) do update set seen_at = now(), app_version = coalesce(excluded.app_version, g.app_version);
    end if;
    -- 업데이트 직후 경합으로 붙은 의심 표시를 지운다 — 기준이 0.1.113 이상이면 꼬리 있는 관문(0.1.114+)일 때만(꼬리 없는 관문 = 0.1.107~0.1.113도 대상이다)
    if sid is not null and (tv is not null or public._argo_cutoff_max() < array[0,1,113])
       and exists (select 1 from public.argo_old_app_sessions o where o.session_id = sid and o.cut_at is null) then
      delete from public.argo_old_app_sessions o where o.session_id = sid and o.cut_at is null; -- 업데이트 직후 경합으로 붙은 의심 표시를 지운다
    end if;
  exception when others then null; -- 기록은 덤이다 — 관문 값은 항상 돌려준다
  end;
  return v;
end $$;
revoke all on function public.argo_min_app_version(text) from public;
grant execute on function public.argo_min_app_version(text) to anon, authenticated, service_role;

-- 4) PostgREST 요청 전 함수 — 모든 Data API 요청 앞에서 불린다. 스위치가 꺼져 있으면 POST만 설정 행 하나를 읽고 돌아간다.
--    어떤 경우에도 요청을 실패시키지 않는다(예외는 삼킨다). 요청 역할(anon·authenticated·service_role)로 불리므로 보안 정의자다.
create or replace function public.argo_old_app_check() returns void
  language plpgsql volatile security definer set search_path = public, pg_temp set lock_timeout = '200ms' as $$
declare
  claims json; hdr json; sid uuid; uid uuid; xci text; created timestamptz; prior boolean; o public.argo_old_app_sessions;
  mx int[]; hv int[]; g public.argo_gate_sessions; cut_now boolean := false;
begin
  if current_setting('request.method', true) is distinct from 'POST' then return; end if;
  begin -- 모든 일을 예외 블록 안에서: 설정 표 잠금(lock_timeout 55P03)·권한·형식 오류 어느 것도 요청을 실패시키지 않는다
    if not exists (select 1 from public.msgr_settings where key = 'old_app_cutoff' and value = 'on') then return; end if;
    if ltrim(coalesce(current_setting('request.path', true), ''), '/') = 'rpc/argo_min_app_version' then return; end if; -- 관문 요청은 기록만 한다
    claims := nullif(current_setting('request.jwt.claims', true), '')::json;
    if claims is null or claims->>'role' is distinct from 'authenticated' or claims->>'client_id' is not null then return; end if;
    sid := (claims->>'session_id')::uuid;
    uid := (claims->>'sub')::uuid;
    if sid is null or uid is null then return; end if;
    hdr := nullif(current_setting('request.headers', true), '')::json;
    xci := hdr->>'x-client-info';
    if xci is null or xci not like 'supabase-js/2.110.2; runtime=node%' or position(' argo/' in xci) > 0 then return; end if; -- 꼬리 = 0.1.114+·개발 빌드: 절대 폐기 안 함
    mx := public._argo_cutoff_max();
    hv := public._argo_ver(hdr->>'x-argo-app-version'); -- 0.1.112·0.1.113(#1050)
    if hdr->>'x-argo-app-version' is not null and (hv is null or hv > mx) then return; end if; -- 기준보다 새 앱(또는 읽을 수 없는 값 — 폐기하지 않는 쪽)
    select * into g from public.argo_gate_sessions where session_id = sid;
    if found then
      if g.app_version is not null then return; end if; -- 관문에 꼬리가 있던 세션(0.1.114+) — 이 세션의 꼬리 없는 요청도 지킨다
      if hv is not null then cut_now := true; -- 버전 헤더(0.1.112·0.1.113) ≤ 기준 — 확정
      elsif mx < array[0,1,113] then return; -- 기준이 0.1.113 아래면 관문을 부른 세션은 버전을 몰라 건너뛴다(종전)
      end if;
      -- 기준 0.1.113 + 버전 없이 관문만 부른 세션: 바로 끊지 않고 아래 '의심 → 35분' 흐름으로(엄격 검수 H1 — 0.1.113에서 같은 로그인으로
      -- 업데이트한 0.1.114가 꼬리 있는 관문을 부르기 전 꼬리 없는 요청을 보내도, 35분 안에 꼬리 있는 관문 호출이 표시를 지우고 버전을 남긴다).
    elsif hv is not null then cut_now := true; -- 관문 기록은 없지만 버전 헤더 ≤ 기준
    end if;
    if cut_now then
      insert into public.argo_old_app_sessions (session_id, user_id, due_at, cut_at, session_created_at, client_info)
        select sid, uid, now(), now(), s.created_at, left(xci, 160) from auth.sessions s where s.id = sid
        on conflict (session_id) do update set cut_at = coalesce(public.argo_old_app_sessions.cut_at, now());
      delete from auth.sessions where id = sid; -- 버전이 확정된 옛 앱 — 35분 대기 없이(관문 표시를 기다릴 이유가 없다)
      return;
    end if;

    select * into o from public.argo_old_app_sessions where session_id = sid;
    if found then
      if o.cut_at is not null or o.due_at > now() then return; end if;
      update public.argo_old_app_sessions set cut_at = now() where session_id = sid;
      delete from auth.sessions where id = sid; -- GoTrue 로그아웃과 같다: refresh가 "Refresh Token Not Found"로 거절된다
      return;
    end if;

    select s.created_at into created from auth.sessions s where s.id = sid;
    if created is null then return; end if;
    -- 같은 계정이 이미 한 번 끊겼으면(옛 앱으로 다시 로그인) 바로 표시한다 — 새 앱이면 35분 안에 관문이 표시를 지운다
    prior := exists (select 1 from public.argo_old_app_sessions p where p.user_id = uid and p.cut_at is not null);
    if not prior and created > now() - interval '2 hours' then return; end if;
    insert into public.argo_old_app_sessions (session_id, user_id, due_at, session_created_at, client_info)
      values (sid, uid, now() + interval '35 minutes', created, left(xci, 160))
      on conflict (session_id) do nothing;
  exception when others then return; -- 이 장치가 실패해도 요청은 그대로 진행한다
  end;
end $$;
revoke all on function public.argo_old_app_check() from public;
grant execute on function public.argo_old_app_check() to anon, authenticated, service_role;

-- 5) 등록 — 로컬 PG 시험처럼 authenticator 역할이 없는 곳에서는 건너뛴다. 다른 요청 전 함수가 이미 있으면 덮어쓰지 않고 멈춘다.
do $$
declare cur text;
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    select split_part(c, '=', 2) into cur
      from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) c
     where r.rolname = 'authenticator' and s.setdatabase = 0 and c like 'pgrst.db_pre_request=%';
    if coalesce(cur, '') not in ('', 'public.argo_old_app_check') then
      raise exception 'authenticator에 다른 pgrst.db_pre_request(%)가 이미 있다 — 덮어쓰지 않고 멈춘다', cur;
    end if;
    execute 'alter role authenticator set pgrst.db_pre_request to ''public.argo_old_app_check''';
    notify pgrst, 'reload config';
  end if;
end $$;

-- 6) 보존: 관문 기록 30일, 옛 앱 기록 90일(같은 이름이면 갱신이라 다시 적용해도 하나다).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-argo-app-sessions', '47 3 * * *', $c$
      delete from public.argo_gate_sessions where seen_at < now() - interval '30 days';
      delete from public.argo_old_app_sessions where marked_at < now() - interval '90 days';
    $c$);
  end if;
end $$;
