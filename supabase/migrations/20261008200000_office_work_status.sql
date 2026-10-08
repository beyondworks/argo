-- 업무 현황(유건 10/8 확정 "권장안대로"): 오피스 한 화면에서 맥 Claude 세션·아르고 에이전트(크루)·VPS 에이전트(봇)가 하는 일을 본다.
-- · 보류 사유: office_tasks에 hold_reason(1~500자, 앞뒤 공백 정리)·held_at(보류한 시각). 보류로 바꾸면 시각이 생기고, 다른 상태로 가면 둘 다 지운다.
--   이미 보류인 일에 사유만 다르게 보내면 사유만 바꾼다(보류한 시각 그대로). 사유를 빠뜨린 요청은 사유를 지우지 않는다(메모와 같은 원칙).
--   사유만 고치기(reason_only: true — 할 일 패널): 상태는 바꾸지 않는다. 지금 보류가 아니면(그사이 남이 진행 중으로 바꿈) 아무것도 바꾸지 않고 task_conflict
--   — 낡은 패널이 진행 중인 일을 보류로 되돌리지 못하게.
--   기록은 기존 'status' 한 줄(사유 값은 남기지 않는다 — from/to만, 사유 바꾸기는 hold→hold), 사유 바꾸기도 상태 바꾸기 200번 상한에 함께 센다. 새 기록 종류는 없다.
--   이 마이그레이션 전에 보류로 바꾼 일은 마지막 '보류로 바꿈' 기록 시각을 held_at으로 채운다(기록이 없는 이관 일은 비워 둔다 — 모르는 날을 지어내지 않는다).
--   성과 기록(office_perf_compute)·노하우·크루 도구는 바꾸지 않는다 — 성과는 지금처럼 done_at·due_on·cancelled_at만 본다.
-- · 세션 보고 office_agent_sessions: 세션 제목·프로젝트 폴더 이름·마지막 활동 시각·맡은 할 일 id만 둔다(대화 내용·프롬프트는 받지 않는다).
--   주인만 자기 세션을 쓴다(남의 세션 id 덮어쓰기 거절). 값이 같고 4분 안이면 쓰지 않는다.
--   맡은 할 일 id는 그 공간(조직 'o:'·개인 'u:')에서 내가 맡았거나 만든 일만 받는다(아니면 session_input) — 남의 일을 '지금 하는 일'로 붙이지 못하게.
-- · 업무 현황 읽기 office_work_status: 조직 관리자(owner·admin)는 조직 전체, 일반 멤버는 자기 에이전트·자기 세션·자기 일만. 손님·밖의 사람은 오류. 쓰기 0.
-- · 표는 RLS를 켜고 정책 없이 정의자 함수로만 읽고 쓴다(기존 방식).
-- 부하: 세션 보고는 이름을 붙인 세션만, 세션 10개 × 훅(Stop·UserPromptSubmit·PostToolUse)마다여도 훅이 로컬에서 거르므로
--   세션당 4분에 1번 또는 값이 바뀔 때만 → 사람당 분당 최대 약 2.5회 호출·쓰기.
--   서버도 같은 값·4분 안이면 쓰기 0(xmin 그대로 — PG 테스트로 잠근다). 업무 현황 읽기는 화면을 연 사람 1명당 열 때 1회 + 화면이 보이는 동안 60초에 1회, 쓰기 0.
--   할 일 쓰기는 사람이 누를 때만(주기 호출 없음).
-- 보존: office_agent_sessions는 8일 넘게 안 보인 자기 행을 그 사람의 보고(쓰는 호출)에서 지운다(크론 없음 — 화면은 최근 7일만 쓴다).
--   사람당 200행 상한: 새 세션이 들어올 때 차 있으면 거절하지 않고 그 사람의 가장 오래 안 보인 행부터 밀어낸다(남의 행은 그대로).
--   세션 행은 기억 데이터가 아니다(제목·폴더·시각뿐 — 다음 보고가 다시 만든다). 총괄 결정 10/8: 이 맥에서 대화 기록이 24시간 208개 생긴다(헤드리스 포함).
--   계정이 지워지면(auth.users) 같이 지워지고, 조직이 지워지면 그 조직 세션도 지워진다. 업무 현황은 최근 7일 세션만 보여 준다.
-- 상한(읽기 한 번): 에이전트 500·세션 500·실행 중 500·팀 작업 100·할 일 500.
-- 색인: 실행 중 실행(msgr_executions state='running')과 열린 팀 작업(msgr_work_runs running·blocked)에 부분 색인 — 60초마다 읽을 때
--   크루의 모든 실행 이력·조직의 모든 팀 작업을 훑지 않게. 부분 색인이라 끝난 행은 들어가지 않는다.

-- ── 할 일 칸 ──
alter table public.office_tasks add column if not exists hold_reason text check (hold_reason is null or (length(hold_reason) between 1 and 500 and hold_reason = btrim(hold_reason)));
alter table public.office_tasks add column if not exists held_at timestamptz;
update public.office_tasks t set held_at = e.held
  from (select x.task_id, max(x.at) as held from public.office_task_events x where x.kind = 'status' and x.to_value = 'hold' group by x.task_id) e
  where e.task_id = t.id and t.status = 'hold' and t.held_at is null; -- 옛 보류 일: 마지막으로 보류로 바꾼 시각(다시 적용하면 채운 줄은 건너뛴다)

-- ── 할 일 쓰기(바탕: 20261004100000_office_task_props.sql의 정의) ──
-- 바뀐 곳: hold_reason·reason_only 읽기, task.create의 보류 시각·사유(같은 요청 두 번 판정에 사유 포함), task.status의 보류 시각·사유와 사유만 바꾸기. 나머지는 그대로다.
create or replace function public.office_task_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); sc text; manager boolean := false; t public.office_tasks%rowtype;
  tid uuid; target uuid; due date; ttl text; body text;
  st text; pr smallint; cat uuid; start date; cat_name text; old_name text; reason text;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'task_input'; end if;
  sc := public.office_business_scope(p_org, false); -- 손님·밖의 사람은 여기서 막힌다
  if p_org is not null then
    manager := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));
  end if;
  tid := public.office_task_input(p_data->>'id', 'uuid')::uuid;
  if tid is null then raise exception 'task_input'; end if;
  if p_action in ('task.create', 'task.status') then -- 보류 사유: 글 또는 null, 앞뒤 공백을 걷고 빈 글은 없음, 500자까지
    if p_data ? 'hold_reason' and jsonb_typeof(p_data->'hold_reason') not in ('string', 'null') then raise exception 'task_input'; end if;
    if p_data ? 'reason_only' and jsonb_typeof(p_data->'reason_only') <> 'boolean' then raise exception 'task_input'; end if;
    reason := nullif(btrim(coalesce(p_data->>'hold_reason', '')), '');
    if length(reason) > 500 then raise exception 'task_input'; end if;
  end if;

  if p_action = 'task.create' then
    ttl := btrim(coalesce(p_data->>'title', '')); body := coalesce(p_data->>'note', '');
    if length(ttl) not between 1 and 200 or length(body) > 4000 then raise exception 'task_input'; end if;
    due := public.office_task_input(p_data->>'due_on', 'date')::date;
    start := public.office_task_input(p_data->>'starts_on', 'date')::date;
    st := coalesce(nullif(p_data->>'status', ''), 'todo');
    if st not in ('todo', 'doing', 'hold') then raise exception 'task_input'; end if;
    if st <> 'hold' then reason := null; end if; -- 사유는 보류인 일에만 남긴다
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
         and t.starts_on is not distinct from start and t.status = st and t.priority = pr and t.category_id is not distinct from cat
         and t.hold_reason is not distinct from reason then return to_jsonb(t) - 'scope'; end if;
      raise exception 'task_conflict';
    end if;
    insert into public.office_tasks(id, scope, title, note, due_on, assignee, created_by, source, status, priority, category_id, starts_on, hold_reason, held_at)
      values (tid, sc, ttl, body, due, target, who, case when jsonb_typeof(p_data->'source') = 'object' then p_data->'source' end, st, pr, cat, start,
              reason, case when st = 'hold' then now() end) returning * into t;
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
    if coalesce((p_data->>'reason_only')::boolean, false) and (st <> 'hold' or t.status <> 'hold') then
      raise exception 'task_conflict'; -- 사유만 고치기: 상태 전이 없음. 그사이 보류가 풀렸으면 아무것도 바꾸지 않는다(화면은 다시 읽는다)
    end if;
    if t.status is distinct from st then -- 보류로 가면 보류한 시각·사유가 생기고, 보류에서 나가면 둘 다 지운다
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'status', who, t.status, st);
      update public.office_tasks set status = st, held_at = case when st = 'hold' then now() end, hold_reason = case when st = 'hold' then reason end
        where id = tid returning * into t;
    elsif st = 'hold' and p_data ? 'hold_reason' and t.hold_reason is distinct from reason then
      -- 이미 보류인 일: 사유만 바꾼다(보류한 시각 그대로). 기록은 같은 'status' 한 줄(사유 값은 남기지 않는다) — 상태 바꾸기 200번 상한에 함께 센다
      insert into public.office_task_events(task_id, kind, actor, from_value, to_value) values (tid, 'status', who, t.status, st);
      update public.office_tasks set hold_reason = reason where id = tid returning * into t;
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

-- ── 세션 보고 표 ──
create table if not exists public.office_agent_sessions (
  id uuid primary key,                                                              -- Claude 세션 id
  owner_user_id uuid not null references auth.users(id) on delete cascade,          -- 보고한 사람(auth.uid())
  org_id uuid references public.msgr_orgs(id) on delete cascade,                   -- null = 개인 공간
  name text not null check (length(name) between 1 and 120 and name = btrim(name)), -- 세션 제목
  project text check (project is null or (length(project) between 1 and 120 and project = btrim(project))), -- 프로젝트 폴더 이름
  kind text not null default 'claude-code' check (kind in ('claude-code')),
  task_id uuid,                                                                     -- 지금 맡은 할 일(외래 키 없음 — 지워진 일이면 화면이 무시한다)
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists office_agent_sessions_org on public.office_agent_sessions(org_id, last_seen_at desc);
create index if not exists office_agent_sessions_owner on public.office_agent_sessions(owner_user_id);
alter table public.office_agent_sessions enable row level security; -- 정책 없음: 함수로만
revoke all on public.office_agent_sessions from anon, authenticated;

-- ── 업무 현황 읽기용 부분 색인(위 '색인' 참고) ──
create index if not exists msgr_executions_running on public.msgr_executions(crew_id) where state = 'running';
create index if not exists msgr_work_runs_org_open on public.msgr_work_runs(org_id, created_at desc) where status in ('running', 'blocked');

-- 세션 보고 — 값(조직·제목·프로젝트·할 일)이 바뀌었거나 마지막 기록이 4분 넘게 지났을 때만 쓴다. 같은 값을 4분 안에 다시 보내면 쓰기 0.
-- 남의 세션 id는 덮어쓰지 않는다(session_forbidden). 조직을 적으면 그 조직의 손님 아닌 지금 멤버여야 한다.
-- 맡은 할 일 id는 그 공간에서 내가 맡았거나 만든 일만(아니면 session_input — 매 호출 확인, 읽기만). 쓰는 호출에서 8일 넘게 안 보인 내 행을 지운다.
-- 새 세션이 들어올 때 내 행이 200개면 가장 오래 안 보인 내 행부터 밀어낸다(거절하지 않는다 — 새 세션이 화면에서 빠지지 않게).
create or replace function public.office_session_report(p_id uuid, p_org uuid, p_name text, p_project text, p_task uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); s public.office_agent_sessions%rowtype;
  nm text := btrim(coalesce(p_name, '')); pj text := nullif(btrim(coalesce(p_project, '')), '');
begin
  if who is null then raise exception 'session_signin' using errcode = '42501'; end if;
  if p_id is null or length(nm) not between 1 and 120 or length(pj) > 120 then raise exception 'session_input'; end if;
  if p_org is not null and not exists (select 1 from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
      where m.org_id = p_org and m.user_id = who and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null) then
    raise exception 'session_forbidden' using errcode = '42501';
  end if;
  if p_task is not null and not exists (select 1 from public.office_tasks t where t.id = p_task
      and t.scope = case when p_org is null then 'u:' || who else 'o:' || p_org end and (t.assignee = who or t.created_by = who)) then
    raise exception 'session_input'; -- 남의 일·다른 공간의 일·없는 일
  end if;
  select * into s from public.office_agent_sessions where id = p_id;
  if s.id is not null and s.owner_user_id <> who then raise exception 'session_forbidden' using errcode = '42501'; end if;
  if s.id is not null and (s.org_id, s.name, s.project, s.task_id) is not distinct from (p_org, nm, pj, p_task)
     and s.last_seen_at >= now() - interval '4 minutes' then
    return jsonb_build_object('ok', true, 'written', false); -- 유휴 반복 호출: 읽기만
  end if;
  delete from public.office_agent_sessions x where x.owner_user_id = who and x.last_seen_at < now() - interval '8 days' and x.id <> p_id; -- 보존 8일(내 행만)
  if s.id is null then
    perform pg_advisory_xact_lock(hashtextextended('office-session-limit:' || who, 0)); -- 동시 요청이 상한을 넘지 않게
    delete from public.office_agent_sessions x where x.id in (select y.id from public.office_agent_sessions y where y.owner_user_id = who
      order by y.last_seen_at desc, y.id desc offset 199); -- 상한 200: 넣을 자리 하나를 남기고 가장 오래 안 보인 내 행부터 밀어낸다(남의 행은 그대로)
    insert into public.office_agent_sessions(id, owner_user_id, org_id, name, project, task_id) values (p_id, who, p_org, nm, pj, p_task)
      on conflict (id) do nothing;
    if found then return jsonb_build_object('ok', true, 'written', true); end if;
    -- 같은 id가 동시에 먼저 들어왔다 — 아래에서 주인을 다시 보고 고친다
  end if;
  update public.office_agent_sessions x set org_id = p_org, name = nm, project = pj, task_id = p_task, last_seen_at = now()
    where x.id = p_id and x.owner_user_id = who
      and ((x.org_id, x.name, x.project, x.task_id) is distinct from (p_org, nm, pj, p_task) or x.last_seen_at < now() - interval '4 minutes');
  if found then return jsonb_build_object('ok', true, 'written', true); end if;
  if exists (select 1 from public.office_agent_sessions x where x.id = p_id and x.owner_user_id <> who) then
    raise exception 'session_forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object('ok', true, 'written', false);
end $$;

-- 업무 현황 — 조직의 손님 아닌 지금 멤버만(아니면 business_forbidden). 관리자는 조직 전체, 일반 멤버는 자기 에이전트·자기 세션·자기 일(맡은 일·만든 일)만. 쓰기 0.
-- 실행 중 = 위 에이전트의 running 실행 중 심박이 기한 안인 것: 로컬 크루(브리지가 30초마다 심박) 2분, VPS 봇(hosting='bot' — 맡을 때 한 번 찍고
--   결재 대기 중에만 다시 찍는다) 10분(봇 경로의 '결과 미도착' 안내 기한과 같다, 20260909230000·20261006100000).
--   '결과 미도착' 안내(client_msg_id 'unknown:<크루>:<원글>')가 이미 붙은 실행은 뺀다 — 봇 경로가 기다리는 실행을 고르는 기준과 같다(20261006100000 보류 판정).
-- 팀 작업 = 위 에이전트가 이끄는 것 중 부른 사람이 읽을 수 있는 방의 것만(msgr_can_read_channel — 목표 글은 그 방에 올라간 글이다, 표 RLS와 같다).
--   막힘은 그대로, 진행 중은 24시간 안에 움직인 것만(끝나지 않고 남은 옛 작업이 '지금 하는 일'로 계속 나오지 않게).
-- 할 일 = 끝내지 않고 취소하지 않은 조직 할 일.
-- people = 할 일의 맡은 사람·만든 사람과 위 에이전트·세션의 주인 이름(office_org_people와 같은 규칙, 조직을 나간 사람은 이름 없음)
--   — 총괄 결정 10/8 (다): 카드는 (주인, 이름 앞부분)으로 묶고, 주인이 내가 아니면 주인 이름을 함께 보인다.
create or replace function public.office_work_status(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); admin boolean; ids uuid[]; bots uuid[];
  v_crews jsonb; v_sessions jsonb; v_running jsonb; v_runs jsonb; v_tasks jsonb; v_people jsonb;
begin
  if p_org is null then raise exception 'session_input'; end if; -- 조직 전용 화면
  perform public.office_business_scope(p_org, false); -- 손님·밖의 사람·로그인 안 한 사람은 여기서 막힌다
  admin := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', coalesce(nullif(c.display_name, ''), c.slug), 'slug', c.slug,
      'hosting', case when c.hosting = 'bot' then 'bot' else 'local' end, 'owner', c.owner_user_id, 'last_seen_at', c.last_seen_at, 'department', c.department)
      order by c.last_seen_at desc nulls last, c.id), '[]'::jsonb), coalesce(array_agg(c.id), '{}'), coalesce(array_agg(c.id) filter (where c.hosting = 'bot'), '{}')
    into v_crews, ids, bots
    from (select * from public.msgr_crews c where c.org_id = p_org and c.status = 'active' and (admin or c.owner_user_id = who)
          order by c.last_seen_at desc nulls last, c.id limit 500) c;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'project', s.project, 'owner', s.owner_user_id, 'task_id', s.task_id, 'last_seen_at', s.last_seen_at)
      order by s.last_seen_at desc, s.id), '[]'::jsonb)
    into v_sessions
    from (select * from public.office_agent_sessions s where s.org_id = p_org and s.last_seen_at > now() - interval '7 days' and (admin or s.owner_user_id = who)
          order by s.last_seen_at desc, s.id limit 500) s;

  select coalesce(jsonb_agg(jsonb_build_object('crew_id', e.crew_id, 'started_at', e.started_at) order by e.started_at desc, e.crew_id), '[]'::jsonb)
    into v_running
    from (select e.crew_id, e.started_at from public.msgr_executions e
          where e.crew_id = any(ids) and e.state = 'running'
            and e.heartbeat_at > now() - case when e.crew_id = any(bots) then interval '10 minutes' else interval '2 minutes' end
            and not exists (select 1 from public.msgr_messages m join public.msgr_messages x on x.channel_id = m.channel_id and x.author_kind = 'crew'
                  and coalesce(x.crew_id::text, x.author_user_id::text, '') = e.crew_id::text and x.client_msg_id = 'unknown:' || e.crew_id || ':' || m.id
                where m.id = e.source_msg_id) -- 안내 행 한 건 조회(유니크 색인 msgr_messages_client_id의 네 칸 그대로 — 크루가 쓴 안내만)
          order by e.started_at desc limit 500) e;

  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'lead_crew_id', w.lead_crew_id, 'goal', w.goal, 'status', w.status, 'created_at', w.created_at)
      order by w.created_at desc, w.id), '[]'::jsonb)
    into v_runs
    from (select w.id, w.lead_crew_id, w.goal, w.status, w.created_at from public.msgr_work_runs w
          where w.org_id = p_org and w.status in ('running', 'blocked') and w.lead_crew_id = any(ids)
            and (w.status = 'blocked' or w.updated_at > now() - interval '24 hours')
            and public.msgr_can_read_channel(w.channel_id) -- auth.uid() 기준이라 정의자 함수 안에서도 부른 사람으로 판정한다
          order by w.created_at desc, w.id limit 100) w;

  select coalesce(jsonb_agg(to_jsonb(t) - 'scope' order by t.due_on nulls last, t.created_at, t.id), '[]'::jsonb)
    into v_tasks
    from (select * from public.office_tasks t
          where t.scope = 'o:' || p_org and t.done_at is null and t.cancelled_at is null and (admin or t.assignee = who or t.created_by = who)
          order by t.due_on nulls last, t.created_at, t.id limit 500) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name',
      case when m.user_id is null then null else coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), '?') end) order by x.id), '[]'::jsonb)
    into v_people
    from (select y.id from (select (e->>'assignee')::uuid id from jsonb_array_elements(v_tasks) e
          union select (e->>'created_by')::uuid from jsonb_array_elements(v_tasks) e
          union select (e->>'owner')::uuid from jsonb_array_elements(v_crews) e
          union select (e->>'owner')::uuid from jsonb_array_elements(v_sessions) e) y where y.id is not null) x
    left join public.msgr_org_members m on m.org_id = p_org and m.user_id = x.id and m.removed_at is null and m.role <> 'guest'
    left join public.msgr_profiles p on p.user_id = x.id
    left join auth.users u on u.id = x.id;

  return jsonb_build_object('admin', admin, 'now', now(), 'crews', v_crews, 'sessions', v_sessions, 'running', v_running,
    'runs', v_runs, 'tasks', v_tasks, 'people', v_people);
end $$;

revoke all on function public.office_task_write(uuid, text, jsonb), public.office_session_report(uuid, uuid, text, text, uuid), public.office_work_status(uuid) from public, anon;
grant execute on function public.office_task_write(uuid, text, jsonb), public.office_session_report(uuid, uuid, text, text, uuid), public.office_work_status(uuid) to authenticated;
notify pgrst, 'reload schema';
