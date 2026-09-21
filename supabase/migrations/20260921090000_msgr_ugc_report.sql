-- App Store 심사 대응(2026-09-21): 사용자 생성 콘텐츠의 신고·차단을 실제 UI에서 쓸 수 있게 한다.
--  · msgr_reports — 메시지 신고. 테이블은 RPC로만 접근(직접 select/insert 금지).
--  · 신고 = 채널을 읽을 수 있는 사람이 타인의 비시스템 메시지를 신고. 관리자(조직)와 신고자 본인이 목록을 본다.
--  · 차단 = 친구 모델의 block 분기를 UI에서 호출(이미 개인 1:1 쓰기·친구 검색·요청을 서버가 막는다). 해제는 차단한 사람만.

create table if not exists public.msgr_reports (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references public.msgr_messages(id) on delete cascade,
  channel_id uuid not null references public.msgr_channels(id) on delete cascade,
  org_id uuid references public.msgr_orgs(id) on delete cascade,
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reason text,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.msgr_reports enable row level security;
revoke all on public.msgr_reports from public, anon, authenticated; -- 접근은 아래 security definer RPC로만(정책 없음 = 직접 접근 전면 차단)

create or replace function public.msgr_report_message(msg bigint, reason text default null) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); m public.msgr_messages; rid uuid;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into m from public.msgr_messages where id = msg;
  if m.id is null or m.deleted_at is not null or m.kind = 'system' then
    raise exception 'msgr_report_no_message' using errcode = '22023';
  end if;
  if m.author_kind = 'user' and m.author_user_id = me then
    raise exception 'msgr_report_own' using errcode = '42501';
  end if;
  if not public.msgr_can_read_channel(m.channel_id) then
    raise exception 'msgr_report_forbidden' using errcode = '42501';
  end if;
  insert into public.msgr_reports (message_id, channel_id, org_id, reporter_user_id, reason)
    values (m.id, m.channel_id, m.org_id, me, nullif(left(btrim(coalesce(reason, '')), 500), ''))
    returning id into rid;
  return rid;
end $$;

create or replace function public.msgr_reports_list()
  returns table (id uuid, message_id bigint, channel_id uuid, org_id uuid, reporter_user_id uuid,
                 author_user_id uuid, reason text, status text, created_at timestamptz,
                 message_body text, message_created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select r.id, r.message_id, r.channel_id, r.org_id, r.reporter_user_id,
           m.author_user_id, r.reason, r.status, r.created_at, left(m.body, 300), m.created_at
      from public.msgr_reports r
      join public.msgr_messages m on m.id = r.message_id
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
  delete from public.msgr_friends where a = pr[1] and b = pr[2] and status = 'blocked' and requested_by = me;
end $$;

create or replace function public.msgr_my_blocked()
  returns table (user_id uuid, handle text, display_name text, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when f.a = auth.uid() then f.b else f.a end, p.handle,
           coalesce(p.display_name, split_part(u.email, '@', 1)), f.decided_at
      from public.msgr_friends f
      join auth.users u on u.id = case when f.a = auth.uid() then f.b else f.a end
      left join public.msgr_profiles p on p.user_id = u.id
     where (f.a = auth.uid() or f.b = auth.uid()) and f.status = 'blocked' and f.requested_by = auth.uid()
     order by f.decided_at desc nulls last
$$;

revoke all on function public.msgr_report_message(bigint, text) from public, anon; grant execute on function public.msgr_report_message(bigint, text) to authenticated;
revoke all on function public.msgr_reports_list() from public, anon; grant execute on function public.msgr_reports_list() to authenticated;
revoke all on function public.msgr_report_resolve(uuid) from public, anon; grant execute on function public.msgr_report_resolve(uuid) to authenticated;
revoke all on function public.msgr_friend_unblock(uuid) from public, anon; grant execute on function public.msgr_friend_unblock(uuid) to authenticated;
revoke all on function public.msgr_my_blocked() from public, anon; grant execute on function public.msgr_my_blocked() to authenticated;
