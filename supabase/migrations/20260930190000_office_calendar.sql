-- 오피스 일정(캘린더) — 유건 9/30 확정 명세의 DB 부분.
-- 원본은 이 표 하나: 개인 일정(org_id null)과 조직 일정이 같은 표에 있고, 조직 일정은 개인 달력과 조직 달력에 같은 행으로 보인다.
-- 표는 정책 없이 함수로만 읽고 쓴다(office_tasks와 같은 방식). 반복 회차 펼치기는 클라이언트가 한다.
-- 부하: 쓰기는 사람이 저장·삭제를 누르거나 에이전트 도구가 부를 때만. 주기 호출·폴링 없음. 같은 값은 다시 쓰지 않는다.
-- 보존: 일정은 사용자 기억 데이터라 정리 대상이 아니다. 누적은 1년에 사람당 5,000건 생성 상한과 행당 exdates 1,000개 상한으로 묶는다.

create table if not exists public.office_events (
  id uuid primary key,                                            -- 브라우저·도구가 만든 id(두 번 눌려도 한 건)
  org_id uuid references public.msgr_orgs(id) on delete cascade,  -- null = 개인 일정
  owner uuid not null,                                            -- 일정 주인(사람). auth.users에 묶지 않는다(계정 삭제가 회사 기록을 막지 않게)
  crew text check (crew is null or length(crew) between 1 and 100), -- 에이전트가 만들었거나 마지막으로 고친 크루(표시용)
  visibility text not null default 'org' check (visibility in ('org', 'private')),
  title text not null check (length(btrim(title)) between 1 and 200),
  note text not null default '' check (length(note) <= 4000),
  location text not null default '' check (length(location) <= 200),
  category text not null default '' check (length(category) <= 40),
  customer_id uuid references public.office_business_customers(id) on delete set null,
  all_day boolean not null default false,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  attendees uuid[] not null default '{}' check (cardinality(attendees) <= 50),
  rrule text check (rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;INTERVAL=([1-9]|[1-9][0-9]))?(;UNTIL=[0-9]{8})?$'),
  exdates date[] not null default '{}' check (cardinality(exdates) <= 1000),
  parent_id uuid references public.office_events(id) on delete cascade, -- '이번만 수정'한 회차의 부모
  recur_on date,                                                  -- 그 회차의 원래 KST 날짜
  source text check (source is null or length(source) between 1 and 40),
  source_id text check (source_id is null or length(source_id) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_id),
  check (ends_at > starts_at),
  check (org_id is not null or (visibility = 'private' and attendees = '{}')), -- 개인 일정은 항상 나만·참석자 없음
  check ((parent_id is null) = (recur_on is null)),
  check (parent_id is null or rrule is null),                     -- 회차 수정 행은 반복하지 않는다
  check ((source is null) = (source_id is null))
);
create index if not exists office_events_org on public.office_events(org_id, starts_at);
create index if not exists office_events_owner on public.office_events(owner, starts_at);
create index if not exists office_events_parent on public.office_events(parent_id);
create unique index if not exists office_events_parent_day on public.office_events(parent_id, recur_on) where parent_id is not null; -- 한 회차에 수정 행 하나
alter table public.office_events enable row level security;      -- 정책 없음: 읽기·쓰기 모두 함수로만
revoke all on public.office_events from public, anon, authenticated;

-- 그 조직에서의 역할(손님·나간 사람·지운 조직은 null)
create or replace function public.office_event_role(p_org uuid, p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select m.role from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
  where m.org_id = p_org and m.user_id = p_user and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null;
$$;

-- 고칠 수 있나: 주인(조직 일정이면 지금 멤버일 때)과 그 조직 관리자. 에이전트(crew)가 부르면 주인만
create or replace function public.office_event_can_edit(e public.office_events, p_who uuid, p_crew text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select p_who is not null and (
    (e.owner = p_who and (e.org_id is null or public.office_event_role(e.org_id, p_who) is not null))
    or (p_crew is null and e.org_id is not null and public.office_event_role(e.org_id, p_who) in ('owner', 'admin')));
$$;

-- 입력 한 칸 읽기: 형식이 틀리면 calendar_invalid. 시각은 오프셋을 반드시 붙인다(세션 시간대로 조용히 밀리지 않게)
create or replace function public.office_event_in(p_value text, p_kind text) returns text
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_value is null or p_value = '' then return null; end if;
  if p_kind = 'date' then
    if p_value !~ '^\d{4}-\d{2}-\d{2}$' or p_value::date not between date '2000-01-01' and date '2100-12-31' then raise exception 'calendar_invalid'; end if;
    return p_value::date::text;
  elsif p_kind = 'ts' then
    if p_value !~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$'
       or p_value::timestamptz not between timestamptz '2000-01-01 00:00+00' and timestamptz '2100-12-31 00:00+00' then raise exception 'calendar_invalid'; end if;
    return p_value::timestamptz::text;
  end if;
  return p_value::uuid::text;
exception when others then raise exception 'calendar_invalid';
end $$;

-- rrule의 UNTIL(KST 날짜, 포함). 없으면 null, 없는 날짜(20261399)는 오류
create or replace function public.office_event_until(p_rrule text) returns date
language sql immutable set search_path = public, pg_temp as $$
  select case when p_rrule ~ ';UNTIL=[0-9]{8}$' then make_date(substring(p_rrule from ';UNTIL=([0-9]{4})')::int,
    substring(p_rrule from ';UNTIL=[0-9]{4}([0-9]{2})')::int, substring(p_rrule from ';UNTIL=[0-9]{6}([0-9]{2})')::int) end;
$$;

-- 목록과 쓰기 결과가 같은 모양이 되도록 한 곳에서 만든다
create or replace function public.office_event_json(e public.office_events, p_who uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', e.id, 'org_id', e.org_id, 'owner', e.owner,
    'owner_name', coalesce((select coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1))
      from auth.users u left join public.msgr_profiles p on p.user_id = u.id
        left join public.msgr_org_members m on m.org_id = e.org_id and m.user_id = u.id -- 조직 일정은 조직 안 표시 이름 먼저(office_org_people과 같은 기준)
      where u.id = e.owner), '?'),
    'crew', e.crew, 'visibility', e.visibility, 'title', e.title, 'note', e.note, 'location', e.location, 'category', e.category,
    'customer_id', e.customer_id, 'customer_name', (select c.name from public.office_business_customers c where c.id = e.customer_id),
    'all_day', e.all_day, 'starts_at', e.starts_at, 'ends_at', e.ends_at, 'attendees', to_jsonb(e.attendees),
    'rrule', e.rrule, 'exdates', to_jsonb(e.exdates), 'parent_id', e.parent_id, 'recur_on', e.recur_on,
    'can_edit', public.office_event_can_edit(e, p_who, null));
$$;

-- 저장 한 건(쓰기 함수 안에서만 부른다). p_owner: 새 행의 주인을 호출자 대신 정할 때(split의 다음 일정 = 원래 주인)
create or replace function public.office_event_save(p_data jsonb, p_who uuid, p_crew text, p_owner uuid) returns public.office_events
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e public.office_events%rowtype; old public.office_events%rowtype; par public.office_events%rowtype;
  eid uuid; v_org uuid; v_owner uuid; v_vis text; v_title text; v_note text; v_loc text; v_cat text; v_cust uuid;
  v_allday boolean; v_start timestamptz; v_end timestamptz; v_att uuid[]; v_rrule text; v_ex date[];
  v_parent uuid; v_recur date; v_src text; v_srcid text; bad uuid;
begin
  eid := public.office_event_in(p_data->>'id', 'uuid')::uuid;
  if eid is null then raise exception 'calendar_invalid'; end if;
  v_org := public.office_event_in(p_data->>'org_id', 'uuid')::uuid;
  v_parent := public.office_event_in(p_data->>'parent_id', 'uuid')::uuid;
  v_recur := public.office_event_in(p_data->>'recur_on', 'date')::date;
  select * into old from public.office_events where id = eid for update;

  if old.id is not null then
    if not public.office_event_can_edit(old, p_who, p_crew) then raise exception 'calendar_forbidden' using errcode = '42501'; end if;
    if old.parent_id is distinct from v_parent or old.recur_on is distinct from v_recur then raise exception 'calendar_invalid'; end if;
    if old.org_id is distinct from v_org then -- 개인↔조직, 조직↔조직 옮기기는 주인만. 회차 수정 행은 부모를 따라간다
      if old.owner <> p_who then raise exception 'calendar_forbidden' using errcode = '42501'; end if;
      if old.parent_id is not null then raise exception 'calendar_invalid'; end if;
    end if;
    v_owner := old.owner;
  else
    if v_parent is not null then -- '이번만 수정': 부모를 고칠 수 있어야 하고, 주인·조직은 부모를 따른다
      select * into par from public.office_events where id = v_parent for update;
      if par.id is null then raise exception 'calendar_not_found'; end if;
      if par.parent_id is not null or par.rrule is null or v_recur is null then raise exception 'calendar_invalid'; end if;
      if not public.office_event_can_edit(par, p_who, p_crew) then raise exception 'calendar_forbidden' using errcode = '42501'; end if;
      if v_org is distinct from par.org_id then raise exception 'calendar_invalid'; end if;
      v_owner := par.owner;
    else
      if v_recur is not null then raise exception 'calendar_invalid'; end if;
      v_owner := coalesce(p_owner, p_who);
    end if;
    perform pg_advisory_xact_lock(hashtextextended('office-event-limit:' || v_owner, 0)); -- 동시 요청이 상한을 넘지 않게
    if (select count(*) from public.office_events x where x.owner = v_owner and x.created_at > now() - interval '1 year') >= 5000 then
      raise exception 'calendar_limit';
    end if;
  end if;
  if v_org is not null and public.office_event_role(v_org, p_who) is null then -- 조직 일정은 그 조직 멤버(손님·나간 사람 제외)만 만들고 옮긴다
    raise exception 'calendar_forbidden' using errcode = '42501';
  end if;

  v_vis := case when v_org is null then 'private' else coalesce(nullif(p_data->>'visibility', ''), 'org') end;
  v_title := btrim(coalesce(p_data->>'title', ''));
  v_note := coalesce(p_data->>'note', '');
  v_loc := btrim(coalesce(p_data->>'location', ''));
  v_cat := btrim(coalesce(p_data->>'category', ''));
  if v_vis not in ('org', 'private') or length(v_title) not between 1 and 200 or length(v_note) > 4000
     or length(v_loc) > 200 or length(v_cat) > 40 then raise exception 'calendar_invalid'; end if;
  if jsonb_typeof(p_data->'all_day') not in ('boolean', 'null') then raise exception 'calendar_invalid'; end if;
  v_allday := coalesce((p_data->>'all_day')::boolean, false);
  v_start := public.office_event_in(p_data->>'starts_at', 'ts')::timestamptz;
  v_end := public.office_event_in(p_data->>'ends_at', 'ts')::timestamptz;
  if v_start is null or v_end is null or v_end <= v_start then raise exception 'calendar_invalid'; end if;
  if v_allday and ((v_start at time zone 'Asia/Seoul')::time <> time '00:00' or (v_end at time zone 'Asia/Seoul')::time <> time '00:00') then
    raise exception 'calendar_invalid'; -- 종일은 KST 자정 기준 [첫날 00:00, 끝날 다음날 00:00)
  end if;

  if jsonb_typeof(p_data->'attendees') not in ('array', 'null') then raise exception 'calendar_invalid'; end if;
  select coalesce(array_agg(u order by i), '{}') into v_att
    from (select public.office_event_in(x, 'uuid')::uuid u, min(i) i
          from jsonb_array_elements_text(coalesce(p_data->'attendees', '[]')) with ordinality a(x, i) group by 1) s where u is not null;
  if v_org is null then v_att := '{}'; end if; -- 개인 일정은 참석자 없음
  if cardinality(v_att) > 50 then raise exception 'calendar_invalid'; end if;
  select u into bad from unnest(v_att) u where public.office_event_role(v_org, u) is null limit 1;
  if bad is not null then raise exception 'calendar_invalid'; end if; -- 참석자는 그 조직 멤버만

  v_rrule := nullif(p_data->>'rrule', '');
  if v_rrule is not null then
    if v_parent is not null or v_rrule !~ '^FREQ=(DAILY|WEEKLY|MONTHLY)(;INTERVAL=([1-9]|[1-9][0-9]))?(;UNTIL=[0-9]{8})?$' then raise exception 'calendar_invalid'; end if;
    begin
      if public.office_event_until(v_rrule) < (v_start at time zone 'Asia/Seoul')::date then raise exception 'calendar_invalid'; end if;
    exception when datetime_field_overflow or invalid_datetime_format then raise exception 'calendar_invalid';
    end;
    if jsonb_typeof(p_data->'exdates') not in ('array', 'null') then raise exception 'calendar_invalid'; end if;
    select coalesce(array_agg(d order by d), '{}') into v_ex from (
      select public.office_event_in(x, 'date')::date d from jsonb_array_elements_text(coalesce(p_data->'exdates', '[]')) a(x)
      union select c.recur_on from public.office_events c where c.parent_id = eid) s where d is not null; -- 회차 수정 행이 있는 날은 늘 뺀다
    if cardinality(v_ex) > 1000 then raise exception 'calendar_limit'; end if;
  else
    v_ex := '{}';
  end if;

  v_cust := public.office_event_in(p_data->>'customer_id', 'uuid')::uuid;
  if v_cust is not null and not exists (select 1 from public.office_business_customers c where c.id = v_cust
      and c.scope = case when v_org is null then 'u:' || v_owner else 'o:' || v_org end) then
    raise exception 'calendar_invalid'; -- 거래처는 일정과 같은 공간(개인 = 주인의 거래처, 조직 = 그 조직의 거래처)
  end if;

  if old.id is null then
    v_src := nullif(p_data->>'source', ''); v_srcid := nullif(p_data->>'source_id', ''); -- 이관 표지는 만들 때만 붙고 고쳐도 남는다
    insert into public.office_events(id, org_id, owner, crew, visibility, title, note, location, category, customer_id, all_day,
      starts_at, ends_at, attendees, rrule, exdates, parent_id, recur_on, source, source_id)
    values (eid, v_org, v_owner, p_crew, v_vis, v_title, v_note, v_loc, v_cat, v_cust, v_allday,
      v_start, v_end, v_att, v_rrule, v_ex, v_parent, v_recur, v_src, v_srcid) returning * into e;
    if v_parent is not null and not (v_recur = any(par.exdates)) then -- 부모 전개에서 그 날을 뺀다
      update public.office_events set exdates = (select array_agg(d order by d) from unnest(par.exdates || v_recur) d), updated_at = now()
        where id = v_parent;
    end if;
    return e;
  end if;

  if (old.org_id, old.visibility, old.title, old.note, old.location, old.category, old.customer_id, old.all_day,
      old.starts_at, old.ends_at, old.attendees, old.rrule, old.exdates)
     is not distinct from (v_org, v_vis, v_title, v_note, v_loc, v_cat, v_cust, v_allday, v_start, v_end, v_att, v_rrule, v_ex) then
    return old; -- 같은 값은 다시 쓰지 않는다(updated_at·crew도 그대로)
  end if;
  update public.office_events set org_id = v_org, visibility = v_vis, title = v_title, note = v_note, location = v_loc,
    category = v_cat, customer_id = v_cust, all_day = v_allday, starts_at = v_start, ends_at = v_end, attendees = v_att,
    rrule = v_rrule, exdates = v_ex, crew = coalesce(p_crew, old.crew), updated_at = now()
    where id = eid returning * into e;
  return e;
end $$;

-- 쓰기: save · delete · skip(이 회차만 지우기) · split(이 일정 및 이후)
create or replace function public.office_event_write(p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); v_crew text; e public.office_events%rowtype; eid uuid; d date; nxt jsonb; until date; start_day date;
begin
  if who is null then raise exception 'calendar_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'calendar_invalid'; end if;
  v_crew := btrim(p_data->>'crew'); -- 에이전트 도구가 붙인다. 있으면 주인 일정만 고칠 수 있다
  if v_crew is not null and length(v_crew) not between 1 and 100 then raise exception 'calendar_invalid'; end if;

  if p_action = 'save' then
    e := public.office_event_save(p_data, who, v_crew, null);
    return jsonb_build_object('ok', true, 'event', public.office_event_json(e, who));
  end if;
  if p_action not in ('delete', 'skip', 'split') then raise exception 'calendar_invalid'; end if;

  eid := public.office_event_in(p_data->>'id', 'uuid')::uuid;
  if eid is null then raise exception 'calendar_invalid'; end if;
  select * into e from public.office_events where id = eid for update;
  if e.id is null then raise exception 'calendar_not_found'; end if;
  if not public.office_event_can_edit(e, who, v_crew) then raise exception 'calendar_forbidden' using errcode = '42501'; end if;

  if p_action = 'delete' then
    delete from public.office_events where id = eid; -- 부모를 지우면 회차 수정 행도 같이(cascade)
    return jsonb_build_object('ok', true, 'id', eid);
  end if;

  if e.rrule is null or e.parent_id is not null then raise exception 'calendar_invalid'; end if;
  d := public.office_event_in(p_data->>'day', 'date')::date;
  if d is null then raise exception 'calendar_invalid'; end if;
  start_day := (e.starts_at at time zone 'Asia/Seoul')::date;
  until := public.office_event_until(e.rrule);

  if p_action = 'skip' then
    if d < start_day or d > until then raise exception 'calendar_invalid'; end if;
    delete from public.office_events where parent_id = eid and recur_on = d; -- 그 회차를 따로 고쳐 둔 행도 같이 지운다
    if not (d = any(e.exdates)) then
      if cardinality(e.exdates) >= 1000 then raise exception 'calendar_limit'; end if;
      update public.office_events set exdates = (select array_agg(x order by x) from unnest(e.exdates || d) x), updated_at = now()
        where id = eid returning * into e;
    end if;
    return jsonb_build_object('ok', true, 'event', public.office_event_json(e, who));
  end if;

  -- split: 원래 행은 day 전날까지(첫 회차면 지움), 그 뒤는 next를 새 행으로. 한 트랜잭션
  nxt := p_data->'next';
  if jsonb_typeof(nxt) is distinct from 'object' then raise exception 'calendar_invalid'; end if;
  nxt := nxt - 'parent_id' - 'recur_on' - 'crew';
  if nullif(nxt->>'id', '') is null then nxt := nxt || jsonb_build_object('id', gen_random_uuid()); end if;
  if nxt->>'id' = eid::text or exists (select 1 from public.office_events where id = (nxt->>'id')::uuid) then raise exception 'calendar_invalid'; end if;
  if e.owner <> who and public.office_event_in(nxt->>'org_id', 'uuid')::uuid is distinct from e.org_id then
    raise exception 'calendar_forbidden' using errcode = '42501'; -- 관리자가 남의 일정을 나눌 때는 같은 공간에만
  end if;
  if d <= start_day then
    delete from public.office_events where id = eid;
  else
    delete from public.office_events where parent_id = eid and recur_on >= d; -- 이후 회차를 따로 고친 행은 새 일정이 대신한다
    update public.office_events set
      rrule = regexp_replace(rrule, ';UNTIL=[0-9]{8}$', '') || ';UNTIL=' || to_char(least(coalesce(until, d - 1), d - 1), 'YYYYMMDD'),
      exdates = coalesce((select array_agg(x order by x) from unnest(exdates) x where x < d), '{}'), updated_at = now()
      where id = eid;
  end if;
  e := public.office_event_save(nxt, who, v_crew, e.owner);
  return jsonb_build_object('ok', true, 'event', public.office_event_json(e, who));
exception
  when check_violation or not_null_violation or foreign_key_violation or unique_violation or invalid_text_representation then
    raise exception 'calendar_invalid'; -- 원시 오류 대신(같은 이관 표지 중복, 형식 오류 등)
end $$;

-- 읽기: 호출자에게 보이는 일정(개인 + 멤버인 조직의 공개·내가 주인·내가 참석자) 중 기간에 걸치는 것. 반복 전개는 클라이언트가 한다
create or replace function public.office_event_list(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid();
begin
  if who is null then raise exception 'calendar_forbidden' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then raise exception 'calendar_invalid'; end if;
  return jsonb_build_object(
    'events', coalesce((select jsonb_agg(public.office_event_json(e, who) order by e.starts_at, e.id)
      from public.office_events e where e.id in (select e.id from public.office_events e
        where ((e.org_id is null and e.owner = who)
            or (e.org_id is not null and public.office_event_role(e.org_id, who) is not null
                and (e.visibility = 'org' or e.owner = who or who = any(e.attendees))))
          and e.starts_at < p_to
          and case when e.rrule is null then e.ends_at > p_from
                   -- 반복: 마지막 가능한 회차(UNTIL 날짜의 시작 시각 + 회차 길이)가 범위 시작보다 늦게 끝나면 포함 — UNTIL 당일에 시작해 다음 날까지 가는 회차
                   else coalesce(((public.office_event_until(e.rrule) + (e.starts_at at time zone 'Asia/Seoul')::time) at time zone 'Asia/Seoul')
                                 + (e.ends_at - e.starts_at) > p_from, true) end
        order by e.starts_at, e.id limit 3000)), '[]'::jsonb), -- ponytail: 화면용 3000건, 넘으면 기간을 줄인다
    'orgs', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'role', m.role) order by m.joined_at, o.id)
      from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
      where m.user_id = who and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null), '[]'::jsonb));
end $$;

revoke all on function public.office_event_role(uuid, uuid), public.office_event_can_edit(public.office_events, uuid, text),
  public.office_event_in(text, text), public.office_event_until(text), public.office_event_json(public.office_events, uuid),
  public.office_event_save(jsonb, uuid, text, uuid), public.office_event_write(text, jsonb), public.office_event_list(timestamptz, timestamptz)
  from public, anon;
revoke all on function public.office_event_role(uuid, uuid), public.office_event_can_edit(public.office_events, uuid, text),
  public.office_event_in(text, text), public.office_event_until(text), public.office_event_json(public.office_events, uuid),
  public.office_event_save(jsonb, uuid, text, uuid) from authenticated; -- 내부용(정의자 함수 안에서만)
grant execute on function public.office_event_write(text, jsonb), public.office_event_list(timestamptz, timestamptz) to authenticated;
