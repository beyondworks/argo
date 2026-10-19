-- 데스크톱 옛 세션 일괄 폐기(2026-10-19, #1110 '새 시작' 스위치를 켜기 전 단계).
-- 왜: 잠들어 있던 옛 본체 앱(0.1.106~0.1.113)이 깨어나 새 시작 매니페스트를 읽으면 자기만 가진 파일을 로컬에서 지울 수 있다.
--   #1107(요청 전 함수)은 깨어 있는 옛 앱만 POST 때 35분 뒤 끊는다. 잠든 기기는 요청이 없어 표시조차 안 되고, 깨어나면 refresh에 성공해
--   접근 토큰으로 Storage를 최대 1시간 쓴다. 그래서 스위치를 켜기 전에 "0.1.114 이상임이 확인되지 않은 데스크톱 세션"을 한꺼번에 지운다.
-- 지운 뒤: 옛 기기의 refresh는 "Refresh Token Not Found"로 거절되어 재로그인 화면으로 간다(#1107 머리말 — v0.1.106 devicesession.mjs:136-185).
--   이미 받은 접근 토큰은 최대 1시간 유효하다(JWT 만료까지) — 운영 순서에서 1시간을 기다린 뒤 최소 버전·새 시작 스위치로 넘어간다.
--
-- 판별(서버에 남는 것만으로 — 요청 헤더는 남지 않는다):
--   · auth.sessions.user_agent = 그 세션을 마지막으로 refresh한(없으면 만든) 요청의 User-Agent. GoTrue가 refresh마다 고친다
--     (supabase/auth internal/tokens/service.go → Session.UpdateOnlyRefreshInfo: refreshed_at·user_agent·ip).
--     본체 데스크톱은 사이드카 Node(undici fetch)가 로그인(verifyOtp·exchangeCodeForSession)과 refresh를 하므로 정확히 'node'다.
--     메신저 앱(데스크톱 WKWebView·WebView2, iOS·Android 웹뷰)·웹 브라우저·오피스 웹뷰는 'Mozilla/5.0 …', 오피스 서버는 refresh하지 않는다
--     (argo-office server/agent/auth.js autoRefreshToken:false). user_agent가 'node'가 아니면 제외, 비어 있으면 가를 수 없어 제외(안전 쪽).
--   · 0.1.114 이상 = #1107 관문 기록(argo_gate_sessions)에 app_version이 남은 세션(꼬리 있는 argo_min_app_version 호출).
--     꼬리는 0.1.114 발행본과 #1107이 들어간 main 코드(개발 빌드·상주 :3001)만 단다 — 버전 값과 무관하게 모두 제외한다.
--   · 원격 MCP(OAuth 클라이언트 세션, oauth_client_id)는 제외. 만든 지 35분이 안 된 세션은 관문 첫 호출 전일 수 있어 제외(다음 회차에 본다).
--   · 남는 것(user_agent 'node' + 버전 있는 관문 기록 없음) = 0.1.106 이하(관문 없음) 또는 0.1.107~0.1.113(버전 없는 관문 기록).
--     가를 수 없어 함께 대상이 되는 것: #1107 이전 코드로 띄운 개발 빌드, 쿠키 방식 Argo 서버(워커·공개 호스트 배포, @supabase/ssr이 Node에서 refresh),
--     Node 스크립트 로그인(오피스 이전 스크립트 등). 모두 다시 로그인하면 된다. 미리보기의 'other_user_agents'·대상 계정 수로 먼저 본다.
--
-- 실행(맥 one, scripts/old-desktop-session-purge.sh가 감싼다):
--   ① select public.argo_old_desktop_purge_preview();  — 아무것도 쓰지 않는다. 대상 세션 수·계정 수·버전 분포·제외 사유별 수·digest
--   ② select public.argo_old_desktop_purge_run(<count>, '<digest>');  — 관문 기록 표를 잠그고 다시 계산해 수와 digest가 같을 때만 지운다.
--      다르면 예외(트랜잭션 전체 되돌림 = 0건 삭제). 지운 세션은 argo_old_app_sessions에 cut_at으로 남는다(#1107 보존 90일,
--      같은 계정이 옛 앱으로 다시 로그인하면 #1107이 2시간을 기다리지 않고 바로 표시한다).
-- 둘 다 직접 DB 연결(postgres)에서만 부른다 — API 역할(anon·authenticated·service_role)은 실행 권한이 없다.
-- 전제: #1107(20261019135000_argo_old_app_cutoff) 적용 + 0.1.114 발행. 관문 함수가 기록을 남기지 않으면 미리보기부터 멈춘다.
-- 되돌림: scripts/rollback/20261019150000_argo_old_desktop_session_purge.down.sql(함수만 지운다). 지운 로그인 세션은 되살아나지 않는다.

-- 0) 준비 확인 — #1107이 없거나 관문 함수가 옛 본문이면 멈춘다(관문 기록이 비어 있으면 새 앱까지 대상이 된다).
create or replace function public._argo_old_desktop_ready() returns void
  language plpgsql stable set search_path = public, pg_temp as $$
begin
  if to_regclass('public.argo_gate_sessions') is null or to_regclass('public.argo_old_app_sessions') is null then
    raise exception '옛 앱 장치(#1107, 20261019135000_argo_old_app_cutoff)가 없다 — 관문 기록 없이는 새 앱을 가를 수 없어 멈춘다';
  end if;
  if to_regprocedure('public.argo_min_app_version(text)') is null
     or pg_get_functiondef('public.argo_min_app_version(text)'::regprocedure) not like '%argo_gate_sessions%' then
    raise exception '관문 함수가 세션을 기록하지 않는다(#1107 미적용 또는 되돌림) — 멈춘다';
  end if;
end $$;

-- 1) 세션마다 판정 한 곳. reason이 null이면 대상, 아니면 제외 사유. ver = 관문 기록 버전 | 'gate_unversioned' | 'no_gate'.
--    선택 열(user_agent·oauth_client_id)은 to_jsonb로 읽는다 — GoTrue 판에 따라 열이 없어도 깨지지 않고 '없음' 쪽(제외·대상 아님)으로 간다.
create or replace function public._argo_old_desktop_classify()
  returns table (session_id uuid, user_id uuid, created_at timestamptz, reason text, ver text)
  language plpgsql stable set search_path = public, pg_temp as $$
begin
  perform public._argo_old_desktop_ready();
  return query
  select s.id, s.user_id, s.created_at,
         case
           when j->>'oauth_client_id' is not null then 'oauth_client'
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

-- 대상 집합의 지문: 정렬한 id 문자열의 md5(스크립트가 파일에서 같은 값을 다시 계산한다 — LC_ALL=C sort와 같은 바이트 순)
create or replace function public._argo_old_desktop_digest(ids uuid[]) returns text
  language sql immutable as $$ select md5(coalesce((select string_agg(i::text, ',' order by i::text collate "C") from unnest(ids) i), '')) $$;

-- 2) 미리보기 — 쓰기 0(한 문장, 판정은 CTE로 한 번만).
create or replace function public.argo_old_desktop_purge_preview() returns jsonb
  language sql stable set search_path = public, pg_temp as $$
  with c as materialized (select * from public._argo_old_desktop_classify()),
       t as (select * from c where reason is null)
  select jsonb_build_object(
    'total_sessions', (select count(*) from c),
    'target_sessions', (select count(*) from t),
    'target_accounts', (select count(distinct user_id) from t),
    'digest', public._argo_old_desktop_digest(array(select session_id from t)),
    'target_by_version', coalesce((select jsonb_object_agg(ver, n) from (select ver, count(*) n from t group by ver) x), '{}'),
    'excluded_by_reason', coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) n from c where reason is not null group by reason) x), '{}'),
    'excluded_versions', coalesce((select jsonb_object_agg(ver, n) from (select ver, count(*) n from c where reason = 'gate_versioned' group by ver) x), '{}'),
    -- 'node'가 아닌 user_agent 상위 10개(앞 60자) — 데스크톱인데 다른 값으로 남는 경우가 있는지 사람이 본다
    'other_user_agents', coalesce((select jsonb_agg(jsonb_build_object('ua', ua, 'n', n) order by n desc, ua) from (
        select left(to_jsonb(s)->>'user_agent', 60) ua, count(*) n from auth.sessions s join c on c.session_id = s.id
         where c.reason = 'ua_other' group by 1 order by 2 desc, 1 limit 10) x), '[]'),
    'versioned_gate_6h', (select count(*) from public.argo_gate_sessions where app_version is not null and seen_at >= now() - interval '6 hours')
  )
$$;

-- 3) 대상 id 목록 — 스크립트가 실행 전에 0600 파일로 남긴다. 쓰기 0.
create or replace function public.argo_old_desktop_purge_list()
  returns table (session_id uuid, user_id uuid, created_at timestamptz, ver text)
  language sql stable set search_path = public, pg_temp as $$
    select c.session_id, c.user_id, c.created_at, c.ver from public._argo_old_desktop_classify() c
     where c.reason is null order by c.session_id::text collate "C"
$$;

-- 4) 실행 — 관문 기록 표를 잠가(관문 쓰기만 잠깐 기다린다, 읽기는 그대로) 다시 계산한 집합이 미리보기와 같을 때만 지운다.
create or replace function public.argo_old_desktop_purge_run(p_expect_count int, p_expect_digest text) returns jsonb
  language plpgsql volatile set search_path = public, pg_temp set lock_timeout = '5s' as $$
declare ids uuid[]; n int; accounts int; deleted int;
begin
  perform public._argo_old_desktop_ready();
  if (select count(*) from public.argo_gate_sessions where app_version is not null and seen_at >= now() - interval '6 hours') = 0 then
    raise exception '최근 6시간 버전 있는 관문 기록 0 — 0.1.114가 기록을 남기는지 확인되지 않아 멈춘다(0건 삭제)';
  end if;
  lock table public.argo_gate_sessions in share mode; -- 잠근 뒤로 관문 기록이 바뀌지 않는다: 계산과 삭제 사이에 새 앱이 끼지 못한다
  select array_agg(c.session_id) into ids from public._argo_old_desktop_classify() c where c.reason is null;
  ids := coalesce(ids, '{}');
  n := cardinality(ids);
  if p_expect_count is null or p_expect_digest is null or n <> p_expect_count or public._argo_old_desktop_digest(ids) <> p_expect_digest then
    raise exception '미리보기와 대상이 다르다(확인 %건, 지금 %건) — 0건 삭제. 미리보기부터 다시', p_expect_count, n;
  end if;
  select count(distinct s.user_id) into accounts from auth.sessions s where s.id = any(ids);
  insert into public.argo_old_app_sessions (session_id, user_id, due_at, cut_at, session_created_at, client_info)
    select s.id, s.user_id, now(), now(), s.created_at, 'bulk-purge ' || coalesce(g.app_version, case when g.session_id is null then 'no_gate' else 'gate_unversioned' end)
      from auth.sessions s left join public.argo_gate_sessions g on g.session_id = s.id where s.id = any(ids)
    on conflict (session_id) do update set cut_at = coalesce(public.argo_old_app_sessions.cut_at, now());
  delete from auth.sessions s where s.id = any(ids); -- GoTrue 로그아웃과 같다(refresh_tokens는 FK로 함께)
  get diagnostics deleted = row_count;
  if deleted <> n then
    raise exception '지운 수(%)가 대상 수(%)와 다르다 — 되돌린다(0건 삭제)', deleted, n;
  end if;
  return jsonb_build_object('deleted_sessions', deleted, 'accounts', accounts, 'digest', p_expect_digest, 'at', now());
end $$;

-- API 역할은 부르지 못한다(직접 DB 연결의 postgres만).
revoke all on function public._argo_old_desktop_ready() from public, anon, authenticated, service_role;
revoke all on function public._argo_old_desktop_classify() from public, anon, authenticated, service_role;
revoke all on function public._argo_old_desktop_digest(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.argo_old_desktop_purge_preview() from public, anon, authenticated, service_role;
revoke all on function public.argo_old_desktop_purge_list() from public, anon, authenticated, service_role;
revoke all on function public.argo_old_desktop_purge_run(int, text) from public, anon, authenticated, service_role;
