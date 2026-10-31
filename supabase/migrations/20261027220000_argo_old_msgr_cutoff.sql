-- 옛 메신저(0.1.63 이하, v1 화면) 사용 중지 — 기존 옛 앱 장치(20261019135000·20261020201800)를 메신저 지문까지 넓힌다(2026-10-27).
-- 유건 원문(2026-10-27 22:0x, 페퍼 창): "막힌 앱에서 업데이트 하라는 안내만 보이게해. DB에 문제주는 버전은 다 막아".
-- 왜: 0.1.63 이하 메신저는 서버 최소 버전·중단 표지를 읽지 않고, v1 표를 10초(msgr_messages·msgr_crew_approvals)·3초(msgr_crew_requests)마다
--   고정 폴링하며 실패를 삼켜 같은 주기로 다시 부른다(0.1.39 = 1b632e2f App.jsx:4045·2120). 요청을 거부해도 로그·요청은 줄지 않는다.
--   스스로 멈추는 길은 로그아웃뿐이다: 세션이 지워지면 접근 토큰이 끝난 뒤 refresh가 재시도 불가 오류로 거절되고(auth-js 2.114.0
--   _callRefreshToken → _removeSession → SIGNED_OUT), 앱은 로그인 화면으로 간다(session-recovery.mjs). 로그인 화면에는 Supabase 주기 요청이 없고,
--   맨 위에 업데이트 막대가 뜬다(App.jsx:324, 업데이터 주소·서명 키가 지금 판과 같다).
-- 지문: POST 'rpc/msgr_presence_ping'·'rpc/msgr_push_badge_resync' + X-Client-Info 'supabase-js/…; runtime=web'. 옛 폴링은 GET(읽기 전용 트랜잭션이라
--   여기서 지울 수 없다)이므로 이 두 POST에서 끊는다 — 시작할 때(배지 재동기화)·화면에 초점이 있을 때(심박 60초)마다 온다.
--   창을 계속 뒤에 둔 옛 앱은 초점을 받기 전까지 끊기지 않는다(그 몫은 로그로 세션을 골라 한 번 지우는 방법 A).
-- 지금 판 보호: v2(0.1.64+)는 이 두 RPC를 네트워크로 보내지 않는다(source.mjs RPCS). 본체(node)·오피스(node, argo-office/)·CLI·VPS 봇(봇 토큰 —
--   authenticated 세션 아님)·익명은 조건 밖이다. 경로가 두 RPC가 아니면 설정 행도 읽지 않는다.
-- 스위치(본체 장치와 따로, 값은 소문자 'on'만):
--   켜기:  insert into public.msgr_settings (key, value) values ('old_msgr_cutoff', 'on') on conflict (key) do update set value = excluded.value;
--   끄기:  delete from public.msgr_settings where key = 'old_msgr_cutoff';
--   끄면 그 뒤로 새로 폐기하는 세션 0. 이미 폐기된 세션은 되살아나지 않는다(다시 로그인하면 된다). 데이터는 지우지 않는다(auth.sessions 행 = 로그아웃).
-- 바꾸는 것은 argo_old_app_check 본문에 메신저 갈래 하나뿐이다(나머지는 20261020201800과 같다). 표·등록·권한·cron은 그대로다.
-- 되돌림: scripts/rollback/20261027220000_argo_old_msgr_cutoff.down.sql(함수를 20261020201800 본문으로).

create or replace function public.argo_old_app_check() returns void
  language plpgsql volatile security definer set search_path = public, pg_temp set lock_timeout = '200ms' as $$
declare
  claims json; hdr json; sid uuid; uid uuid; xci text; created timestamptz; prior boolean; o public.argo_old_app_sessions;
  mx int[]; hv int[]; g public.argo_gate_sessions; cut_now boolean := false;
begin
  if current_setting('request.method', true) is distinct from 'POST' then return; end if;
  begin -- 모든 일을 예외 블록 안에서: 설정 표 잠금(lock_timeout 55P03)·권한·형식 오류 어느 것도 요청을 실패시키지 않는다
    -- 오피스 에이전트(argo-office 서버, X-Client-Info 끝 ', argo-office/<판>')는 본체 앱이 아니다 — 설정을 읽기 전에 바로 통과(2026-10-20)
    xci := nullif(current_setting('request.headers', true), '')::json->>'x-client-info';
    if position('argo-office/' in coalesce(xci, '')) > 0 then return; end if;
    -- 옛 메신저(0.1.63 이하, v1 화면) — 2026-10-27 추가(20261027220000). 지문: 웹 클라이언트(supabase-js; runtime=web)가 v1 전용 RPC를 POST로 부름.
    --   msgr_presence_ping(시작·초점마다, 60초 심박)·msgr_push_badge_resync(시작·앞으로 올 때). v2 판(0.1.64+)은 이 둘을 어댑터가 요청 없이 끝낸다
    --   (apps/messenger/src/v2/source.mjs RPCS — presence는 none, badge_resync는 write → v2_unsupported). 본체·오피스는 runtime=node라 해당 없음.
    --   경로가 이 둘이 아니면 설정을 읽지 않고 아래 본체 판정으로 간다(다른 요청의 비용 0). 스위치는 본체와 따로: msgr_settings 'old_msgr_cutoff' = 'on'.
    if ltrim(coalesce(current_setting('request.path', true), ''), '/') in ('rpc/msgr_presence_ping', 'rpc/msgr_push_badge_resync')
       and coalesce(xci, '') like 'supabase-js/%' and position('runtime=web' in xci) > 0 then -- 웹이 아니면(본체·CLI) 아래 본체 판정으로 그대로 간다
      if not exists (select 1 from public.msgr_settings where key = 'old_msgr_cutoff' and value = 'on') then return; end if;
      claims := nullif(current_setting('request.jwt.claims', true), '')::json;
      if claims is null or claims->>'role' is distinct from 'authenticated' or claims->>'client_id' is not null then return; end if;
      sid := (claims->>'session_id')::uuid;
      uid := (claims->>'sub')::uuid;
      if sid is null or uid is null then return; end if;
      -- 지문이 정확해(새 판은 이 요청을 보내지 않는다) 의심 대기 없이 바로 폐기한다. 기록은 같은 표(client_info로 메신저 구분).
      insert into public.argo_old_app_sessions (session_id, user_id, due_at, cut_at, session_created_at, client_info)
        select sid, uid, now(), now(), s.created_at, left('msgr|' || xci, 160) from auth.sessions s where s.id = sid
        on conflict (session_id) do update set cut_at = coalesce(public.argo_old_app_sessions.cut_at, now());
      delete from auth.sessions where id = sid; -- GoTrue 로그아웃과 같다: 접근 토큰이 끝나면 refresh가 거절돼 옛 메신저는 로그인 화면으로 간다(재시도 불가 오류 → SIGNED_OUT)
      return;
    end if;
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
