-- 할 일 속성(유건 10/4 확정 — 오피스 14차 트랙 T, PARITY-ALL 10-1절 2번): 상태·중요도·분류·시작일, 메모 고치기, 바뀐 기록 보기.
-- · 상태 status: 'todo' 할 일 / 'doing' 진행 중 / 'hold' 보류(기본 'todo'). '끝냄'은 기존 done_at, '취소'는 기존 cancelled_at 그대로다.
--   성과 기록(office_perf_compute)은 done_at·due_on·cancelled_at만 본다 — 상태가 진행 중·보류여도 성과 계산은 바뀌지 않는다('끝냄'만 센다).
-- · 중요도 priority: 1 높음 / 2 보통 / 3 낮음(기본 2). 분류 category_id: 공간(scope)마다의 분류 표, 없으면 미분류. 시작일 starts_on: 기한보다 늦을 수 없다.
-- · 분류 관리: 조직 공간은 관리자(owner·admin)만, 개인 공간은 본인. 지우면 소속 할 일은 미분류가 된다(외래 키 on delete set null).
-- · 바뀐 기록: 새 동작도 office_task_events에 쌓고, 할 일 하나의 내용 바꾸기(기한·제목·중요도·분류·시작일·메모)는 합쳐 200번까지(기존 상한을 넓힘).
--   상태 바꾸기는 따로 200번까지 센다(분리 검수 LOW-3) — 맡은 사람이 상태를 자주 바꿔도 만든 사람의 내용 고치기 몫을 다 쓰지 않게, 상태 바꾸기만으로도 이력이 끝없이 쌓이지 않게.
--   메모는 값을 기록에 남기지 않는다(4000자 × 200번이 쌓이지 않게) — '메모를 고침'만 남는다.
-- · 같은 값은 다시 쓰지 않는다(IS DISTINCT FROM). 표는 RLS를 켜고 정책 없이 정의자 함수로만 읽고 쓴다(기존 방식).
-- 부하: 쓰기는 사람이 누를 때만. 분류 목록 읽기는 화면이 공간마다 한 번(세션), 바뀐 기록 읽기는 할 일 패널을 열 때·고친 뒤 한 번. 주기 호출·폴링 없음.
-- 상한: 분류는 공간마다 200개, 바뀐 기록 읽기는 300줄.

-- ── 분류 표 ──
create table if not exists public.office_task_categories (
  id uuid primary key,                                            -- 브라우저가 만든 id(두 번 눌려도 한 건)
  scope text not null check (scope ~ '^(u|o):'),
  name text not null check (length(name) between 1 and 40 and name = btrim(name)),
  position integer not null default 0 check (position >= 0),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists office_task_categories_name on public.office_task_categories(scope, lower(name));
create index if not exists office_task_categories_scope on public.office_task_categories(scope, position);
alter table public.office_task_categories enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_task_categories from anon, authenticated;

-- ── 할 일 칸 ──
alter table public.office_tasks add column if not exists status text not null default 'todo' check (status in ('todo', 'doing', 'hold'));
alter table public.office_tasks add column if not exists priority smallint not null default 2 check (priority between 1 and 3);
alter table public.office_tasks add column if not exists category_id uuid references public.office_task_categories(id) on delete set null;
alter table public.office_tasks add column if not exists starts_on date;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'office_tasks_dates_check' and conrelid = 'public.office_tasks'::regclass) then
    alter table public.office_tasks add constraint office_tasks_dates_check check (starts_on is null or due_on is null or starts_on <= due_on);
  end if;
end $$;
create index if not exists office_tasks_category on public.office_tasks(category_id) where category_id is not null;

alter table public.office_task_events drop constraint if exists office_task_events_kind_check;
alter table public.office_task_events add constraint office_task_events_kind_check
  check (kind in ('create', 'title', 'due', 'assign', 'done', 'reopen', 'cancel', 'status', 'priority', 'category', 'start', 'note'));

-- ── 할 일 쓰기(바탕: 20260929180000_office_tasks_owners.sql의 정의) ──
-- 새 동작: task.status(맡은 사람도 — 할 일↔진행 중↔보류), task.priority·task.category·task.start·task.note(제목·기한과 같은 권한).
-- task.create는 상태·중요도·분류·시작일도 받는다. 끝낸 일·취소한 일은 기존처럼 바꾸지 않는다.
create or replace function public.office_task_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); sc text; manager boolean := false; t public.office_tasks%rowtype;
  tid uuid; target uuid; due date; ttl text; body text;
  st text; pr smallint; cat uuid; start date; cat_name text; old_name text;
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
    start := public.office_task_input(p_data->>'starts_on', 'date')::date;
    st := coalesce(nullif(p_data->>'status', ''), 'todo');
    if st not in ('todo', 'doing', 'hold') then raise exception 'task_input'; end if;
    if coalesce(p_data->>'priority', '2') !~ '^[123]$' then raise exception 'task_input'; end if;
    pr := coalesce(p_data->>'priority', '2')::smallint;
    if start > due then raise exception 'task_dates'; end if;
    cat := public.office_task_input(p_data->>'category_id', 'uuid')::uuid;
    if cat is not null and not exists (select 1 from public.office_task_categories c where c.id = cat and c.scope = sc) then raise exception 'task_category'; end if;
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
      if t.scope = sc and t.title = ttl and t.note = body and t.due_on is not distinct from due and t.assignee = target and t.created_by = who
         and t.starts_on is not distinct from start and t.status = st and t.priority = pr and t.category_id is not distinct from cat then return to_jsonb(t) - 'scope'; end if;
      raise exception 'task_conflict';
    end if;
    insert into public.office_tasks(id, scope, title, note, due_on, assignee, created_by, source, status, priority, category_id, starts_on)
      values (tid, sc, ttl, body, due, target, who, case when jsonb_typeof(p_data->'source') = 'object' then p_data->'source' end, st, pr, cat, start) returning * into t;
    insert into public.office_task_events(task_id, kind, actor, to_value) values (tid, 'create', who, due::text);
    return to_jsonb(t) - 'scope';
  end if;

  select * into t from public.office_tasks where id = tid and scope = sc for update;
  if not found then raise exception 'task_not_found'; end if;
  -- 맡은 사람은 끝내기·다시 열기·상태 바꾸기. 기한·제목·메모·분류·중요도·시작일·취소는 만든 사람(내가 만든 내 일 포함)과 관리자만 — 남이 맡긴 일의 기한을 늦춰 준수율을 꾸밀 수 없게
  if not (manager
      or (p_action in ('task.done', 'task.reopen', 'task.status') and t.assignee = who)
      or (p_action in ('task.title', 'task.due', 'task.cancel', 'task.note', 'task.priority', 'task.category', 'task.start') and t.created_by = who and t.assignee = who)) then -- 관리자가 남에게 다시 맡긴 일은 만든 사람도 못 바꾼다
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  if t.cancelled_at is not null then raise exception 'task_cancelled'; end if;
  if p_action in ('task.due', 'task.title', 'task.priority', 'task.category', 'task.start', 'task.note')
     and (select count(*) from public.office_task_events e where e.task_id = tid and e.kind in ('due', 'title', 'priority', 'category', 'start', 'note')) >= 200 then
    raise exception 'task_limit'; -- 할 일 하나의 내용 바꾸기 이력은 합쳐 200번까지(끝내기·다시 열기는 막지 않는다)
  end if;
  if p_action = 'task.status' and (select count(*) from public.office_task_events e where e.task_id = tid and e.kind = 'status') >= 200 then
    raise exception 'task_limit'; -- 상태 바꾸기는 내용 고치기와 따로 200번까지(맡은 사람의 상태 바꾸기가 내용 고치기 몫을 쓰지 않게)
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
    raise exception 'task_done'; -- 끝낸 일은 기한·제목·담당·취소·상태·메모·분류·중요도·시작일을 바꾸지 않는다(다시 열어야 한다)
  elsif p_action = 'task.due' then
    due := public.office_task_input(p_data->>'due_on', 'date')::date;
    if t.starts_on > due then raise exception 'task_dates'; end if;
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
  elsif p_action = 'task.status' then
    st := p_data->>'status';
    if st is null or st not in ('todo', 'doing', 'hold') then raise exception 'task_input'; end if;
    if t.status is distinct from st then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'status', who, t.status, st);
      update public.office_tasks set status = st where id = tid returning * into t;
    end if;
  elsif p_action = 'task.priority' then
    if coalesce(p_data->>'priority', '') !~ '^[123]$' then raise exception 'task_input'; end if;
    pr := (p_data->>'priority')::smallint;
    if t.priority is distinct from pr then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'priority', who, t.priority::text, pr::text);
      update public.office_tasks set priority = pr where id = tid returning * into t;
    end if;
  elsif p_action = 'task.category' then
    cat := public.office_task_input(p_data->>'category_id', 'uuid')::uuid; -- 비우면 미분류
    if cat is not null then
      select c.name into cat_name from public.office_task_categories c where c.id = cat and c.scope = sc;
      if cat_name is null then raise exception 'task_category'; end if;
    end if;
    if t.category_id is distinct from cat then
      select c.name into old_name from public.office_task_categories c where c.id = t.category_id;
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'category', who, old_name, cat_name); -- 이름으로 남긴다(분류를 지우거나 이름을 바꿔도 그때 이름이 읽힌다)
      update public.office_tasks set category_id = cat where id = tid returning * into t;
    end if;
  elsif p_action = 'task.start' then
    start := public.office_task_input(p_data->>'starts_on', 'date')::date;
    if start > t.due_on then raise exception 'task_dates'; end if;
    if t.starts_on is distinct from start then
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'start', who, t.starts_on::text, start::text);
      update public.office_tasks set starts_on = start where id = tid returning * into t;
    end if;
  elsif p_action = 'task.note' then
    if not (p_data ? 'note') or jsonb_typeof(p_data->'note') is distinct from 'string' then raise exception 'task_input'; end if; -- 빠뜨린 요청이 메모를 지우지 않게
    body := p_data->>'note';
    if length(body) > 4000 then raise exception 'task_input'; end if;
    if t.note is distinct from body then
      insert into public.office_task_events(task_id, kind, actor) values (tid, 'note', who);
      update public.office_tasks set note = body where id = tid returning * into t;
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

-- 보이는 할 일(바탕: 20260929180000의 정의): 담당자·만든 사람·조직 관리자. 끝낸 일은 최근 30일만, 취소한 일은 뺀다.
-- 새 칸(상태·중요도·분류 id·시작일)은 행 그대로 나가고, 분류 이름(category)을 붙인다 — 개인 공간에 겹쳐 보이는 조직 할 일도 이름을 따로 받지 않게.
create or replace function public.office_task_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text := public.office_business_scope(p_org, false); manager boolean := false;
begin
  if p_org is not null then
    manager := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  return coalesce((select jsonb_agg((to_jsonb(t) - 'scope') || jsonb_build_object('category', c.name) order by t.done_at nulls first, t.due_on nulls last, t.created_at)
    from (select * from public.office_tasks t
      where t.scope = sc and t.cancelled_at is null and (t.done_at is null or t.done_at > now() - interval '30 days')
        and (manager or t.assignee = who or t.created_by = who)
      order by t.done_at nulls first, t.due_on nulls last, t.created_at limit 2000) t
    left join public.office_task_categories c on c.id = t.category_id), '[]'::jsonb); -- ponytail: 화면용 2000건, 넘으면 커서
end $$;

-- 분류 목록 — 그 공간 사람이면 누구나 읽는다(고르기·거르기용). 할 일 수(tasks)는 관리자·개인 공간에만(지우기 확인 창용 — 직원에게는 안 보이는 일의 수를 내지 않는다)
create or replace function public.office_task_category_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text := public.office_business_scope(p_org, false); counts boolean := p_org is null;
begin
  if p_org is not null then
    counts := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'position', c.position,
      'tasks', case when counts then (select count(*) from public.office_tasks x where x.category_id = c.id and x.cancelled_at is null) end) order by c.position, lower(c.name), c.id)
    from public.office_task_categories c where c.scope = sc), '[]'::jsonb);
end $$;

-- 분류 관리 — category.create {id, name} · category.rename {id, name} · category.order {ids: 공간의 모든 분류 id를 새 순서로} · category.delete {id}.
-- 조직 공간은 관리자만, 개인 공간은 본인. 같은 이름(대소문자 무시)은 공간마다 하나. 바꾼 뒤의 목록을 돌려준다.
create or replace function public.office_task_category_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text; c public.office_task_categories%rowtype; cid uuid; nm text; ids uuid[]; n integer;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'task_input'; end if;
  sc := public.office_business_scope(p_org, false);
  if p_org is not null and not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin')) then
    raise exception 'task_forbidden' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-task-cats:' || sc, 0)); -- 같은 공간의 순서·상한·이름 검사가 겹치지 않게

  if p_action in ('category.create', 'category.rename', 'category.delete') then
    cid := public.office_task_input(p_data->>'id', 'uuid')::uuid;
    if cid is null then raise exception 'task_input'; end if;
  end if;
  if p_action in ('category.create', 'category.rename') then
    nm := btrim(coalesce(p_data->>'name', ''));
    if length(nm) not between 1 and 40 then raise exception 'task_input'; end if;
  end if;

  if p_action = 'category.create' then
    select * into c from public.office_task_categories where id = cid;
    if c.id is not null then
      if c.scope = sc and c.name = nm then return public.office_task_category_list(p_org); end if; -- 같은 요청이 두 번
      raise exception 'task_conflict';
    end if;
    if exists (select 1 from public.office_task_categories x where x.scope = sc and lower(x.name) = lower(nm)) then raise exception 'task_category_name'; end if;
    if (select count(*) from public.office_task_categories x where x.scope = sc) >= 200 then raise exception 'task_limit'; end if;
    insert into public.office_task_categories(id, scope, name, position, created_by)
      values (cid, sc, nm, coalesce((select max(x.position) + 1 from public.office_task_categories x where x.scope = sc), 0), who);
  elsif p_action = 'category.rename' then
    select * into c from public.office_task_categories where id = cid and scope = sc for update;
    if c.id is null then raise exception 'task_category'; end if;
    if c.name is distinct from nm then
      if exists (select 1 from public.office_task_categories x where x.scope = sc and x.id <> cid and lower(x.name) = lower(nm)) then raise exception 'task_category_name'; end if;
      update public.office_task_categories set name = nm where id = cid;
    end if;
  elsif p_action = 'category.order' then
    if jsonb_typeof(p_data->'ids') is distinct from 'array' or jsonb_array_length(p_data->'ids') > 200 then raise exception 'task_input'; end if;
    begin
      select coalesce(array_agg(v::uuid order by i), '{}') into ids from jsonb_array_elements_text(p_data->'ids') with ordinality x(v, i);
    exception when others then raise exception 'task_input'; end;
    select count(*) into n from public.office_task_categories x where x.scope = sc;
    -- 공간의 분류를 빠짐없이·한 번씩(일부만 보내면 나머지 순서가 겹친다)
    if cardinality(ids) <> n or (select count(distinct u) from unnest(ids) u) <> n
       or exists (select 1 from unnest(ids) u where not exists (select 1 from public.office_task_categories x where x.id = u and x.scope = sc)) then
      raise exception 'task_input';
    end if;
    update public.office_task_categories x set position = o.i - 1
      from unnest(ids) with ordinality o(id, i)
      where x.id = o.id and x.scope = sc and x.position is distinct from (o.i - 1)::integer; -- 자리가 같은 줄은 다시 쓰지 않는다
  elsif p_action = 'category.delete' then
    delete from public.office_task_categories where id = cid and scope = sc; -- 소속 할 일은 외래 키(on delete set null)로 미분류가 된다
    if not found then raise exception 'task_category'; end if;
  else
    raise exception 'task_input';
  end if;
  return public.office_task_category_list(p_org);
exception when unique_violation then raise exception 'task_category_name'; -- 같은 이름을 동시에 만들면
end $$;

-- 바뀐 기록 — 그 할 일을 볼 수 있는 사람(담당자·만든 사람·조직 관리자)만, 최근 300줄. 사람 이름과 맡은 사람 바꾸기의 앞뒤 이름을 붙인다.
create or replace function public.office_task_history(p_org uuid, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text := public.office_business_scope(p_org, false); manager boolean := false; t public.office_tasks%rowtype;
begin
  if p_org is not null then
    manager := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  select * into t from public.office_tasks where id = p_id and scope = sc;
  if t.id is null or not (manager or t.assignee = who or t.created_by = who) then raise exception 'task_not_found'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', e.kind, 'at', e.at, 'actor', e.actor, 'name', public.office_member_name(p_org, e.actor),
      'from', case when e.kind = 'assign' then public.office_member_name(p_org, e.from_value::uuid) else e.from_value end,
      'to', case when e.kind = 'assign' then public.office_member_name(p_org, e.to_value::uuid) else e.to_value end) order by e.at desc, e.id desc)
    from (select * from public.office_task_events x where x.task_id = p_id order by x.at desc, x.id desc limit 300) e), '[]'::jsonb);
end $$;

-- ── 이관 전용(바탕: 20261002201800_office_company.sql의 정의) ──
-- 새 칸: status(Notion 상태 → todo·doing·hold, 'Completed'는 done_at으로), priority(1~3), starts_on, category(이름 — 그 공간 분류에서 찾고 없으면 만든다).
-- 원래 Notion 메모는 note에 그대로 온다(상태·카테고리·우선순위를 메모 글자로 넣지 않는다). 이미 옮긴 줄은 다시 부르면 그대로 돌려준다(재실행 안전).
create or replace function public.office_task_import(p_org uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text; tid uuid; t public.office_tasks%rowtype; v_title text; v_note text; v_due date; v_done timestamptz; v_created timestamptz;
  v_start date; v_status text; v_priority smallint; v_cat_name text; v_cat uuid;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'task_input'; end if;
  sc := public.office_business_scope(p_org, false);
  if p_org is not null and public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'task_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data->'source') is distinct from 'object' or p_data->'source'->>'kind' is distinct from 'notion'
     or length(coalesce(p_data->'source'->>'id', '')) not between 1 and 200 then raise exception 'task_input'; end if;
  begin
    tid := (p_data->>'id')::uuid;
    v_due := nullif(p_data->>'due_on', '')::date;
    v_start := nullif(p_data->>'starts_on', '')::date;
    v_done := nullif(p_data->>'done_at', '')::timestamptz;
    v_created := coalesce(nullif(p_data->>'created_at', '')::timestamptz, clock_timestamp());
  exception when others then raise exception 'task_input'; end;
  v_title := btrim(coalesce(p_data->>'title', '')); v_note := coalesce(p_data->>'note', '');
  v_status := coalesce(nullif(p_data->>'status', ''), 'todo');
  v_cat_name := nullif(btrim(coalesce(p_data->>'category', '')), '');
  if tid is null or length(v_title) not between 1 and 200 or length(v_note) > 4000 or v_done > clock_timestamp() or v_created > clock_timestamp() + interval '1 minute'
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31')
     or (v_start is not null and v_start not between date '2000-01-01' and date '2100-12-31')
     or v_status not in ('todo', 'doing', 'hold') or coalesce(p_data->>'priority', '2') !~ '^[123]$' or length(v_cat_name) > 40 then raise exception 'task_input'; end if;
  if v_start > v_due then raise exception 'task_dates'; end if;
  v_priority := coalesce(p_data->>'priority', '2')::smallint;
  -- 이미 옮긴 줄은 평가 잠금보다 먼저 본다(분리 검수 LOW-10) — 그 달 평가를 끝낸 뒤에도 이관을 다시 돌리면 멈추지 않고 그대로 돌려준다(새로 쓰지 않으므로 잠근 기록이 바뀌지 않는다)
  select * into t from public.office_tasks where id = tid;
  if t.id is not null then
    if t.scope = sc and t.created_by = who and t.source->>'id' = p_data->'source'->>'id' then return to_jsonb(t) - 'scope'; end if;
    raise exception 'task_conflict';
  end if;
  if exists (select 1 from public.office_tasks x where x.scope = sc and x.source->>'kind' = 'notion' and x.source->>'id' = p_data->'source'->>'id') then
    select * into t from public.office_tasks x where x.scope = sc and x.source->>'kind' = 'notion' and x.source->>'id' = p_data->'source'->>'id' limit 1;
    return to_jsonb(t) - 'scope'; -- 같은 원본은 한 번만
  end if;
  if p_org is not null and (public.office_perf_locked(p_org, who, (v_created at time zone 'Asia/Seoul')::date)
     or (v_done is not null and public.office_perf_locked(p_org, who, (v_done at time zone 'Asia/Seoul')::date))) then raise exception 'task_locked'; end if; -- 새 줄만 잠근 달에 넣지 못한다
  perform pg_advisory_xact_lock(hashtextextended('office-task-limit:' || who, 0));
  if (select count(*) from public.office_tasks x where x.scope = sc and x.created_by = who and x.created_at > now() - interval '1 year') >= 5000 then raise exception 'task_limit'; end if;
  if v_cat_name is not null then -- 분류 이름 → 그 공간 분류(없으면 만든다, 같은 이름은 대소문자 무시)
    perform pg_advisory_xact_lock(hashtextextended('office-task-cats:' || sc, 0));
    select c.id into v_cat from public.office_task_categories c where c.scope = sc and lower(c.name) = lower(v_cat_name);
    if v_cat is null then
      if (select count(*) from public.office_task_categories x where x.scope = sc) >= 200 then raise exception 'task_limit'; end if;
      insert into public.office_task_categories(id, scope, name, position, created_by)
        values (gen_random_uuid(), sc, v_cat_name, coalesce((select max(x.position) + 1 from public.office_task_categories x where x.scope = sc), 0), who) returning id into v_cat;
    end if;
  end if;
  insert into public.office_tasks(id, scope, title, note, due_on, assignee, created_by, created_at, done_at, source, status, priority, category_id, starts_on)
    values (tid, sc, v_title, v_note, v_due, who, who, v_created, v_done, jsonb_build_object('kind', 'notion', 'id', p_data->'source'->>'id'), v_status, v_priority, v_cat, v_start) returning * into t;
  insert into public.office_task_events(task_id, kind, actor, at, to_value) values (tid, 'create', who, v_created, v_due::text);
  if v_done is not null then insert into public.office_task_events(task_id, kind, actor, at) values (tid, 'done', who, v_done); end if;
  return to_jsonb(t) - 'scope';
end $$;

revoke all on function public.office_task_write(uuid, text, jsonb), public.office_task_list(uuid), public.office_task_import(uuid, jsonb),
  public.office_task_category_list(uuid), public.office_task_category_write(uuid, text, jsonb), public.office_task_history(uuid, uuid) from public, anon;
grant execute on function public.office_task_write(uuid, text, jsonb), public.office_task_list(uuid), public.office_task_import(uuid, jsonb),
  public.office_task_category_list(uuid), public.office_task_category_write(uuid, text, jsonb), public.office_task_history(uuid, uuid) to authenticated;
