-- 모바일 푸시(APNs·FCM) — 유건 제보 2026-09-12 "모바일앱에서는 알림이 안 오네". 폰은 앱이 뒤로 가면 웹뷰가 멈춰 실시간 메시지를
-- 못 받으므로 서버가 밀어야 한다. 여기서는 (1) 기기 토큰 등록 (2) 메시지 insert 뒤 수신자 계산 → 엣지 펑션 msgr-push 호출(pg_net)만 한다.
-- 발송(APNs HTTP/2·FCM v1)과 토큰 정리는 엣지 펑션 몫. 엣지 펑션은 message_id 하나만 받아 수신자를 다시 계산하고
-- msgr_push_sent 로 메시지당 한 번만 보내므로 공유 비밀 없이도 재생·위조 호출이 같은 알림 한 번 이상을 만들지 못한다.
create extension if not exists pg_net;

create table if not exists public.msgr_push_tokens (
  token text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android')),
  device text not null default '',
  updated_at timestamptz not null default now()
);
create index if not exists msgr_push_tokens_user on public.msgr_push_tokens(user_id);
alter table public.msgr_push_tokens enable row level security;
drop policy if exists msgr_push_tokens_own on public.msgr_push_tokens;
create policy msgr_push_tokens_own on public.msgr_push_tokens for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 엣지 펑션 주소 등 서버 설정(셀프호스트마다 다르다 — 마이그레이션에 URL을 박지 않는다). 서비스 롤만 읽는다.
create table if not exists public.msgr_settings (key text primary key, value text not null);
alter table public.msgr_settings enable row level security;

create table if not exists public.msgr_push_sent (message_id bigint primary key references public.msgr_messages(id) on delete cascade, sent_at timestamptz not null default now(), sent int not null default 0);
alter table public.msgr_push_sent enable row level security;

create or replace function public.msgr_push_register(platform text, token text, device text default '') returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'msgr_unauthorized'; end if;
  if platform not in ('ios', 'android') or token is null or length(token) < 16 or length(token) > 4096 then raise exception 'msgr_bad_push_token'; end if;
  insert into public.msgr_push_tokens(token, user_id, platform, device) values (token, auth.uid(), platform, coalesce(left(device, 80), ''))
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, device = excluded.device, updated_at = now();
end $$;
revoke all on function public.msgr_push_register(text, text, text) from public;
grant execute on function public.msgr_push_register(text, text, text) to authenticated;

create or replace function public.msgr_push_unregister(token text) returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from public.msgr_push_tokens t where t.token = msgr_push_unregister.token and t.user_id = auth.uid();
$$;
revoke all on function public.msgr_push_unregister(text) from public;
grant execute on function public.msgr_push_unregister(text) to authenticated;

-- 수신자 = 데스크톱 알림 규칙(App.jsx notifyReply)과 같다: DM 상대, 답글 원문 작성자, (크루 답이면) 스레드 시작자, 사람 멘션. 작성자 본인 제외.
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    select cm.member_id as u from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id
      where ch.id = m.channel_id and ch.kind = 'dm' and cm.member_kind = 'user'
    union all select p.author_user_id from public.msgr_messages p where p.id = m.reply_to and p.author_kind = 'user'
    union all select r.author_user_id from public.msgr_messages r where r.id = m.thread_root and r.author_kind = 'user' and m.author_kind = 'crew'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
$$;

-- 엣지 펑션(서비스 롤)이 message_id 로 수신자를 다시 계산한다 — 트리거가 보낸 목록을 믿지 않는다.
create or replace function public.msgr_push_recipients_of(mid bigint) returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(array_agg(u), '{}'::uuid[]) from public.msgr_messages m, public.msgr_push_recipients(m) u where m.id = mid;
$$;
revoke all on function public.msgr_push_recipients_of(bigint) from public, anon, authenticated;

create or replace function public.msgr_push_enqueue() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare url text; n int;
begin
  if new.kind <> 'text' or new.deleted_at is not null then return new; end if;
  select count(*) into n from public.msgr_push_recipients(new) u where exists (select 1 from public.msgr_push_tokens t where t.user_id = u);
  if n = 0 then return new; end if;
  select value into url from public.msgr_settings where key = 'push_url';
  if url is null then return new; end if;
  perform net.http_post(url := url, headers := '{"Content-Type": "application/json"}'::jsonb,
    body := jsonb_build_object('message_id', new.id), timeout_milliseconds := 5000);
  return new;
exception when others then return new; -- 푸시 실패가 메시지 저장을 막지 않는다
end $$;
drop trigger if exists msgr_push_enqueue on public.msgr_messages;
create trigger msgr_push_enqueue after insert on public.msgr_messages for each row execute function public.msgr_push_enqueue();
