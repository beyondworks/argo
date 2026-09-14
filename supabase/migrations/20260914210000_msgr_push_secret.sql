-- 보안 감사 HIGH-1(2026-09-14): 푸시 엣지 함수(msgr-push)가 인증 없이 공개돼 임의 uuid의 안읽음 수 조회·배지 푸시 유발·message_id 스캔이
-- 가능했다. 트리거의 pg_net 호출에 msgr_settings.push_secret 을 Authorization: Bearer 로 싣는다. 시크릿 행이 없으면 예전 헤더 그대로
-- (엣지도 PUSH_FN_SECRET 미설정이면 검사하지 않는다) — 순서: 엣지 시크릿 등록 → 재배포 → msgr_settings 행 삽입.
create or replace function public.msgr_push_headers() returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when s.value is null or s.value = '' then '{"Content-Type": "application/json"}'::jsonb
                else jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || s.value) end
      from (select (select value from public.msgr_settings where key = 'push_secret') as value) s
$$;
revoke all on function public.msgr_push_headers() from public, anon, authenticated;

create or replace function public.msgr_push_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; n int;
begin
  if new.kind <> 'text' or new.deleted_at is not null then return new; end if;
  select count(*) into n from public.msgr_push_recipients(new) u where exists (select 1 from public.msgr_push_tokens t where t.user_id = u);
  if n = 0 then return new; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(),
    body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 5000);
  return new;
exception when others then return new; -- 푸시 실패가 메시지 저장을 막지 않는다
end $$;

create or replace function public.msgr_push_badge_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text;
begin
  if tg_op = 'UPDATE' and new.last_read_id is not distinct from old.last_read_id then return new; end if;
  if not exists (select 1 from public.msgr_push_tokens t where t.user_id = new.user_id and t.platform = 'ios') then return new; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return new; end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(),
    body := jsonb_build_object('badge_user', new.user_id), timeout_milliseconds := 5000);
  return new;
exception when others then return new;
end $$;
