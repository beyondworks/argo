-- 성과 기록 2단계(유건 9/29): 사람 직원의 일과 성과를 매일 자동으로 쌓는 개인 기록(연봉 협상·월말/연말 평가용).
-- · 숫자는 저장하지 않는다 — 고쳐지지 않는 원본 기록(담당 거래·할 일·결재·문서 버전·크루에게 맡긴 글)에서 그때그때 계산한다.
--   그래서 일간 기록이 주·월·연으로 저절로 모이고, 언제 계산해도 같다.
-- · 본인만 본다. 계산 함수(office_perf_report)는 부른 사람 자신의 기록만 돌려준다.
--   관리자는 본인이 "공유하기"를 누른 시점의 사본(snapshot)만 본다 → 메모 → 본인 답·이의 → 평가 완료(잠금).
-- · 고치기·지우기는 없다. 성과 한 줄은 관리자가 허용한 고치기 요청으로 한 번만 새 줄로 고치고, 원본 줄은 남는다.
-- · 퇴사 후 3년 보관 — office_perf_purge(시험 실행 기본). 자동 실행 예약은 운영 적용 때 대상 건수를 확인·승인받은 뒤 건다.
-- · 부하: 쓰기는 사람이 누를 때만. 읽기는 화면을 열 때 1회. 주기 호출 없음.

create table if not exists public.office_perf_notes (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  day date not null,
  body text not null check (length(btrim(body)) between 1 and 2000),
  goal_id uuid,
  replaces uuid references public.office_perf_notes(id),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists office_perf_notes_user on public.office_perf_notes(org_id, user_id, day);

create table if not exists public.office_perf_goals (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  year integer not null check (year between 2000 and 2100),
  position integer not null check (position between 1 and 3),
  title text not null check (length(btrim(title)) between 1 and 200),
  metric text check (metric in ('contract', 'paid', 'tasks_done', 'on_time')),
  target bigint check (target is null or target > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (org_id, user_id, year, position),
  check ((metric is null and target is null) or (metric is not null and target is not null)),
  check (metric is distinct from 'on_time' or target <= 100)
);
create table if not exists public.office_perf_goal_history (
  id bigint generated always as identity primary key,
  goal_id uuid not null references public.office_perf_goals(id) on delete cascade,
  before jsonb not null, at timestamptz not null default clock_timestamp()
);

create table if not exists public.office_perf_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  period text not null check (period ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$'), -- 'YYYY-MM' 월말, 'YYYY' 연말
  status text not null check (status in ('requested', 'shared', 'done')),
  requested_at timestamptz, requested_by uuid,
  shared_at timestamptz, snapshot jsonb check (snapshot is null or octet_length(snapshot::text) <= 2000000),
  done_at timestamptz, done_by uuid,
  unique (org_id, user_id, period)
);
create table if not exists public.office_perf_comments (
  id bigint generated always as identity primary key,
  review_id uuid not null references public.office_perf_reviews(id) on delete cascade,
  author uuid not null,
  kind text not null check (kind in ('memo', 'reply', 'objection')),
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists office_perf_comments_review on public.office_perf_comments(review_id);

create table if not exists public.office_perf_edit_requests (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  note_id uuid not null references public.office_perf_notes(id) on delete cascade,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'used')),
  created_at timestamptz not null default clock_timestamp(),
  decided_by uuid, decided_at timestamptz, used_at timestamptz
);
create unique index if not exists office_perf_edit_requests_open on public.office_perf_edit_requests(note_id) where status in ('pending', 'approved');

alter table public.office_perf_notes enable row level security; -- 정책 없음: 모두 함수로만
alter table public.office_perf_goals enable row level security;
alter table public.office_perf_goal_history enable row level security;
alter table public.office_perf_reviews enable row level security;
alter table public.office_perf_comments enable row level security;
alter table public.office_perf_edit_requests enable row level security;
revoke all on public.office_perf_notes, public.office_perf_goals, public.office_perf_goal_history, public.office_perf_reviews,
  public.office_perf_comments, public.office_perf_edit_requests from anon, authenticated;

-- 조직 역할: null(구성원 아님·손님·나간 사람) | 'member' | 'manager'
create or replace function public.office_perf_role(p_org uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when m.role in ('owner', 'admin') then 'manager' else 'member' end
  from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
  where m.org_id = p_org and m.user_id = auth.uid() and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null;
$$;

-- 그 날이 평가 완료로 잠긴 기간(월 또는 연)에 속하는지 — 잠긴 기간의 성과 한 줄은 추가·고치기 모두 막는다(분리 검수 MEDIUM)
create or replace function public.office_perf_locked(p_org uuid, p_user uuid, p_day date) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.office_perf_reviews where org_id = p_org and user_id = p_user and status = 'done'
    and period in (to_char(p_day, 'YYYY-MM'), to_char(p_day, 'YYYY')));
$$;

create or replace function public.office_perf_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Seoul')::date $$;

-- 기간 → [시작, 끝] (한국 날짜)
create or replace function public.office_perf_bounds(p_period text, out lo date, out hi date)
language plpgsql immutable as $$
begin
  if p_period !~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$' then raise exception 'perf_period'; end if;
  if length(p_period) = 4 then lo := make_date(p_period::int, 1, 1); hi := make_date(p_period::int, 12, 31);
  else lo := (p_period || '-01')::date; hi := (lo + interval '1 month' - interval '1 day')::date; end if;
end $$;

-- ── 3단계: 거래처 메일 만족도 ──
-- 메일 서버 함수(api/mail signals)가 Gmail 메타데이터(보낸 사람·시각·앞부분 요약)로 스레드마다 근거 종류를 뽑아 넣는다.
-- 본문·제목은 저장하지 않는다. 판정(좋음/보통/주의)은 DB가 근거 종류로 다시 정한다. 부하: 사람마다 6시간에 한 번까지(claim), 값이 같으면 다시 쓰지 않는다.
create table if not exists public.office_perf_mail (
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  thread_id text not null check (length(thread_id) between 1 and 200),
  account uuid not null,
  customer_id uuid not null,
  day date not null,
  grade text not null check (grade in ('good', 'normal', 'caution')),
  reasons text[] not null,
  reply_minutes integer check (reply_minutes is null or reply_minutes >= 0),
  last_message_id text not null check (length(last_message_id) between 1 and 200),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, user_id, thread_id)
);
create index if not exists office_perf_mail_day on public.office_perf_mail(org_id, user_id, day);
create table if not exists public.office_perf_mail_sync (
  org_id uuid not null references public.msgr_orgs(id) on delete cascade, user_id uuid not null,
  synced_at timestamptz not null, primary key (org_id, user_id)
);
alter table public.office_perf_mail enable row level security;
alter table public.office_perf_mail_sync enable row level security;
revoke all on public.office_perf_mail, public.office_perf_mail_sync from anon, authenticated;

-- 문서 실적: 사람·날짜·문서당 한 줄. office_page_versions는 90일 뒤 office_purge가 지우므로 성과 기록은 버전 표를 직접 세지 않는다
-- (연간 정리가 90일 뒤 비는 결함, 9/30). 버전이 들어올 때 트리거가 한 줄을 넣고, 같은 날 다시 고치면 제목이 바뀐 경우만 고친다.
create table if not exists public.office_perf_page_days (
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid not null,
  day date not null,
  page_id uuid not null,                                  -- 문서가 지워져도 실적은 남는다(참조 없음)
  title text not null default '' check (length(title) <= 500),
  primary key (org_id, user_id, day, page_id)
);
alter table public.office_perf_page_days enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_perf_page_days from anon, authenticated;

create or replace function public.office_perf_page_day() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.created_by is null then return new; end if;
  insert into public.office_perf_page_days(org_id, user_id, day, page_id, title)
    select p.org_id, new.created_by, (new.created_at at time zone 'Asia/Seoul')::date, new.page_id, left(coalesce(nullif(new.title, ''), p.title), 500)
    from public.office_pages p where p.id = new.page_id and p.org_id is not null
    on conflict (org_id, user_id, day, page_id) do update set title = excluded.title
      where public.office_perf_page_days.title is distinct from excluded.title;
  return new;
end $$;
revoke all on function public.office_perf_page_day() from public, anon, authenticated;
drop trigger if exists office_perf_page_day on public.office_page_versions;
create trigger office_perf_page_day after insert on public.office_page_versions for each row execute function public.office_perf_page_day();
-- 이미 있는 버전을 한 번 옮긴다(여러 번 적용해도 같은 결과)
insert into public.office_perf_page_days(org_id, user_id, day, page_id, title)
  select distinct on (p.org_id, v.created_by, (v.created_at at time zone 'Asia/Seoul')::date, v.page_id)
    p.org_id, v.created_by, (v.created_at at time zone 'Asia/Seoul')::date, v.page_id, left(coalesce(nullif(v.title, ''), p.title), 500)
  from public.office_page_versions v join public.office_pages p on p.id = v.page_id
  where p.org_id is not null and v.created_by is not null
  order by p.org_id, v.created_by, (v.created_at at time zone 'Asia/Seoul')::date, v.page_id, v.version desc
  on conflict do nothing;

create or replace function public.office_perf_mail_grade(p_reasons text[]) returns text
language sql immutable as $$
  select case when p_reasons && array['pushy', 'late_reply'] then 'caution' when p_reasons && array['thanks', 'quick_reply'] then 'good' else 'normal' end
$$;

-- 우리 조직 거래처(이메일 있는 곳만) — 메일 서버 함수가 검색어를 만들 때
create or replace function public.office_perf_customers(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email) order by c.name)
    from public.office_business_customers c where c.scope = 'o:' || p_org and coalesce(c.email, '') like '%@%'), '[]'::jsonb);
end $$;

-- Gmail을 못 읽었으면 제한을 되돌려 다음에 다시 계산한다(되돌리면 2분 쓰기 창도 닫힌다)
create or replace function public.office_perf_mail_release(p_org uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  update public.office_perf_mail_sync set synced_at = now() - interval '6 hours' where org_id = p_org and user_id = auth.uid() and synced_at > now() - interval '10 minutes';
end $$;

-- 6시간에 한 번만 계산한다 — 부르는 쪽이 true를 받았을 때만 Gmail을 읽는다
create or replace function public.office_perf_mail_claim(p_org uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare got boolean;
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  insert into public.office_perf_mail_sync(org_id, user_id, synced_at) values (p_org, auth.uid(), clock_timestamp())
    on conflict (org_id, user_id) do update set synced_at = excluded.synced_at where office_perf_mail_sync.synced_at < now() - interval '6 hours'
    returning true into got;
  return coalesce(got, false);
end $$;

create or replace function public.office_perf_mail_put(p_org uuid, p_account uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); el jsonb; d date; rs text[]; cid uuid; tid text; mid text; mins integer; n integer := 0; today date := public.office_perf_today(); k integer;
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.office_mail_accounts where id = p_account and user_id = who) then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  -- 6시간 제한을 막 통과한 직후(2분 안)에만 — 아무 때나 직접 불러 판정을 꾸며 넣지 못하게(완전한 차단은 서버 전용 키가 필요한 알려진 한계)
  if not exists (select 1 from public.office_perf_mail_sync where org_id = p_org and user_id = who and synced_at > now() - interval '2 minutes') then raise exception 'perf_claim'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 200 then raise exception 'perf_input'; end if;
  for el in select * from jsonb_array_elements(p_rows) loop
    begin
      tid := el->>'thread_id'; mid := el->>'last_message_id'; cid := (el->>'customer_id')::uuid; d := (el->>'day')::date;
      mins := nullif(el->>'reply_minutes', '')::integer;
      select coalesce(array_agg(distinct r order by r), '{}') into rs from jsonb_array_elements_text(el->'reasons') r;
    exception when others then raise exception 'perf_input'; end;
    select count(*) into k from unnest(rs) r where r not in ('thanks', 'pushy', 'replied', 'no_reply', 'quick_reply', 'late_reply');
    if k > 0 or length(coalesce(tid, '')) not between 1 and 200 or length(coalesce(mid, '')) not between 1 and 200 or d is null or d > today or d < today - 60 or mins < 0
      or not exists (select 1 from public.office_business_customers where id = cid and scope = 'o:' || p_org) then raise exception 'perf_input'; end if;
    if public.office_perf_locked(p_org, who, d) or exists (select 1 from public.office_perf_mail x where x.org_id = p_org and x.user_id = who and x.thread_id = tid and public.office_perf_locked(p_org, who, x.day)) then continue; end if;
    insert into public.office_perf_mail as x (org_id, user_id, thread_id, account, customer_id, day, grade, reasons, reply_minutes, last_message_id)
      values (p_org, who, tid, p_account, cid, d, public.office_perf_mail_grade(rs), rs, mins, mid)
      on conflict (org_id, user_id, thread_id) do update set account = excluded.account, customer_id = excluded.customer_id, day = excluded.day, grade = excluded.grade,
        reasons = excluded.reasons, reply_minutes = excluded.reply_minutes, last_message_id = excluded.last_message_id, updated_at = clock_timestamp()
      where (x.account, x.customer_id, x.day, x.reasons, x.reply_minutes, x.last_message_id) is distinct from
            (excluded.account, excluded.customer_id, excluded.day, excluded.reasons, excluded.reply_minutes, excluded.last_message_id);
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- 한 사람의 기간 기록(원본에서 계산). 권한 확인은 부르는 쪽이 한다 — authenticated에 열지 않는다.
create or replace function public.office_perf_compute(p_org uuid, p_user uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  sc text := 'o:' || p_org;
  lo timestamptz := p_from::timestamp at time zone 'Asia/Seoul';
  hi timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Seoul';
  deals jsonb; tasks jsonb; approvals jsonb; pages jsonb; crew jsonb; notes jsonb; mail jsonb; reqs jsonb; t jsonb;
begin
  -- 담당 거래: 계약(+공급가액)·계약 되돌림/계약 뒤 취소(−)·청구(−감액)·입금(−환불). 공동 담당은 각자 전액 + 인원 표시
  with mine as (
    select o.id, o.title, cardinality(o.owners) co,
      (select coalesce(sum(l.quantity * l.unit_price), 0) from public.office_business_lines l where l.order_id = o.id) supply
    from public.office_business_orders o where o.scope = sc and p_user = any(o.owners)
  ), acts as (
    select a.order_id, a.kind, a.at,
      coalesce(sum(case a.kind when 'contract' then 1 when 'reopen' then -1 when 'cancel' then -1 else 0 end)
        over (partition by a.order_id order by a.at, a.kind rows between unbounded preceding and 1 preceding), 0) live_before
    from public.office_business_activity a join mine m on m.id = a.order_id where a.kind in ('contract', 'reopen', 'cancel')
  ), ev as (
    select a.order_id, a.at, case when a.kind = 'contract' then 'contract' else 'uncontract' end kind,
      case when a.kind = 'contract' then m.supply else -m.supply end amount
    from acts a join mine m on m.id = a.order_id
    where a.at >= lo and a.at < hi and (a.kind = 'contract' or a.live_before > 0)
    union all
    select e.order_id, e.at, e.kind, case when e.kind in ('credit', 'refund') then -e.amount else e.amount end
    from public.office_business_entries e join mine m on m.id = e.order_id where e.at >= lo and e.at < hi
  )
  select coalesce(jsonb_agg(jsonb_build_object('day', (ev.at at time zone 'Asia/Seoul')::date, 'order_id', ev.order_id, 'title', m.title,
      'kind', ev.kind, 'amount', ev.amount, 'co', m.co) order by ev.at), '[]') into deals
  from ev join mine m on m.id = ev.order_id;

  -- 할 일: 그 기간에 끝낸 일 + 그 기간이 기한인 일(취소 제외). 기한 준수 = 한국 날짜로 끝낸 날 ≤ 기한
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'due_on', x.due_on,
      'day', (x.done_at at time zone 'Asia/Seoul')::date, 'done', x.done_at is not null,
      'on_time', x.done_at is not null and x.due_on is not null and (x.done_at at time zone 'Asia/Seoul')::date <= x.due_on) order by x.done_at nulls last, x.due_on), '[]')
    into tasks
  from public.office_tasks x
  where x.scope = sc and x.assignee = p_user and x.cancelled_at is null
    and ((x.done_at >= lo and x.done_at < hi) or x.due_on between p_from and p_to);

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]') into approvals from (
    select (a.decided_at at time zone 'Asia/Seoul')::date d, count(*) n from public.msgr_crew_approvals a
    where a.org_id = p_org and a.decided_by = p_user and a.status in ('approved', 'rejected') and a.decided_at >= lo and a.decided_at < hi group by 1) s;

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'page_id', page_id, 'title', title) order by d, title), '[]') into pages from (
    select x.day d, x.page_id, x.title from public.office_perf_page_days x
    where x.org_id = p_org and x.user_id = p_user and x.day between p_from and p_to) s;

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]') into crew from (
    select (m.created_at at time zone 'Asia/Seoul')::date d, count(*) n from public.msgr_messages m
    where m.org_id = p_org and m.author_user_id = p_user and m.deleted_at is null and m.meta->>'source' like 'office%'
      and m.created_at >= lo and m.created_at < hi group by 1) s;

  -- 성과 한 줄: 고친 줄이 있으면 고친 것만, 원본 내용은 original로 같이
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'day', n.day, 'body', n.body, 'goal_id', n.goal_id, 'created_at', n.created_at,
      'edited', n.replaces is not null, 'original', o.body) order by n.day, n.created_at), '[]') into notes
  from public.office_perf_notes n left join public.office_perf_notes o on o.id = n.replaces
  where n.org_id = p_org and n.user_id = p_user and n.day between p_from and p_to
    and not exists (select 1 from public.office_perf_notes r where r.replaces = n.id);

  -- 거래처 메일(판정·근거 종류·메일 id만)
  select coalesce(jsonb_agg(jsonb_build_object('thread_id', x.thread_id, 'day', x.day, 'grade', x.grade, 'reasons', to_jsonb(x.reasons), 'reply_minutes', x.reply_minutes,
      'message_id', x.last_message_id, 'account', x.account, 'customer_id', x.customer_id, 'customer', c.name) order by x.day, x.thread_id), '[]') into mail
  from public.office_perf_mail x left join public.office_business_customers c on c.id = x.customer_id
  where x.org_id = p_org and x.user_id = p_user and x.day between p_from and p_to;

  -- 메신저 요청: 나를 멘션한 글 + 1:1 대화에서 상대가 새로 말을 건 글(같은 사람의 10분 안 연속 글은 하나로). 답 = 그 채널의 내 다음 글
  with req as (
    select m.id, m.channel_id, m.created_at from public.msgr_messages m join public.msgr_channels c on c.id = m.channel_id
    where m.org_id = p_org and m.author_kind = 'user' and m.author_user_id is distinct from p_user and m.deleted_at is null and m.created_at >= lo and m.created_at < hi
      and p_user = auth.uid() and public.msgr_can_read_channel(m.channel_id) -- 내가 실제로 읽을 수 있는 채널만(분리 검수 HIGH: 비공개 채널 멘션의 id·날짜가 새던 문제)
      and (m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', p_user::text))
        or (c.kind = 'dm' and exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = p_user)
          and not exists (select 1 from public.msgr_messages p where p.channel_id = m.channel_id and p.author_user_id = m.author_user_id and p.deleted_at is null
            and p.created_at < m.created_at and p.created_at > m.created_at - interval '10 minutes')))
  ), ans as (
    select r.*, (select min(x.created_at) from public.msgr_messages x where x.channel_id = r.channel_id and x.author_kind = 'user' and x.author_user_id = p_user
      and x.deleted_at is null and x.created_at > r.created_at) replied_at from req r
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'day', (a.created_at at time zone 'Asia/Seoul')::date,
      'minutes', case when a.replied_at is not null then round(extract(epoch from a.replied_at - a.created_at) / 60)::int end,
      'unanswered', a.replied_at is null and a.created_at < now() - interval '24 hours',
      'done', exists (select 1 from public.office_tasks t where t.scope = sc and t.assignee = p_user and t.source->>'kind' = 'msgr' and t.source->>'message_id' = a.id::text and t.done_at is not null))
      order by a.created_at), '[]') into reqs from ans a;

  select jsonb_build_object(
    'mail_threads', jsonb_array_length(mail),
    'mail_good', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'good'),
    'mail_normal', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'normal'),
    'mail_caution', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'caution'),
    'req_count', jsonb_array_length(reqs),
    'req_answered', (select count(*) from jsonb_array_elements(reqs) e where e->>'minutes' is not null),
    'req_unanswered', (select count(*) from jsonb_array_elements(reqs) e where (e->>'unanswered')::boolean),
    'req_done', (select count(*) from jsonb_array_elements(reqs) e where (e->>'done')::boolean),
    'req_minutes', (select round(avg((e->>'minutes')::int))::int from jsonb_array_elements(reqs) e where e->>'minutes' is not null),
    'contract', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('contract', 'uncontract')), 0),
    'invoiced', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('invoice', 'credit')), 0),
    'paid', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('payment', 'refund')), 0),
    'deals', (select count(distinct e->>'order_id') from jsonb_array_elements(deals) e),
    'tasks_done', (select count(*) from jsonb_array_elements(tasks) e where (e->>'done')::boolean and (e->>'day')::date between p_from and p_to),
    -- 기한인 일 = 그 기간이 기한이고, 이미 끝냈거나 기한이 지난 일(기한이 아직 안 지난 미완료 일은 실패가 아니다)
    'tasks_due', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and ((e->>'done')::boolean or (e->>'due_on')::date < public.office_perf_today())),
    'tasks_done_due', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and (e->>'done')::boolean),
    'tasks_on_time', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and (e->>'on_time')::boolean),
    'approvals', coalesce((select sum((e->>'n')::int) from jsonb_array_elements(approvals) e), 0),
    'pages', (select count(distinct e->>'page_id') from jsonb_array_elements(pages) e),
    'crew', coalesce((select sum((e->>'n')::int) from jsonb_array_elements(crew) e), 0),
    'notes', jsonb_array_length(notes)) into t;

  return jsonb_build_object('from', p_from, 'to', p_to, 'totals', t, 'deals', deals, 'tasks', tasks, 'approvals', approvals, 'pages', pages, 'crew', crew, 'notes', notes, 'mail', mail, 'asks', reqs); -- asks: 메신저 요청('requests'는 본인 기록의 고치기 요청 목록이 쓴다)
end $$;

-- 목표와 진행률(그해 전체)
create or replace function public.office_perf_goals_of(p_org uuid, p_user uuid, p_year integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare y jsonb; lo date := make_date(p_year, 1, 1); hi date := make_date(p_year, 12, 31);
begin
  if not exists (select 1 from public.office_perf_goals where org_id = p_org and user_id = p_user and year = p_year) then return '[]'::jsonb; end if;
  y := public.office_perf_compute(p_org, p_user, lo, hi) -> 'totals';
  return coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'year', g.year, 'position', g.position, 'title', g.title, 'metric', g.metric, 'target', g.target,
      'value', case g.metric when 'contract' then (y->>'contract')::bigint when 'paid' then (y->>'paid')::bigint when 'tasks_done' then (y->>'tasks_done')::bigint
        when 'on_time' then case when (y->>'tasks_due')::int > 0 then round((y->>'tasks_on_time')::numeric * 100 / (y->>'tasks_due')::int) end end,
      'notes', (select count(*) from public.office_perf_notes n where n.goal_id = g.id and not exists (select 1 from public.office_perf_notes r where r.replaces = n.id)))
      order by g.position)
    from public.office_perf_goals g where g.org_id = p_org and g.user_id = p_user and g.year = p_year), '[]'::jsonb);
end $$;

create or replace function public.office_perf_review_json(r public.office_perf_reviews, p_snapshot boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', r.id, 'user_id', r.user_id, 'period', r.period, 'status', r.status, 'requested_at', r.requested_at,
    'shared_at', r.shared_at, 'done_at', r.done_at)
    || case when p_snapshot then jsonb_build_object('snapshot', r.snapshot) else '{}'::jsonb end
    || jsonb_build_object('comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'body', c.body, 'author', c.author, 'created_at', c.created_at) order by c.id)
        from public.office_perf_comments c where c.review_id = r.id), '[]'::jsonb));
$$;

-- 본인 기록 — 부른 사람 자신의 것만. 기간 최대 1년
create or replace function public.office_perf_report(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); y integer := extract(year from p_to);
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'perf_input'; end if;
  return public.office_perf_compute(p_org, who, p_from, p_to)
    || jsonb_build_object('goals', public.office_perf_goals_of(p_org, who, y),
      'reviews', coalesce((select jsonb_agg(public.office_perf_review_json(r, false) order by r.period) from public.office_perf_reviews r
        where r.org_id = p_org and r.user_id = who and r.period like y || '%'), '[]'::jsonb),
      'requests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'note_id', q.note_id, 'status', q.status, 'reason', q.reason) order by q.created_at)
        from public.office_perf_edit_requests q where q.org_id = p_org and q.user_id = who and q.status in ('pending', 'approved', 'rejected')
          and q.created_at > now() - interval '60 days'), '[]'::jsonb));
end $$;

-- 본인 쓰기: 성과 한 줄·고치기 요청·목표·공유·답·이의
create or replace function public.office_perf_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); today date := public.office_perf_today(); nid uuid; d date; txt text; g public.office_perf_goals%rowtype;
  q public.office_perf_edit_requests%rowtype; orig public.office_perf_notes%rowtype; r public.office_perf_reviews%rowtype;
  b record; per text; yr integer; pos integer; met text; tgt bigint;
begin
  if p_org is null or public.office_perf_role(p_org) is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'perf_input'; end if;
  perform pg_advisory_xact_lock(hashtextextended('office-perf:' || p_org || ':' || who, 0));

  if p_action = 'note.add' then
    nid := public.office_task_input(p_data->>'id', 'uuid')::uuid;
    d := coalesce(public.office_task_input(p_data->>'day', 'date')::date, today);
    txt := btrim(coalesce(p_data->>'body', ''));
    if nid is null or length(txt) not between 1 and 2000 or d > today or d < today - 366 then raise exception 'perf_input'; end if;
    if public.office_perf_locked(p_org, who, d) then raise exception 'perf_locked'; end if;
    if p_data->>'goal_id' is not null and not exists (select 1 from public.office_perf_goals where id = (p_data->>'goal_id')::uuid and org_id = p_org and user_id = who) then raise exception 'perf_input'; end if;
    if exists (select 1 from public.office_perf_notes where id = nid) then
      if exists (select 1 from public.office_perf_notes where id = nid and org_id = p_org and user_id = who and body = txt and day = d) then return jsonb_build_object('id', nid); end if;
      raise exception 'perf_conflict';
    end if;
    insert into public.office_perf_notes(id, org_id, user_id, day, body, goal_id) values (nid, p_org, who, d, txt, nullif(p_data->>'goal_id', '')::uuid);
    return jsonb_build_object('id', nid);

  elsif p_action = 'edit.request' then
    nid := public.office_task_input(p_data->>'id', 'uuid')::uuid; txt := btrim(coalesce(p_data->>'reason', ''));
    select * into orig from public.office_perf_notes where id = public.office_task_input(p_data->>'note_id', 'uuid')::uuid and org_id = p_org and user_id = who;
    if not found or nid is null or length(txt) not between 1 and 500 then raise exception 'perf_input'; end if;
    if public.office_perf_locked(p_org, who, orig.day) then raise exception 'perf_locked'; end if;
    if exists (select 1 from public.office_perf_notes where replaces = orig.id) then raise exception 'perf_input'; end if; -- 고친 줄은 다시 고치지 않는다(고친 줄에 요청)
    insert into public.office_perf_edit_requests(id, org_id, user_id, note_id, reason) values (nid, p_org, who, orig.id, txt);
    return jsonb_build_object('id', nid);

  elsif p_action = 'note.edit' then
    select * into q from public.office_perf_edit_requests where id = public.office_task_input(p_data->>'request_id', 'uuid')::uuid and org_id = p_org and user_id = who for update;
    if not found or q.status <> 'approved' then raise exception 'perf_request'; end if;
    nid := public.office_task_input(p_data->>'id', 'uuid')::uuid; txt := btrim(coalesce(p_data->>'body', ''));
    if nid is null or length(txt) not between 1 and 2000 then raise exception 'perf_input'; end if;
    select * into orig from public.office_perf_notes where id = q.note_id;
    if public.office_perf_locked(p_org, who, orig.day) then raise exception 'perf_locked'; end if;
    insert into public.office_perf_notes(id, org_id, user_id, day, body, goal_id, replaces) values (nid, p_org, who, orig.day, txt, orig.goal_id, orig.id);
    update public.office_perf_edit_requests set status = 'used', used_at = clock_timestamp() where id = q.id;
    return jsonb_build_object('id', nid);

  elsif p_action = 'goal.save' then
    nid := public.office_task_input(p_data->>'id', 'uuid')::uuid; txt := btrim(coalesce(p_data->>'title', ''));
    begin
      yr := (p_data->>'year')::int; pos := (p_data->>'position')::int; met := nullif(p_data->>'metric', ''); tgt := nullif(p_data->>'target', '')::bigint;
    exception when others then raise exception 'perf_input'; end;
    if nid is null or yr not between extract(year from today)::int - 1 and extract(year from today)::int + 1 or pos not between 1 and 3 or length(txt) not between 1 and 200
      or (met is null) <> (tgt is null) or (met is not null and met not in ('contract', 'paid', 'tasks_done', 'on_time')) or tgt <= 0 or (met = 'on_time' and tgt > 100) then raise exception 'perf_input'; end if;
    select * into g from public.office_perf_goals where org_id = p_org and user_id = who and year = yr and position = pos for update;
    if found then
      if g.title = txt and g.metric is not distinct from met and g.target is not distinct from tgt then return jsonb_build_object('id', g.id); end if;
      insert into public.office_perf_goal_history(goal_id, before) values (g.id, to_jsonb(g));
      update public.office_perf_goals set title = txt, metric = met, target = tgt, updated_at = clock_timestamp() where id = g.id;
      return jsonb_build_object('id', g.id);
    end if;
    insert into public.office_perf_goals(id, org_id, user_id, year, position, title, metric, target) values (nid, p_org, who, yr, pos, txt, met, tgt);
    return jsonb_build_object('id', nid);

  elsif p_action = 'review.share' then
    per := coalesce(p_data->>'period', '');
    select * into b from public.office_perf_bounds(per);
    if (length(per) = 7 and b.hi >= today) or (length(per) = 4 and today < make_date(per::int, 12, 1)) then raise exception 'perf_period'; end if; -- 월은 끝난 뒤, 연은 12월부터
    select * into r from public.office_perf_reviews where org_id = p_org and user_id = who and period = per for update;
    if found and r.status = 'done' then raise exception 'perf_locked'; end if;
    if found and r.status = 'shared' then raise exception 'perf_shared'; end if;
    insert into public.office_perf_reviews(org_id, user_id, period, status, shared_at, snapshot)
      values (p_org, who, per, 'shared', clock_timestamp(),
        public.office_perf_compute(p_org, who, b.lo, least(b.hi, today)) || jsonb_build_object('goals', public.office_perf_goals_of(p_org, who, extract(year from b.lo)::int)))
      on conflict (org_id, user_id, period) do update set status = 'shared', shared_at = excluded.shared_at, snapshot = excluded.snapshot
      returning * into r;
    return jsonb_build_object('id', r.id);

  elsif p_action = 'comment.add' then
    select * into r from public.office_perf_reviews where org_id = p_org and user_id = who and period = coalesce(p_data->>'period', '') for update;
    if not found or r.status = 'requested' then raise exception 'perf_review'; end if;
    if r.status = 'done' then raise exception 'perf_locked'; end if;
    txt := btrim(coalesce(p_data->>'body', ''));
    if p_data->>'kind' not in ('reply', 'objection') or length(txt) not between 1 and 4000 then raise exception 'perf_input'; end if;
    insert into public.office_perf_comments(review_id, author, kind, body) values (r.id, who, p_data->>'kind', txt);
    return jsonb_build_object('id', r.id);
  end if;
  raise exception 'perf_input';
end $$;

-- 관리자: 공유 요청·메모·평가 완료·고치기 요청 허용/거절
create or replace function public.office_perf_manage(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); r public.office_perf_reviews%rowtype; q public.office_perf_edit_requests%rowtype; target uuid; per text; txt text; b record;
begin
  if p_org is null or public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'perf_input'; end if;

  if p_action = 'review.request' then
    target := public.office_task_input(p_data->>'user_id', 'uuid')::uuid; per := coalesce(p_data->>'period', '');
    select * into b from public.office_perf_bounds(per);
    if target is null or not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = target and removed_at is null and role <> 'guest') then raise exception 'perf_input'; end if;
    insert into public.office_perf_reviews(org_id, user_id, period, status, requested_at, requested_by)
      values (p_org, target, per, 'requested', clock_timestamp(), who)
      on conflict (org_id, user_id, period) do nothing; -- 이미 공유·완료면 그대로
    return jsonb_build_object('ok', true);
  elsif p_action in ('comment.add', 'review.done') then
    select * into r from public.office_perf_reviews where id = public.office_task_input(p_data->>'review_id', 'uuid')::uuid and org_id = p_org for update;
    if not found or r.status = 'requested' then raise exception 'perf_review'; end if;
    if r.status = 'done' then raise exception 'perf_locked'; end if;
    if p_action = 'comment.add' then
      txt := btrim(coalesce(p_data->>'body', ''));
      if length(txt) not between 1 and 4000 then raise exception 'perf_input'; end if;
      insert into public.office_perf_comments(review_id, author, kind, body) values (r.id, who, 'memo', txt);
    else
      update public.office_perf_reviews set status = 'done', done_at = clock_timestamp(), done_by = who where id = r.id;
    end if;
    return jsonb_build_object('id', r.id);
  elsif p_action = 'edit.decide' then
    select * into q from public.office_perf_edit_requests where id = public.office_task_input(p_data->>'id', 'uuid')::uuid and org_id = p_org for update;
    if not found or q.status <> 'pending' then raise exception 'perf_request'; end if;
    if public.office_perf_locked(p_org, q.user_id, (select day from public.office_perf_notes where id = q.note_id)) then raise exception 'perf_locked'; end if;
    update public.office_perf_edit_requests set status = case when (p_data->>'approve')::boolean then 'approved' else 'rejected' end,
      decided_by = who, decided_at = clock_timestamp() where id = q.id;
    return jsonb_build_object('id', q.id);
  end if;
  raise exception 'perf_input';
end $$;

-- 관리자 화면: 구성원별 그 기간 평가 상태, 공유된 평가(사본·메모), 기다리는 고치기 요청(그 한 줄과 사유만)
create or replace function public.office_perf_team(p_org uuid, p_period text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_org is null or public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  perform public.office_perf_bounds(p_period);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'name', coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), '?'), 'role', m.role,
        'review', (select jsonb_build_object('status', r.status, 'requested_at', r.requested_at, 'shared_at', r.shared_at, 'done_at', r.done_at) from public.office_perf_reviews r
          where r.org_id = p_org and r.user_id = m.user_id and r.period = p_period)) order by m.joined_at, m.user_id)
      from public.msgr_org_members m left join public.msgr_profiles p on p.user_id = m.user_id left join auth.users u on u.id = m.user_id
      where m.org_id = p_org and m.removed_at is null and m.role <> 'guest'), '[]'::jsonb),
    'reviews', coalesce((select jsonb_agg(public.office_perf_review_json(r, true) order by r.shared_at) from public.office_perf_reviews r
      where r.org_id = p_org and r.period = p_period and r.status in ('shared', 'done')), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'user_id', q.user_id, 'day', n.day, 'body', n.body, 'reason', q.reason, 'created_at', q.created_at) order by q.created_at)
      from public.office_perf_edit_requests q join public.office_perf_notes n on n.id = q.note_id where q.org_id = p_org and q.status = 'pending'), '[]'::jsonb));
end $$;

-- 퇴사 후 3년이 지난 사람의 성과 기록 정리. p_dry(기본)이면 세기만 한다. 사용자에게 열지 않는다(운영자·예약 작업 전용).
create or replace function public.office_perf_purge(p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_notes bigint; n_goals bigint; n_reviews bigint; n_requests bigint; n_pages bigint;
begin
  create temp table if not exists perf_gone on commit drop as
    select m.org_id, m.user_id from public.msgr_org_members m where m.removed_at < now() - interval '3 years';
  select count(*) into n_notes from public.office_perf_notes x join perf_gone g using (org_id, user_id);
  select count(*) into n_goals from public.office_perf_goals x join perf_gone g using (org_id, user_id);
  select count(*) into n_reviews from public.office_perf_reviews x join perf_gone g using (org_id, user_id);
  select count(*) into n_requests from public.office_perf_edit_requests x join perf_gone g using (org_id, user_id);
  select count(*) into n_pages from public.office_perf_page_days x join perf_gone g using (org_id, user_id);
  if not p_dry then
    delete from public.office_perf_edit_requests x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_mail x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_page_days x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_mail_sync x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_reviews x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_goals x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    update public.office_perf_notes x set replaces = null from perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
    delete from public.office_perf_notes x using perf_gone g where x.org_id = g.org_id and x.user_id = g.user_id;
  end if;
  drop table perf_gone;
  return jsonb_build_object('dry', p_dry, 'notes', n_notes, 'goals', n_goals, 'reviews', n_reviews, 'requests', n_requests, 'pages', n_pages);
end $$;

revoke all on function public.office_perf_role(uuid), public.office_perf_bounds(text), public.office_perf_locked(uuid, uuid, date), public.office_perf_compute(uuid, uuid, date, date),
  public.office_perf_goals_of(uuid, uuid, integer), public.office_perf_review_json(public.office_perf_reviews, boolean),
  public.office_perf_report(uuid, date, date), public.office_perf_write(uuid, text, jsonb), public.office_perf_manage(uuid, text, jsonb),
  public.office_perf_team(uuid, text), public.office_perf_purge(boolean), public.office_perf_mail_grade(text[]),
  public.office_perf_customers(uuid), public.office_perf_mail_claim(uuid), public.office_perf_mail_release(uuid), public.office_perf_mail_put(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.office_perf_report(uuid, date, date), public.office_perf_write(uuid, text, jsonb),
  public.office_perf_manage(uuid, text, jsonb), public.office_perf_team(uuid, text),
  public.office_perf_customers(uuid), public.office_perf_mail_claim(uuid), public.office_perf_mail_release(uuid), public.office_perf_mail_put(uuid, uuid, jsonb) to authenticated;
