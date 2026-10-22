-- 오피스 에이전트 요청을 옛 앱 장치에서 뺀다(2026-10-20, 오피스 안전장치).
-- 왜: 오피스(별도 저장소, MCP·CLI 독립 앱)는 본체 서버를 aoc_ 열쇠로 중계해 사용자 세션으로 Supabase를 부른다.
--   오피스 에이전트가 보내는 값(argo-office 서버, 2026-10-20 기준):
--     User-Agent   'argo-office-agent/1'
--     X-Client-Info 'supabase-js/2.117.2; runtime=node; …, argo-office/1'
--   · #1107 argo_old_app_check(요청 전 함수)는 X-Client-Info가 옛 본체의 'supabase-js/2.110.2; runtime=node…'일 때만 본다.
--     지금 오피스 값(2.117.2)은 그 조건에 안 걸리지만, 오피스가 supabase-js 판을 바꾸거나 고정하면 본체 옛 앱처럼 표시·폐기될 수 있다.
--     → X-Client-Info에 'argo-office/'가 있으면 설정 표를 읽기 전에 바로 통과한다(요청당 읽기도 0).
--   · #1113 _argo_old_desktop_classify(데스크톱 옛 세션 일괄 폐기 판정)는 auth.sessions.user_agent가 'node'가 아니면 'ua_other'로 뺀다.
--     오피스 세션('argo-office-agent/1')은 지금도 빠지지만 미리보기의 'other_user_agents'에 섞여 사람이 판단해야 했고,
--     오피스가 UA를 'node'로 바꾸는 순간 대상이 된다. → user_agent가 'argo-office'로 시작하면 제외 사유 'office'로 따로 센다.
-- 바꾸는 것은 두 함수에 한 줄씩뿐이다(나머지 본문은 20261019135000·20261019150000과 같다). 표·스위치·등록(pgrst.db_pre_request)·권한은 그대로다.
-- 우회 가능성: 두 값 모두 요청자가 정하는 값이지만, 이 장치의 대상(옛 본체 앱 0.1.113 이하)은 이미 발행된 고정 실행 파일이라 값을 바꿀 수 없다.
--   이 장치는 권한 경계가 아니다(옛 앱을 멈추게 하는 장치) — 오피스 흉내로 피해 가도 데이터 접근 권한은 RLS 그대로다.
-- 되돌림: scripts/rollback/20261020201800_argo_office_exempt.down.sql(두 함수를 이 파일 이전 본문으로).

-- 1) #1107 요청 전 함수 — 오피스 바로 통과
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

-- 2) #1113 일괄 폐기 판정 — 오피스 세션은 제외 사유 'office'
create or replace function public._argo_old_desktop_classify()
  returns table (session_id uuid, user_id uuid, created_at timestamptz, reason text, ver text)
  language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public._argo_old_desktop_ready();
  return query
  select s.id, s.user_id, s.created_at,
         case
           when j->>'oauth_client_id' is not null then 'oauth_client'
           when j->>'user_agent' like 'argo-office%' then 'office' -- 오피스 에이전트(UA 'argo-office-agent/<판>', 2026-10-20)
           when g.app_version is not null then 'gate_versioned'
           when nullif(btrim(coalesce(j->>'user_agent', '')), '') is null then 'ua_missing'
           when j->>'user_agent' <> 'node' then 'ua_other'
           when s.created_at > now() - interval '35 minutes' then 'recent_login'
         end,
         case when g.app_version is not null then g.app_version
              when g.session_id is not null then 'gate_unversioned'
              else 'no_gate' end
    from auth.sessions s
    cross join lateral (select to_jsonb(s) as j) x
    left join public.argo_gate_sessions g on g.session_id = s.id;
end $$;
revoke all on function public._argo_old_desktop_classify() from public, anon, authenticated, service_role;
