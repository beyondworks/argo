-- 메신저 일시 중단 공지를 휴대폰 알림으로 — 토큰 있는 모든 사용자의 기기마다 한 번(2026-10-16, 실제 발송 여부는 유건님 결정 뒤).
-- 방마다 넣는 system 공지(20261016170000 msgr_pause_announce)는 푸시가 가지 않는다(msgr_push_enqueue가 kind <> 'text'를 건너뛴다). 보낸다 해도 방 수만큼 쌓인다.
-- 그래서 공지 한 건을 따로 한 번 보낸다.
--   msgr_pause_push(ko_title, ko, en_title, en) — service_role만(문구 4개 모두 인자 — 유건님 승인 문구, 2026-10-16). 중단 중일 때만(공지 id = 'pause:' || 스위치 값). 공지 행을 넣고, 넣었을 때만 엣지 msgr-push를 한 번 부른다({broadcast_id}).
--     같은 회차로 다시 부르면 행이 이미 있어 부르지 않는다(반환 queued=false).
--   엣지는 그 행을 claimed_at null→now로 선점하고 행의 문구로 보낸다(요청 본문의 문구는 쓰지 않는다). 사용자 언어를 저장하지 않으므로 제목 = 한국어 제목,
--   본문 = 한국어 본문 다음 줄에 '영어 제목: 영어 본문'(엣지 core.js broadcastPushText) — 재생·위조 호출은 이미 잡힌 행·없는 행이라 0건.
--   트리거로는 열지 않는다(명시적 호출만). 결과(users·tokens·sent·failed·deferred·truncated)는 행의 result에 남는다.
-- 실행 순서(PR 본문): 스위치 켬 → msgr_pause_announce(방 공지) → 엣지 배포 확인 → msgr_pause_push(푸시 1회).
set local lock_timeout = '5s';

create table if not exists public.msgr_push_broadcasts (
  id text primary key check (length(id) between 1 and 120),
  ko_title text not null check (length(ko_title) between 1 and 100),
  ko text not null check (length(ko) between 1 and 500),
  en_title text not null check (length(en_title) between 1 and 100),
  en text not null check (length(en) between 1 and 500),
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  finished_at timestamptz,
  result jsonb
);
alter table public.msgr_push_broadcasts enable row level security; -- 정책 없음: service_role(엣지·운영자)만
revoke all on table public.msgr_push_broadcasts from anon, authenticated;

create or replace function public.msgr_pause_push(p_ko_title text, p_ko text, p_en_title text, p_en text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare since text; bid text; url text; n int;
begin
  select s.value into since from public.msgr_settings s where s.key = 'msgr_paused';
  if not found then raise exception 'msgr_not_paused' using errcode = '22023'; end if;
  if coalesce(btrim(p_ko_title), '') = '' or coalesce(btrim(p_ko), '') = '' or coalesce(btrim(p_en_title), '') = '' or coalesce(btrim(p_en), '') = ''
     or length(p_ko_title) > 100 or length(p_en_title) > 100 or length(p_ko) > 500 or length(p_en) > 500 then raise exception 'msgr_pause_text_invalid' using errcode = '22023'; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then raise exception 'msgr_push_url_missing' using errcode = '22023'; end if; -- 행을 넣기 전에 — 엣지를 못 부르는 채로 회차를 써 버리지 않게
  bid := 'pause:' || since;
  -- 엣지(msgr-push index.ts broadcast_id)와 같은 형식 — 공백 등이 든 스위치 값(now()::text 같은)은 엣지가 400을 주고 pg_net 응답은 아무도 보지 않아
  -- 조용히 실패한다. 행을 쓰기 전에 거절한다(스위치 값은 '2026-10-16T17:00:00+09:00'처럼 공백 없는 ISO 문자열).
  if bid !~ '^[A-Za-z0-9:._+-]{1,120}$' then raise exception 'msgr_pause_since_invalid' using errcode = '22023', detail = 'msgr_paused value must be an ISO string without spaces'; end if;
  insert into public.msgr_push_broadcasts (id, ko_title, ko, en_title, en) values (bid, p_ko_title, p_ko, p_en_title, p_en) on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n = 0 then return jsonb_build_object('queued', false, 'id', bid, 'reason', 'already'); end if;
  perform net.http_post(url := url, headers := public.msgr_push_headers(), body := jsonb_build_object('broadcast_id', bid), timeout_milliseconds := 5000);
  return jsonb_build_object('queued', true, 'id', bid);
end $$;
revoke all on function public.msgr_pause_push(text, text, text, text) from public, anon, authenticated;
grant execute on function public.msgr_pause_push(text, text, text, text) to service_role;

notify pgrst, 'reload schema';
