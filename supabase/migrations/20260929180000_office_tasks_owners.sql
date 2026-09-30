-- 성과 기록 1단계(유건 9/29): 기한이 있는 할 일을 정식으로 저장하고, 거래에 담당자를 둔다.
-- 성과 기록(사람 직원의 일과 성과를 자동으로 쌓는 개인 기록)의 기한 준수율·달성률·담당 거래 매출이 여기서 나온다.
-- 기록은 고치거나 지우지 않는다 — 바뀌는 것은 이력(office_task_events, office_business_owner_history)으로 쌓는다.
-- 사람 id는 auth.users에 외래 키로 묶지 않는다: 계정을 지워도 회사 기록(퇴사 후 3년 보관)이 막히거나 사라지지 않게.
-- 부하: 쓰기는 사람이 누를 때만(할 일 만들기·끝내기, 담당자 바꾸기). 주기 호출·폴링 없음.

-- ── 거래 담당자 ──
alter table public.office_business_orders add column if not exists owners uuid[] not null default '{}';

create table if not exists public.office_business_owner_history (
  id bigint generated always as identity primary key,
  scope text not null,
  order_id uuid not null references public.office_business_orders(id),
  previous uuid[] not null, owners uuid[] not null,
  actor uuid not null, reason text not null check (length(reason) between 1 and 500),
  at timestamptz not null default clock_timestamp()
);
create index if not exists office_business_owner_history_order on public.office_business_owner_history(order_id);
alter table public.office_business_owner_history enable row level security; -- 정책 없음: 함수로만 쓴다
revoke all on public.office_business_owner_history from anon, authenticated;

-- 새 거래의 담당자 = 견적을 남긴 사람(조직 공간만). 큰 쓰기 함수를 다시 만들지 않으려고 첫 기록에 건다.
create or replace function public.office_business_owner_default() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind = 'quote' and new.actor is not null and new.scope like 'o:%' then
    update public.office_business_orders set owners = array[new.actor] where id = new.order_id and owners = '{}';
  end if;
  return null;
end $$;
drop trigger if exists office_business_owner_default on public.office_business_activity;
create trigger office_business_owner_default after insert on public.office_business_activity
  for each row execute function public.office_business_owner_default();

-- 이미 있는 조직 거래: 견적을 남긴 사람으로 채운다(기록이 없거나 이미 담당자가 있으면 그대로)
update public.office_business_orders o set owners = array[a.actor]
from (select distinct on (order_id) order_id, actor from public.office_business_activity
      where kind = 'quote' and actor is not null order by order_id, at, id) a
where o.id = a.order_id and o.scope like 'o:%' and o.owners = '{}'
  and not exists (select 1 from public.office_business_owner_history h where h.order_id = o.id); -- 다시 적용해도 관리자가 비운 담당자를 되살리지 않는다

create or replace function public.office_business_owners_set(p_org uuid, p_order uuid, p_owners uuid[], p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare sc text; ord public.office_business_orders%rowtype; clean uuid[]; bad uuid; why text := btrim(coalesce(p_reason, ''));
begin
  if p_org is null or p_owners is null then raise exception 'business_input'; end if; -- 내 공간 거래는 담당자를 두지 않는다. 모두 비우기는 빈 배열로만
  sc := public.office_business_scope(p_org, true);                -- 관리자만
  if length(why) not between 1 and 500 then raise exception 'business_input'; end if;
  select coalesce(array_agg(u order by i), '{}') into clean
    from (select u, min(i) i from unnest(coalesce(p_owners, '{}')) with ordinality x(u, i) where u is not null group by u) s;
  if cardinality(clean) > 20 then raise exception 'business_input'; end if;
  select u into bad from unnest(clean) u
    where not exists (select 1 from public.msgr_org_members m where m.org_id = p_org and m.user_id = u and m.removed_at is null and m.role <> 'guest') limit 1;
  if bad is not null then raise exception 'business_owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended('office-business-scope:' || sc, 0));
  select * into ord from public.office_business_orders where id = p_order and scope = sc for update;
  if not found then raise exception 'business_not_found'; end if;
  if ord.owners = clean then return jsonb_build_object('id', ord.id, 'owners', to_jsonb(clean)); end if; -- 같은 값은 다시 쓰지 않는다
  update public.office_business_orders set owners = clean where id = ord.id;
  insert into public.office_business_owner_history(scope, order_id, previous, owners, actor, reason)
    values (sc, ord.id, ord.owners, clean, auth.uid(), why);
  return jsonb_build_object('id', ord.id, 'owners', to_jsonb(clean));
end $$;

-- 조직 사람 목록(담당자·배정 고르기용) — 손님은 빼고, 나간 사람도 뺀다
create or replace function public.office_org_people(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.office_business_scope(p_org, false);
  if p_org is null then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role,
      'name', coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), '?')) order by m.role <> 'owner', m.joined_at, m.user_id)
    from public.msgr_org_members m left join public.msgr_profiles p on p.user_id = m.user_id left join auth.users u on u.id = m.user_id
    where m.org_id = p_org and m.removed_at is null and m.role <> 'guest'), '[]'::jsonb);
end $$;

-- ── 할 일 ──
create table if not exists public.office_tasks (
  id uuid primary key,                                            -- 브라우저가 만든 id(두 번 눌려도 한 건)
  scope text not null check (scope ~ '^(u|o):'),
  title text not null check (length(btrim(title)) between 1 and 200),
  note text not null default '' check (length(note) <= 4000),
  due_on date,
  assignee uuid not null, created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  done_at timestamptz, cancelled_at timestamptz,
  source jsonb check (source is null or (jsonb_typeof(source) = 'object' and octet_length(source::text) <= 1000)),
  check (done_at is null or cancelled_at is null)
);
create index if not exists office_tasks_assignee on public.office_tasks(scope, assignee);
create index if not exists office_tasks_creator on public.office_tasks(scope, created_by);
create table if not exists public.office_task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.office_tasks(id),
  kind text not null check (kind in ('create', 'title', 'due', 'assign', 'done', 'reopen', 'cancel')),
  actor uuid not null, at timestamptz not null default clock_timestamp(),
  from_value text, to_value text
);
create index if not exists office_task_events_task on public.office_task_events(task_id);
alter table public.office_tasks enable row level security;       -- 정책 없음: 읽기·쓰기 모두 함수로만
alter table public.office_task_events enable row level security;
revoke all on public.office_tasks, public.office_task_events from anon, authenticated;

create or replace function public.office_task_input(p_value text, p_kind text) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
begin
  if p_value is null or p_value = '' then return null; end if;
  if p_kind = 'date' then -- YYYY-MM-DD만(infinity·today·다른 형식은 화면이 못 읽는다)
    if p_value !~ '^\d{4}-\d{2}-\d{2}$' or p_value::date not between date '2000-01-01' and date '2100-12-31' then raise exception 'task_input'; end if;
    return p_value::date::text;
  end if;
  return p_value::uuid::text;
exception when others then raise exception 'task_input';
end $$;

create or replace function public.office_task_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); sc text; manager boolean := false; t public.office_tasks%rowtype;
  tid uuid; target uuid; due date; ttl text; body text;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'task_input'; end if;
  sc := public.office_business_scope(p_org, false); -- 손님·밖의 사람은 여기서 막힌다
  if p_org is not null then
    manager := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  tid := public.office_task_input(p_data->>'id', 'uuid')::uuid;
  if tid is null then raise exception 'task_input'; end if;

  if p_action = 'task.create' then
    ttl := btrim(coalesce(p_data->>'title', '')); body := coalesce(p_data->>'note', '');
    if length(ttl) not between 1 and 200 or length(body) > 4000 then raise exception 'task_input'; end if;
    due := public.office_task_input(p_data->>'due_on', 'date')::date;
    target := coalesce(public.office_task_input(p_data->>'assignee', 'uuid')::uuid, who);
    if target <> who then
      if not manager then raise exception 'task_forbidden' using errcode = '42501'; end if; -- 남에게 배정은 관리자만
      if not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = target and removed_at is null and role <> 'guest') then raise exception 'task_assignee'; end if;
    end if;
    select * into t from public.office_tasks where id = tid;
    if t.id is null then -- perform가 FOUND를 바꾸므로 행 값으로 판정한다
      perform pg_advisory_xact_lock(hashtextextended('office-task-limit:' || who, 0)); -- 동시 요청이 상한을 넘지 않게
      if (select count(*) from public.office_tasks x where x.scope = sc and x.created_by = who
          and x.created_at > now() - interval '1 year') >= 5000 then raise exception 'task_limit'; end if; -- 사람·범위당 최근 1년에 만든 일(취소도 센다 — 만들고 취소하기로 무한히 쌓지 못하게, 1년 지나면 풀린다)
    end if;
    if t.id is not null then -- 같은 요청이 두 번 온 것만 허용
      if t.scope = sc and t.title = ttl and t.note = body and t.due_on is not distinct from due and t.assignee = target and t.created_by = who then return to_jsonb(t) - 'scope'; end if;
      raise exception 'task_conflict';
    end if;
    insert into public.office_tasks(id, scope, title, note, due_on, assignee, created_by, source)
      values (tid, sc, ttl, body, due, target, who, case when jsonb_typeof(p_data->'source') = 'object' then p_data->'source' end) returning * into t;
    insert into public.office_task_events(task_id, kind, actor, to_value) values (tid, 'create', who, due::text);
    return to_jsonb(t) - 'scope';
  end if;

  select * into t from public.office_tasks where id = tid and scope = sc for update;
  if not found then raise exception 'task_not_found'; end if;
  -- 맡은 사람은 끝내기·다시 열기만. 기한·제목·취소는 만든 사람(내가 만든 내 일 포함)과 관리자만 — 남이 맡긴 일의 기한을 늦춰 준수율을 꾸밀 수 없게
  if not (manager or (p_action in ('task.done', 'task.reopen') and t.assignee = who) or (p_action in ('task.title', 'task.due', 'task.cancel') and t.created_by = who and t.assignee = who)) then -- 관리자가 남에게 다시 맡긴 일은 만든 사람도 못 바꾼다
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if t.cancelled_at is not null then raise exception 'task_cancelled'; end if;
  if p_action in ('task.due', 'task.title') and (select count(*) from public.office_task_events e where e.task_id = tid and e.kind in ('due', 'title')) >= 200 then
    raise exception 'task_limit'; -- 할 일 하나의 기한·제목 이력은 200번까지(끝내기·다시 열기는 막지 않는다)
  end if;

  if p_action = 'task.done' then
    if t.done_at is null then -- 두 번 눌려도 한 번
      update public.office_tasks set done_at = clock_timestamp() where id = tid returning * into t;
      insert into public.office_task_events(task_id, kind, actor) values (tid, 'done', who);
    end if;
  elsif p_action = 'task.reopen' then
    if t.done_at is not null then
      insert into public.office_task_events(task_id, kind, actor, from_value) values (tid, 'reopen', who, t.done_at::text);
      update public.office_tasks set done_at = null where id = tid returning * into t;
    end if;
  elsif t.done_at is not null then
    raise exception 'task_done'; -- 끝낸 일은 기한·제목·담당·취소를 바꾸지 않는다(다시 열어야 한다)
  elsif p_action = 'task.due' then
    due := public.office_task_input(p_data->>'due_on', 'date')::date;
    if t.due_on is distinct from due then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'due', who, t.due_on::text, due::text);
      update public.office_tasks set due_on = due where id = tid returning * into t;
    end if;
  elsif p_action = 'task.title' then
    ttl := btrim(coalesce(p_data->>'title', ''));
    if length(ttl) not between 1 and 200 then raise exception 'task_input'; end if;
    if t.title <> ttl then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'title', who, t.title, ttl);
      update public.office_tasks set title = ttl where id = tid returning * into t;
    end if;
  elsif p_action = 'task.assign' then
    if not manager then raise exception 'task_forbidden' using errcode = '42501'; end if;
    target := public.office_task_input(p_data->>'assignee', 'uuid')::uuid;
    if target is null or not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = target and removed_at is null and role <> 'guest') then raise exception 'task_assignee'; end if;
    if t.assignee <> target then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'assign', who, t.assignee::text, target::text);
      update public.office_tasks set assignee = target where id = tid returning * into t;
    end if;
  elsif p_action = 'task.cancel' then
    insert into public.office_task_events(task_id, kind, actor) values (tid, 'cancel', who);
    update public.office_tasks set cancelled_at = clock_timestamp() where id = tid returning * into t;
  else
    raise exception 'task_input';
  end if;
  return to_jsonb(t) - 'scope';
exception when unique_violation then raise exception 'task_conflict'; -- 같은 id로 동시에 만들면 원시 오류 대신
end $$;

-- 보이는 할 일: 담당자·만든 사람·조직 관리자. 끝낸 일은 최근 30일만(화면용 — 성과 계산은 따로 전부 본다), 취소한 일은 뺀다
create or replace function public.office_task_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text := public.office_business_scope(p_org, false); manager boolean := false;
begin
  if p_org is not null then
    manager := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  return coalesce((select jsonb_agg(to_jsonb(t) - 'scope' order by t.done_at nulls first, t.due_on nulls last, t.created_at)
    from (select * from public.office_tasks t
      where t.scope = sc and t.cancelled_at is null and (t.done_at is null or t.done_at > now() - interval '30 days')
        and (manager or t.assignee = who or t.created_by = who)
      order by t.done_at nulls first, t.due_on nulls last, t.created_at limit 2000) t), '[]'::jsonb); -- ponytail: 화면용 2000건, 넘으면 커서
end $$;

revoke all on function public.office_business_owners_set(uuid, uuid, uuid[], text), public.office_org_people(uuid),
  public.office_task_write(uuid, text, jsonb), public.office_task_list(uuid), public.office_task_input(text, text),
  public.office_business_owner_default() from public, anon;
revoke all on function public.office_task_input(text, text), public.office_business_owner_default() from authenticated; -- 내부용(정의자 함수 안에서만)
revoke all on sequence public.office_task_events_id_seq, public.office_business_owner_history_id_seq from anon, authenticated;
grant execute on function public.office_business_owners_set(uuid, uuid, uuid[], text), public.office_org_people(uuid),
  public.office_task_write(uuid, text, jsonb), public.office_task_list(uuid) to authenticated;
