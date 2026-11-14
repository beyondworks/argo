-- 옛 앱 사용 중지 장치가 "새 판이 한 번 쓴 로그인 세션"을 옛 판이 이어 쓰면 못 막던 결함을 고친다(2026-11-14).
-- 유건 원문: "로그인 풀어버리고 안내 뜨게 해줘."(2026-11-04), "옛판 앱 켜면 로그인 풀어두라고 했는데 적용 안됐네?"(2026-11-14 18:5x, 페퍼 경유).
-- 실측(운영 로그 2026-11-14): 세션 8424a6fd를 06:00 KST쯤 0.1.125가 써서 argo_gate_sessions에 app_version '0.1.125'가 남았고, 15:35부터 같은 세션을
--   옛 판(0.1.106 이하 — X-Client-Info 'supabase-js/2.110.2; runtime=node; runtime-version=22.23.2', ' argo/' 꼬리 없음, 관문 호출 0)이 이어 써
--   분당 약 347건을 불렀다. 세션 b8f1f0d4도 같은 모양이다. 종전 규칙 "관문 기록에 버전이 남은 세션은 폐기하지 않는다"(20261019135000)가 이 세션을 지켰다.
-- 바꾸는 것: argo_old_app_check의 '관문 기록에 버전이 있으면 return' 한 줄뿐이다. 기준(old_app_cutoff_max)이 0.1.113 이상이면 그런 세션의
--   꼬리 없는 옛 서명 POST도 '의심 → 35분 → 폐기' 흐름에 태운다(버전 없는 관문 세션과 같은 흐름). 나머지 본문은 20261027220000과 같다.
-- 새 판 보호(경우 표는 PR 본문):
--   · 0.1.114부터 본체(Node)의 모든 Supabase 요청은 X-Client-Info 끝에 ' argo/<버전>'을 단다(src/supabase-client.mjs, test/supabase-client-tail.test.mjs가
--     0.1.114 태그부터 잠금). 꼬리 있는 요청은 이 함수 맨 앞에서 바로 통과한다 — 0.1.114+·개발 빌드·상주 :3001은 표시조차 되지 않는다.
--   · 20261019135000의 "0.1.114의 꼬리 없는 요청을 지킨다"는 방어용 가정이었다. 그런 요청이 있더라도 새 판은 30분마다(실패하면 5분 뒤) 꼬리 있는
--     관문(argo_min_app_version)을 부르고, 그 호출이 의심 표시를 지운다(tv is not null 갈래 — 이 파일은 관문 함수를 바꾸지 않는다). 35분 = 30분 + 5분.
--   · 오피스(argo-office/)·메신저(runtime=web)·OAuth 클라이언트 토큰(client_id)·GET·anon·service_role 제외는 그대로다.
--   · 기준이 0.1.113 아래(설정 없음 = 0.1.106)면 종전대로 지킨다 — 버전 있는 세션을 이어 쓰는 옛 판이 0.1.107~0.1.113일 수 있다(그 판은 기준 밖).
-- 남는 한계: 새 판과 옛 판이 같은 세션을 동시에 계속 쓰면 새 판의 관문이 30분마다 표시를 지워 옛 판도 끊기지 않는다(새 판을 지키는 쪽).
-- 스위치·표·등록(pgrst.db_pre_request)·권한·cron은 그대로다(운영 'old_app_cutoff' = 'on', 'old_app_cutoff_max' = '0.1.113' — 2026-11-14 18:45 KST).
-- 되돌림: scripts/rollback/20261114210000_argo_old_app_cutoff_reused_session.down.sql(함수를 20261027220000 본문으로).

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
      if g.app_version is not null then
        -- 관문에 꼬리가 있던 세션(0.1.114+가 한 번 쓴 로그인)에 꼬리 없는 옛 서명 POST가 왔다 = 옛 판이 같은 세션을 이어 쓴다(2026-11-14 운영 실측, 이 파일 머리말).
        -- 기준이 0.1.113 이상이면 바로 끊지 않고 아래 '의심 → 35분 → 폐기'로 보낸다. 새 판은 30분마다 꼬리 있는 관문을 불러 35분 안에 표시를 지운다.
        if mx < array[0,1,113] then return; end if; -- 기준이 0.1.113 아래면 0.1.107~0.1.113과 가를 수 없어 종전대로 지킨다
      elsif hv is not null then cut_now := true; -- 버전 헤더(0.1.112·0.1.113) ≤ 기준 — 확정
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
