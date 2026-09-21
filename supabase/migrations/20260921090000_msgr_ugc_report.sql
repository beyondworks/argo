-- App Store 심사 대응(2026-09-21): 사용자 생성 콘텐츠의 신고·차단을 실제 UI에서 쓸 수 있게 한다.
--  · msgr_reports — 메시지 신고. 테이블은 RPC로만 접근(직접 select/insert 금지).
--  · 신고 = 채널을 읽을 수 있는 사람이 타인의 비시스템 메시지를 신고. 관리자(조직)와 신고자 본인이 목록을 본다.
--  · 차단 = 친구 모델의 block 분기를 UI에서 호출(이미 개인 1:1 쓰기·친구 검색·요청을 서버가 막는다). 해제는 차단한 사람만.
--  · 차단은 방향별로 msgr_user_blocks에 둔다 — 친구 행은 쌍당 하나라, 역차단이 requested_by를 덮고 해제로 상대의 차단까지 지웠다(검수 C1).

create table if not exists public.msgr_reports (
  id uuid primary key default gen_random_uuid(),
  message_id bigint references public.msgr_messages(id) on delete set null, -- 글이 지워져도 신고(증거)는 남는다
  channel_id uuid references public.msgr_channels(id) on delete set null, -- 채널을 지워도 신고는 남는다(검수 N2)
  org_id uuid references public.msgr_orgs(id) on delete cascade,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid,   -- 신고 시점 스냅샷(검수 M1) — 작성자가 고치거나 지워도 검토할 수 있게
  author_crew_id uuid,
  body_snapshot text,
  reason text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.msgr_reports enable row level security;
revoke all on public.msgr_reports from public, anon, authenticated; -- 접근은 아래 security definer RPC로만(정책 없음 = 직접 접근 전면 차단)
create unique index if not exists msgr_reports_open_once on public.msgr_reports (message_id, reporter_user_id) where status = 'open';

create table if not exists public.msgr_user_blocks (
  blocker uuid not null references auth.users(id) on delete cascade,
  blocked uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked)
);
alter table public.msgr_user_blocks enable row level security;
revoke all on public.msgr_user_blocks from public, anon, authenticated;
insert into public.msgr_user_blocks (blocker, blocked, created_at)
  select f.requested_by, case when f.a = f.requested_by then f.b else f.a end, coalesce(f.decided_at, now())
    from public.msgr_friends f where f.status = 'blocked' and f.requested_by in (f.a, f.b)
  on conflict do nothing;

create or replace function public.msgr_friend_remove(other uuid, block boolean default false) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[];
begin
  if me is null then raise exception 'msgr_auth'; end if;
  pr := public.msgr_friend_pair(me, other);
  if block then
    insert into public.msgr_user_blocks (blocker, blocked) values (me, other) on conflict do nothing;
    insert into public.msgr_friends (a, b, status, requested_by, decided_at) values (pr[1], pr[2], 'blocked', me, now())
      on conflict (a, b) do update set status = 'blocked', decided_at = now(),
        requested_by = case when public.msgr_friends.status = 'blocked' then public.msgr_friends.requested_by else me end; -- 이미 막힌 쌍의 소유자는 바꾸지 않는다
  else
    delete from public.msgr_friends where a = pr[1] and b = pr[2] and status <> 'blocked';
  end if;
end $$;

create or replace function public.msgr_report_message(msg bigint, reason text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); m public.msgr_messages; rid uuid;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into m from public.msgr_messages where id = msg;
  -- 읽을 수 없는 글과 없는 글은 같은 오류(검수 L1: 존재 여부를 드러내지 않는다)
  if m.id is null or not public.msgr_can_read_channel(m.channel_id) or m.deleted_at is not null or m.kind = 'system' then
    raise exception 'msgr_report_no_message' using errcode = '22023';
  end if;
  if m.author_kind = 'user' and m.author_user_id = me then
    raise exception 'msgr_report_own' using errcode = '42501';
  end if;
  select id into rid from public.msgr_reports where message_id = m.id and reporter_user_id = me and status = 'open';
  if rid is not null then return rid; end if; -- 같은 글 반복 신고는 하나로(검수 L2)
  insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id, author_user_id, author_crew_id, body_snapshot, reason)
    values (m.id, m.channel_id, m.org_id, me, m.author_user_id, m.crew_id, left(m.body, 1000), nullif(left(btrim(coalesce(reason, '')), 500), ''))
    returning id into rid;
  return rid;
end $$;

create or replace function public.msgr_reports_list()
  returns table (id uuid, message_id bigint, channel_id uuid, org_id uuid, reporter_user_id uuid,
                 author_user_id uuid, reason text, status text, created_at timestamptz,
                 message_body text, message_created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select r.id, r.message_id, r.channel_id, r.org_id, r.reporter_user_id,
           r.author_user_id, r.reason, r.status, r.created_at, left(r.body_snapshot, 300), m.created_at
      from public.msgr_reports r
      left join public.msgr_messages m on m.id = r.message_id
     where r.reporter_user_id = auth.uid()              -- 누구나 자기 신고는 본다(처리 상태 확인)
        or (r.org_id is not null and public.msgr_is_admin(r.org_id)) -- 조직 관리자는 조직 신고 전부
     order by r.status, r.created_at desc
$$;

create or replace function public.msgr_report_resolve(report uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); r public.msgr_reports;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into r from public.msgr_reports where id = report;
  if r.id is null then raise exception 'msgr_report_not_found' using errcode = '22023'; end if;
  if r.org_id is null or not public.msgr_is_admin(r.org_id) then
    raise exception 'msgr_report_forbidden' using errcode = '42501'; -- 개인 공간 신고는 신고자만 보고 처리는 운영(문의) 경로
  end if;
  update public.msgr_reports set status = 'resolved', resolved_by = me, resolved_at = now()
   where id = r.id and status = 'open';
end $$;

create or replace function public.msgr_friend_unblock(other uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); pr uuid[];
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  pr := public.msgr_friend_pair(me, other);
  delete from public.msgr_user_blocks where blocker = me and blocked = other;
  if exists (select 1 from public.msgr_user_blocks where blocker = other and blocked = me) then
    update public.msgr_friends set requested_by = other where a = pr[1] and b = pr[2] and status = 'blocked'; -- 상대의 차단은 남긴다
  else
    delete from public.msgr_friends where a = pr[1] and b = pr[2] and status = 'blocked';
  end if;
end $$;

create or replace function public.msgr_my_blocked()
  returns table (user_id uuid, handle text, display_name text, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select k.blocked, p.handle, coalesce(p.display_name, split_part(u.email, '@', 1)), k.created_at
      from public.msgr_user_blocks k
      join auth.users u on u.id = k.blocked
      left join public.msgr_profiles p on p.user_id = u.id
     where k.blocker = auth.uid()
     order by k.created_at desc
$$;

revoke all on function public.msgr_report_message(bigint, text) from public, anon; grant execute on function public.msgr_report_message(bigint, text) to authenticated;
revoke all on function public.msgr_reports_list() from public, anon; grant execute on function public.msgr_reports_list() to authenticated;
revoke all on function public.msgr_report_resolve(uuid) from public, anon; grant execute on function public.msgr_report_resolve(uuid) to authenticated;
revoke all on function public.msgr_friend_unblock(uuid) from public, anon; grant execute on function public.msgr_friend_unblock(uuid) to authenticated;
revoke all on function public.msgr_my_blocked() from public, anon; grant execute on function public.msgr_my_blocked() to authenticated;
