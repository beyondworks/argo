-- 회사 정보·직원 명부·평가 레포트(트랙 C, 유건 10/2 "인트라넷 기능 전부 오피스로, 뒤처지는 곳 없이").
-- 인트라넷 원본: 회사정보(Notion DB) · 직원(board.db, CLI 토큰) · 인사고과 레포트(Notion DB, 에이전트가 작성).
-- 오피스가 원본이 된다 — Notion 연동 코드는 두지 않고, 일회 이관은 scripts/notion-migrate.mjs가 아래 함수로만 쓴다.
--
-- · 조직 단위(여러 회사가 쓰는 제품). 표는 정책 없이 함수로만 읽고 쓴다(office_tasks·office_events와 같은 방식).
-- · 회사 정보: 조직 멤버(손님 제외)는 읽고, 관리자(owner·admin)만 고친다. 고치기·지우기 전 모습은 이력에 남고 지운 항목은 되살릴 수 있다.
--   견적·계약 서식(트랙 A)은 이 값을 읽는다 — 잘 알려진 항목은 key(상호·대표자·사업자등록번호…)로 찾는다.
-- · 직원 명부: 멤버는 이름·직무·부서·연락처·재직 상태를 보고, 메모는 관리자만 본다. 고치기는 관리자만.
--   계정이 있는 멤버는 명부 행이 없어도 목록에 나온다. 인트라넷의 CLI 토큰은 두지 않는다 — 직원마다 자기 계정으로 로그인한다.
-- · 평가 레포트: 성과 기록(office_perf_*)의 규칙을 깨지 않는다.
--   - 추가만 한다. 고치기는 새 판(replaces)으로 한 번씩, 원래 판은 남는다. 지우기 없음.
--   - 사람 대상 레포트는 그 사람 본인과 관리자만 본다. 크루(에이전트) 대상은 관리자만 본다.
--   - 근거(basis)는 그 사람이 공유한 월말·연말 사본(office_perf_reviews.snapshot)의 합계만 붙인다 — 공유 안 한 개인 기록은 관리자에게 열리지 않는다.
-- · 부하: 읽기는 화면을 열 때 1회, 쓰기는 사람이 저장을 누르거나 크루 도구·이관 스크립트가 부를 때만. 주기 호출·폴링 없음. 같은 값은 다시 쓰지 않는다.
-- · 누적·보존: 회사 정보 300개·명부 2,000명·평가 연 5,000건(조직당) 상한. 이력은 조직당 최근 200건만 남긴다(쓸 때 정리).
--   퇴사 3년 뒤 정리(근로기준법 3년 — 성과 기록 office_perf_purge와 같은 기준)는 office_company_purge(시험 실행 기본) — 자동 예약은 운영 적용 때 건수 확인·승인 뒤.

-- ── 회사 정보 ──
create table if not exists public.office_company_items (
  id uuid primary key,                                            -- 브라우저·이관 스크립트가 만든 id(두 번 눌려도 한 건)
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  key text check (key is null or key in ('name', 'reg_name', 'ceo', 'biz_no', 'corp_no', 'open_date', 'address', 'biz_type', 'biz_item',
    'manager', 'phone', 'fax', 'email', 'tax_email', 'website', 'seal', 'logo')),   -- 서식이 찾는 잘 알려진 항목. 그 밖은 null(자유 항목)
  category text not null default 'other' check (category in ('basic', 'bank', 'contact', 'tax', 'other')),
  label text not null check (length(btrim(label)) between 1 and 100),
  value text not null default '' check (length(value) <= case when key in ('seal', 'logo') then 200000 else 2000 end), -- 도장·로고는 그림(data:image 또는 https 주소)
  notes text not null default '' check (length(notes) <= 2000),
  position integer not null default 0 check (position between 0 and 100000),
  redacted boolean not null default false,                         -- 화면에서 처음부터 가림(계좌·사업자번호 등) — 값은 그대로
  source text check (source is null or length(source) between 1 and 40),
  source_id text check (source_id is null or length(source_id) between 1 and 200),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source, source_id),
  check ((source is null) = (source_id is null))
);
create unique index if not exists office_company_items_key on public.office_company_items(org_id, key) where key is not null;
create index if not exists office_company_items_org on public.office_company_items(org_id, category, position);

create table if not exists public.office_company_history (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  item_id uuid not null,
  kind text not null check (kind in ('update', 'delete')),
  before jsonb not null check (octet_length(before::text) <= 8000),
  actor uuid not null,
  at timestamptz not null default clock_timestamp()
);
create index if not exists office_company_history_org on public.office_company_history(org_id, id desc);

-- ── 직원 명부 ──
create table if not exists public.office_employees (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  user_id uuid,                                                   -- 연결한 계정(그 조직 멤버). 계정 없이 이름만 둘 수도 있다(인트라넷과 같음)
  name text not null check (length(btrim(name)) between 1 and 100),
  title text not null default '' check (length(title) <= 100),    -- 직무·역할(인트라넷 '역할')
  department text not null default '' check (length(department) <= 100),
  email text not null default '' check (length(email) <= 200),
  phone text not null default '' check (length(phone) <= 50),
  agent text not null default '' check (length(agent) <= 100),    -- 이 사람이 쓰는 에이전트(인트라넷 '에이전트': Claude Code·Codex·Hermes·크루 이름)
  joined_on date, left_on date,
  notes text not null default '' check (length(notes) <= 2000),   -- 관리자만 본다
  source text check (source is null or length(source) between 1 and 40),
  source_id text check (source_id is null or length(source_id) between 1 and 200),
  created_by uuid, updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (source, source_id),
  check ((source is null) = (source_id is null)),
  check (left_on is null or joined_on is null or left_on >= joined_on)
);
create unique index if not exists office_employees_user on public.office_employees(org_id, user_id) where user_id is not null;
create index if not exists office_employees_org on public.office_employees(org_id, name);

-- ── 평가 레포트(구 인사고과) ──
create table if not exists public.office_perf_evals (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('person', 'crew')),
  subject_user uuid,                                              -- 사람 대상의 계정. 이관한 레포트 중 계정을 못 찾은 사람은 null(관리자만 본다)
  subject_name text not null check (length(btrim(subject_name)) between 1 and 100),
  subject_type text not null check (subject_type in ('ceo', 'staff', 'agent')), -- 인트라넷 대상유형(대표·직원·에이전트)
  scope text not null check (scope in ('week', 'month', 'year')),
  period_from date not null,
  period_to date not null,
  period_label text not null default '' check (length(period_label) <= 100), -- 이관 원본의 기간 글(비우면 화면이 날짜로 쓴다)
  title text not null check (length(btrim(title)) between 1 and 200),
  performance smallint check (performance between 0 and 100),
  quality smallint check (quality between 0 and 100),
  productivity smallint check (productivity between 0 and 100),
  expertise smallint check (expertise between 0 and 100),
  collaboration smallint check (collaboration between 0 and 100),
  total smallint check (total between 0 and 100),
  review text not null default '' check (length(review) <= 20000),        -- 총평(마크다운)
  work text not null default '' check (length(work) <= 20000),            -- 기간 업무내용
  achievements text not null default '' check (length(achievements) <= 20000),
  basis jsonb check (basis is null or octet_length(basis::text) <= 20000), -- 쓸 때 붙인 근거(공유된 성과 기록 사본의 합계)
  author_kind text not null check (author_kind in ('person', 'crew', 'import')),
  author_user uuid not null,                                      -- 부른 계정(크루 도구는 크루 주인의 계정)
  author_name text not null default '' check (length(author_name) <= 100),
  replaces uuid references public.office_perf_evals(id),
  source text check (source is null or length(source) between 1 and 40),
  source_id text check (source_id is null or length(source_id) between 1 and 200),
  created_at timestamptz not null default clock_timestamp(),
  unique (source, source_id),
  check ((source is null) = (source_id is null)),
  check (period_to >= period_from and period_to - period_from <= 366),
  check ((subject_kind = 'crew') = (subject_type = 'agent')),
  check (subject_kind = 'person' or subject_user is null)
);
create unique index if not exists office_perf_evals_replaced on public.office_perf_evals(replaces) where replaces is not null; -- 한 판은 한 번만 새 판으로
create index if not exists office_perf_evals_org on public.office_perf_evals(org_id, period_from desc);
create index if not exists office_perf_evals_subject on public.office_perf_evals(org_id, subject_user) where subject_user is not null;

alter table public.office_company_items enable row level security;   -- 정책 없음: 모두 함수로만
alter table public.office_company_history enable row level security;
alter table public.office_employees enable row level security;
alter table public.office_perf_evals enable row level security;
revoke all on public.office_company_items, public.office_company_history, public.office_employees, public.office_perf_evals from public, anon, authenticated;

-- 조직 안 표시 이름(office_org_people과 같은 기준)
create or replace function public.office_member_name(p_org uuid, p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), '?')
  from auth.users u left join public.msgr_profiles p on p.user_id = u.id left join public.msgr_org_members m on m.org_id = p_org and m.user_id = u.id
  where u.id = p_user;
$$;

-- 입력 한 칸: 글(길이 상한·앞뒤 공백 정리), 날짜(YYYY-MM-DD), uuid. 형식이 틀리면 company_input
create or replace function public.office_company_in(p_data jsonb, p_key text, p_kind text, p_max integer default 2000) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare v text := p_data->>p_key;
begin
  if jsonb_typeof(p_data->p_key) not in ('string', 'number', 'boolean', 'null') and p_data ? p_key then raise exception 'company_input'; end if;
  if v is null or btrim(v) = '' then return null; end if;
  if p_kind = 'text' then
    if length(v) > p_max then raise exception 'company_input'; end if;
    return btrim(v);
  elsif p_kind = 'date' then
    if v !~ '^\d{4}-\d{2}-\d{2}$' or v::date not between date '1900-01-01' and date '2100-12-31' then raise exception 'company_input'; end if;
    return v::date::text;
  end if;
  return v::uuid::text;
exception when others then raise exception 'company_input';
end $$;

create or replace function public.office_company_item_json(c public.office_company_items) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('id', c.id, 'key', c.key, 'category', c.category, 'label', c.label, 'value', c.value, 'notes', c.notes,
    'position', c.position, 'redacted', c.redacted, 'updated_at', c.updated_at, 'source', c.source);
$$;

-- 이력에 남길 모습 — 도장·로고 그림 본문은 이력에 싣지 않는다(이력 200건 × 그림이 쌓이지 않게. 되살리면 그림은 다시 올린다)
create or replace function public.office_company_history_json(c public.office_company_items) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select public.office_company_item_json(c) || case when c.key in ('seal', 'logo') then jsonb_build_object('value', '') else '{}'::jsonb end;
$$;

-- 읽기: 멤버면 항목 전부. 관리자에게는 되살릴 수 있는 최근 지운 항목도
create or replace function public.office_company_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text := public.office_perf_role(p_org);
begin
  if p_org is null or r is null then raise exception 'company_forbidden' using errcode = '42501'; end if;
  return jsonb_build_object('role', r,
    'items', coalesce((select jsonb_agg(public.office_company_item_json(c)
      order by array_position(array['basic', 'bank', 'contact', 'tax', 'other'], c.category), c.position, c.label, c.id)
      from public.office_company_items c where c.org_id = p_org), '[]'::jsonb),
    'deleted', case when r = 'manager' then coalesce((select jsonb_agg(jsonb_build_object('history_id', h.id, 'label', h.before->>'label',
        'category', h.before->>'category', 'at', h.at) order by h.id desc)
      from (select * from public.office_company_history h where h.org_id = p_org and h.kind = 'delete'
        and not exists (select 1 from public.office_company_items c where c.id = h.item_id) order by h.id desc limit 20) h), '[]'::jsonb) else '[]'::jsonb end);
end $$;

-- 쓰기(관리자만): item.save · item.delete · item.restore · items.order
create or replace function public.office_company_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); iid uuid; old public.office_company_items%rowtype; c public.office_company_items%rowtype;
  v_key text; v_cat text; v_label text; v_value text; v_notes text; v_pos integer; v_red boolean; h public.office_company_history%rowtype; b jsonb; n integer;
begin
  if p_org is null or public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'company_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 260000 then raise exception 'company_input'; end if;

  if p_action = 'items.order' then -- 한 분류 안의 순서: 바뀐 항목만 쓴다
    if jsonb_typeof(p_data->'ids') is distinct from 'array' or jsonb_array_length(p_data->'ids') > 300 then raise exception 'company_input'; end if;
    update public.office_company_items ci set position = s.i - 1, updated_at = clock_timestamp(), updated_by = who
      from (select public.office_company_in(jsonb_build_object('v', x), 'v', 'uuid')::uuid item, i from jsonb_array_elements_text(p_data->'ids') with ordinality a(x, i)) s
      where ci.id = s.item and ci.org_id = p_org and ci.position is distinct from s.i - 1;
    return jsonb_build_object('ok', true);
  end if;

  if p_action = 'item.restore' then
    select * into h from public.office_company_history where id = (p_data->>'history_id')::bigint and org_id = p_org and kind = 'delete';
    if h.id is null then raise exception 'company_not_found'; end if;
    if exists (select 1 from public.office_company_items where id = h.item_id) then raise exception 'company_conflict'; end if;
    b := h.before;
    v_key := b->>'key';
    if v_key is not null and exists (select 1 from public.office_company_items where org_id = p_org and key = v_key) then v_key := null; end if; -- 같은 항목을 그새 다시 만들었으면 자유 항목으로
    insert into public.office_company_items(id, org_id, key, category, label, value, notes, position, redacted, created_by, updated_by)
      values (h.item_id, p_org, v_key, b->>'category', b->>'label', coalesce(b->>'value', ''), coalesce(b->>'notes', ''), coalesce((b->>'position')::int, 0),
        coalesce((b->>'redacted')::boolean, false), who, who) returning * into c;
    return jsonb_build_object('ok', true, 'item', public.office_company_item_json(c));
  end if;

  iid := public.office_company_in(p_data, 'id', 'uuid')::uuid;
  if iid is null then raise exception 'company_input'; end if;
  select * into old from public.office_company_items where id = iid for update;
  if old.id is not null and old.org_id <> p_org then raise exception 'company_conflict'; end if;

  if p_action = 'item.delete' then
    if old.id is null then return jsonb_build_object('ok', true, 'id', iid); end if; -- 이미 지웠으면 그대로(두 번 눌려도 한 번)
    insert into public.office_company_history(org_id, item_id, kind, before, actor) values (p_org, iid, 'delete', public.office_company_history_json(old), who);
    delete from public.office_company_items where id = iid;
    delete from public.office_company_history where org_id = p_org and id <= (select id from public.office_company_history where org_id = p_org order by id desc offset 200 limit 1);
    return jsonb_build_object('ok', true, 'id', iid);
  end if;
  if p_action <> 'item.save' then raise exception 'company_input'; end if;

  v_label := public.office_company_in(p_data, 'label', 'text', 100);
  v_key := public.office_company_in(p_data, 'key', 'text', 20);
  v_value := coalesce(public.office_company_in(p_data, 'value', 'text', case when v_key in ('seal', 'logo') then 200000 else 2000 end), '');
  if v_key in ('seal', 'logo') and v_value <> '' and v_value !~ '^(data:image/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+|https://\S+)$' then raise exception 'company_input'; end if; -- 그림만
  v_notes := coalesce(public.office_company_in(p_data, 'notes', 'text', 2000), '');
  v_cat := coalesce(public.office_company_in(p_data, 'category', 'text', 20), 'other');
  if jsonb_typeof(p_data->'redacted') not in ('boolean', 'null') and p_data ? 'redacted' then raise exception 'company_input'; end if;
  v_red := coalesce((p_data->>'redacted')::boolean, old.redacted, v_cat = 'bank' or coalesce(v_key in ('biz_no', 'corp_no'), false));
  if jsonb_typeof(p_data->'position') not in ('number', 'null') and p_data ? 'position' then raise exception 'company_input'; end if;
  v_pos := coalesce((p_data->>'position')::int, old.position,
    (select coalesce(max(x.position) + 1, 0) from public.office_company_items x where x.org_id = p_org and x.category = v_cat));
  if v_label is null or v_cat not in ('basic', 'bank', 'contact', 'tax', 'other') or v_pos not between 0 and 100000
     or (v_key is not null and v_key not in ('name', 'reg_name', 'ceo', 'biz_no', 'corp_no', 'open_date', 'address', 'biz_type', 'biz_item', 'manager', 'phone', 'fax', 'email', 'tax_email', 'website', 'seal', 'logo')) then
    raise exception 'company_input';
  end if;
  if v_key is not null and exists (select 1 from public.office_company_items where org_id = p_org and key = v_key and id <> iid) then raise exception 'company_key'; end if;

  if old.id is null then
    perform pg_advisory_xact_lock(hashtextextended('office-company:' || p_org, 0));
    if (select count(*) from public.office_company_items where org_id = p_org) >= 300 then raise exception 'company_limit'; end if;
    insert into public.office_company_items(id, org_id, key, category, label, value, notes, position, redacted, source, source_id, created_by, updated_by)
      values (iid, p_org, v_key, v_cat, v_label, v_value, v_notes, v_pos, v_red,
        public.office_company_in(p_data, 'source', 'text', 40), public.office_company_in(p_data, 'source_id', 'text', 200), who, who) returning * into c;
    return jsonb_build_object('ok', true, 'item', public.office_company_item_json(c));
  end if;
  if (old.key, old.category, old.label, old.value, old.notes, old.position, old.redacted) is not distinct from (v_key, v_cat, v_label, v_value, v_notes, v_pos, v_red) then
    return jsonb_build_object('ok', true, 'item', public.office_company_item_json(old)); -- 같은 값은 다시 쓰지 않는다
  end if;
  insert into public.office_company_history(org_id, item_id, kind, before, actor) values (p_org, iid, 'update', public.office_company_history_json(old), who);
  update public.office_company_items set key = v_key, category = v_cat, label = v_label, value = v_value, notes = v_notes, position = v_pos, redacted = v_red,
    updated_by = who, updated_at = clock_timestamp() where id = iid returning * into c;
  delete from public.office_company_history where org_id = p_org and id <= (select id from public.office_company_history where org_id = p_org order by id desc offset 200 limit 1);
  return jsonb_build_object('ok', true, 'item', public.office_company_item_json(c));
exception
  when unique_violation then raise exception 'company_conflict';
  when check_violation or not_null_violation or invalid_text_representation then raise exception 'company_input';
end $$;

-- ── 직원 명부 ──
-- 읽기: 명부 행 + 명부에 없는 계정 멤버(손님 제외). 메모·계정 이메일은 관리자만
create or replace function public.office_people_read(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r text := public.office_perf_role(p_org); mgr boolean;
begin
  if p_org is null or r is null then raise exception 'company_forbidden' using errcode = '42501'; end if;
  mgr := r = 'manager';
  return jsonb_build_object('role', r, 'me', auth.uid(), 'people', coalesce((select jsonb_agg(x order by x->>'status' = 'left', x->>'name', x->>'id') from (
    select jsonb_build_object('id', e.id, 'user_id', e.user_id, 'name', e.name, 'title', e.title, 'department', e.department, 'email', e.email, 'phone', e.phone,
      'agent', e.agent, 'joined_on', e.joined_on, 'left_on', e.left_on, 'account_role', m.role,
      'status', case when e.left_on is not null and e.left_on <= public.office_perf_today() then 'left' when e.user_id is not null and (m.user_id is null or m.removed_at is not null) then 'left' else 'active' end,
      'notes', case when mgr then e.notes end, 'account_name', case when e.user_id is not null then public.office_member_name(p_org, e.user_id) end) x
    from public.office_employees e left join public.msgr_org_members m on m.org_id = e.org_id and m.user_id = e.user_id
    where e.org_id = p_org
    union all
    select jsonb_build_object('id', null, 'user_id', m.user_id, 'name', public.office_member_name(p_org, m.user_id), 'title', '', 'department', '',
      'email', case when mgr then coalesce(u.email, '') else '' end, 'phone', '', 'agent', '', 'joined_on', (m.joined_at at time zone 'Asia/Seoul')::date, 'left_on', null,
      'account_role', m.role, 'status', 'active', 'notes', null, 'account_name', null)
    from public.msgr_org_members m left join auth.users u on u.id = m.user_id
    where m.org_id = p_org and m.removed_at is null and m.role <> 'guest'
      and not exists (select 1 from public.office_employees e where e.org_id = p_org and e.user_id = m.user_id)) s), '[]'::jsonb));
end $$;

-- 쓰기(관리자만): person.save · person.delete
create or replace function public.office_people_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); pid uuid; old public.office_employees%rowtype; e public.office_employees%rowtype; v_user uuid; v_join date; v_left date; v_name text;
begin
  if p_org is null or public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'company_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'company_input'; end if;
  pid := public.office_company_in(p_data, 'id', 'uuid')::uuid;
  if pid is null then raise exception 'company_input'; end if;
  select * into old from public.office_employees where id = pid for update;
  if old.id is not null and old.org_id <> p_org then raise exception 'company_conflict'; end if;

  if p_action = 'person.delete' then
    delete from public.office_employees where id = pid and org_id = p_org;
    return jsonb_build_object('ok', true, 'id', pid);
  end if;
  if p_action <> 'person.save' then raise exception 'company_input'; end if;

  v_name := public.office_company_in(p_data, 'name', 'text', 100);
  v_user := public.office_company_in(p_data, 'user_id', 'uuid')::uuid;
  v_join := public.office_company_in(p_data, 'joined_on', 'date')::date;
  v_left := public.office_company_in(p_data, 'left_on', 'date')::date;
  if v_name is null or (v_left is not null and v_join is not null and v_left < v_join) then raise exception 'company_input'; end if;
  if v_user is not null and v_user is distinct from old.user_id and not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = v_user and role <> 'guest') then
    raise exception 'company_input'; -- 연결할 계정은 이 조직 멤버(이미 나간 사람은 원래 연결만 유지)
  end if;
  if old.id is null then
    perform pg_advisory_xact_lock(hashtextextended('office-people:' || p_org, 0));
    if (select count(*) from public.office_employees where org_id = p_org) >= 2000 then raise exception 'company_limit'; end if;
    insert into public.office_employees(id, org_id, user_id, name, title, department, email, phone, agent, joined_on, left_on, notes, source, source_id, created_by, updated_by)
      values (pid, p_org, v_user, v_name, coalesce(public.office_company_in(p_data, 'title', 'text', 100), ''), coalesce(public.office_company_in(p_data, 'department', 'text', 100), ''),
        coalesce(public.office_company_in(p_data, 'email', 'text', 200), ''), coalesce(public.office_company_in(p_data, 'phone', 'text', 50), ''),
        coalesce(public.office_company_in(p_data, 'agent', 'text', 100), ''), v_join, v_left, coalesce(public.office_company_in(p_data, 'notes', 'text', 2000), ''),
        public.office_company_in(p_data, 'source', 'text', 40), public.office_company_in(p_data, 'source_id', 'text', 200), who, who) returning * into e;
    return jsonb_build_object('ok', true, 'id', e.id);
  end if;
  e := old;
  e.user_id := v_user; e.name := v_name; e.joined_on := v_join; e.left_on := v_left;
  e.title := coalesce(public.office_company_in(p_data, 'title', 'text', 100), ''); e.department := coalesce(public.office_company_in(p_data, 'department', 'text', 100), '');
  e.email := coalesce(public.office_company_in(p_data, 'email', 'text', 200), ''); e.phone := coalesce(public.office_company_in(p_data, 'phone', 'text', 50), '');
  e.agent := coalesce(public.office_company_in(p_data, 'agent', 'text', 100), ''); e.notes := coalesce(public.office_company_in(p_data, 'notes', 'text', 2000), '');
  if (old.user_id, old.name, old.title, old.department, old.email, old.phone, old.agent, old.joined_on, old.left_on, old.notes)
     is not distinct from (e.user_id, e.name, e.title, e.department, e.email, e.phone, e.agent, e.joined_on, e.left_on, e.notes) then
    return jsonb_build_object('ok', true, 'id', pid);
  end if;
  update public.office_employees set user_id = e.user_id, name = e.name, title = e.title, department = e.department, email = e.email, phone = e.phone,
    agent = e.agent, joined_on = e.joined_on, left_on = e.left_on, notes = e.notes, updated_by = who, updated_at = clock_timestamp() where id = pid;
  return jsonb_build_object('ok', true, 'id', pid);
exception
  when unique_violation then raise exception 'company_conflict';
  when check_violation or not_null_violation or invalid_text_representation then raise exception 'company_input';
end $$;

-- ── 평가 레포트 ──
create or replace function public.office_perf_eval_json(e public.office_perf_evals) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select to_jsonb(e) - 'org_id' - 'author_user' - 'source_id'
    || jsonb_build_object('replaced_by', (select x.id from public.office_perf_evals x where x.replaces = e.id));
$$;

-- 읽기: 관리자는 조직의 레포트 전부, 멤버는 자기가 대상인 레포트만. 최근 기간 먼저 1,000건
create or replace function public.office_perf_eval_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); r text := public.office_perf_role(p_org);
begin
  if p_org is null or r is null then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  return jsonb_build_object('role', r, 'me', who, 'evals', coalesce((select jsonb_agg(public.office_perf_eval_json(e) order by e.period_from desc, e.created_at desc)
    from (select * from public.office_perf_evals e where e.org_id = p_org and (r = 'manager' or e.subject_user = who)
      order by e.period_from desc, e.created_at desc limit 1000) e), '[]'::jsonb));
end $$;

-- 쓰기(관리자만): eval.add(새 레포트 또는 replaces로 새 판). 크루 도구는 p_data.crew(크루 이름)를 붙인다. 이관은 source='notion'
create or replace function public.office_perf_eval_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); eid uuid; e public.office_perf_evals%rowtype; prev public.office_perf_evals%rowtype; ex public.office_perf_evals%rowtype;
  v_kind text; v_user uuid; v_name text; v_type text; v_scope text; v_from date; v_to date; v_src text; v_srcid text; v_crew text; v_at timestamptz;
  sc smallint[]; v_total smallint; k text; snap jsonb; rv public.office_perf_reviews%rowtype;
begin
  if p_org is null or public.office_perf_role(p_org) is distinct from 'manager' then raise exception 'perf_forbidden' using errcode = '42501'; end if;
  if p_action <> 'eval.add' or jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 80000 then raise exception 'perf_input'; end if;
  begin
    eid := (p_data->>'id')::uuid;
    v_src := nullif(btrim(p_data->>'source'), ''); v_srcid := nullif(btrim(p_data->>'source_id'), '');
    v_crew := nullif(btrim(p_data->>'crew'), '');
    prev.id := nullif(p_data->>'replaces', '')::uuid;
  exception when others then raise exception 'perf_input'; end;
  if eid is null or (v_src is null) <> (v_srcid is null) or length(v_crew) > 100 then raise exception 'perf_input'; end if;
  select * into ex from public.office_perf_evals where id = eid;
  if ex.id is not null then
    if ex.org_id = p_org and ex.author_user = who then return jsonb_build_object('ok', true, 'eval', public.office_perf_eval_json(ex)); end if; -- 같은 요청이 두 번
    raise exception 'perf_conflict';
  end if;
  if v_src is not null then
    select * into ex from public.office_perf_evals where source = v_src and source_id = v_srcid;
    if ex.id is not null then
      if ex.org_id = p_org then return jsonb_build_object('ok', true, 'eval', public.office_perf_eval_json(ex)); end if; -- 이관을 다시 돌려도 한 건
      raise exception 'perf_conflict';
    end if;
  end if;

  if prev.id is not null then -- 새 판: 대상·범위·기간은 원래 판을 따른다
    select * into prev from public.office_perf_evals where id = prev.id and org_id = p_org for update;
    if prev.id is null then raise exception 'perf_review'; end if;
    if exists (select 1 from public.office_perf_evals where replaces = prev.id) then raise exception 'perf_conflict'; end if;
    v_kind := prev.subject_kind; v_user := prev.subject_user; v_name := prev.subject_name; v_type := prev.subject_type;
    v_scope := prev.scope; v_from := prev.period_from; v_to := prev.period_to;
  else
    v_kind := p_data->>'subject_kind'; v_scope := p_data->>'scope';
    begin v_from := (p_data->>'from')::date; v_to := (p_data->>'to')::date; v_user := nullif(p_data->>'subject_user', '')::uuid;
    exception when others then raise exception 'perf_input'; end;
    if v_kind not in ('person', 'crew') or v_scope not in ('week', 'month', 'year') or v_from is null or v_to is null or v_to < v_from or v_to - v_from > 366 then raise exception 'perf_input'; end if;
    if v_src is null and not ( -- 화면·크루 도구는 정해진 기간만(주 = 월~일, 월 = 1일~말일, 연 = 1/1~12/31). 이관은 원본 기간 그대로
        (v_scope = 'week' and extract(isodow from v_from) = 1 and v_to = v_from + 6)
        or (v_scope = 'month' and extract(day from v_from) = 1 and v_to = (v_from + interval '1 month' - interval '1 day')::date)
        or (v_scope = 'year' and v_from = make_date(extract(year from v_from)::int, 1, 1) and v_to = make_date(extract(year from v_from)::int, 12, 31))) then
      raise exception 'perf_period';
    end if;
    if v_kind = 'crew' then
      v_user := null; v_type := 'agent'; v_name := btrim(coalesce(p_data->>'subject_name', ''));
    else
      v_type := coalesce(nullif(p_data->>'subject_type', ''), 'staff');
      if v_type not in ('ceo', 'staff') then raise exception 'perf_input'; end if;
      if v_user is not null then
        if not exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = v_user and role <> 'guest' and (removed_at is null or v_src is not null)) then raise exception 'perf_input'; end if;
        v_name := coalesce(nullif(btrim(p_data->>'subject_name'), ''), public.office_member_name(p_org, v_user));
      elsif v_src is null then
        raise exception 'perf_input'; -- 계정 없는 사람 대상은 이관에서만(누가 볼지 정할 수 없다)
      else
        v_name := btrim(coalesce(p_data->>'subject_name', ''));
      end if;
    end if;
  end if;

  -- 점수: 0~100 정수. 종합점수를 비우면 준 항목의 평균
  sc := array[]::smallint[];
  foreach k in array array['performance', 'quality', 'productivity', 'expertise', 'collaboration', 'total'] loop
    if jsonb_typeof(p_data->k) not in ('number', 'null') and p_data ? k then raise exception 'perf_input'; end if;
    if (p_data->>k) is not null and ((p_data->>k)::numeric <> round((p_data->>k)::numeric) or (p_data->>k)::numeric not between 0 and 100) then raise exception 'perf_input'; end if;
    sc := sc || (p_data->>k)::smallint;
  end loop;
  v_total := coalesce(sc[6], (select round(avg(x))::smallint from unnest(sc[1:5]) x));

  -- 근거: 그 사람이 공유한 같은 기간 사본(월말·연말)의 합계만. 공유 전이면 비운다(본인만 보기 규칙)
  if v_user is not null and v_scope in ('month', 'year') then
    select * into rv from public.office_perf_reviews where org_id = p_org and user_id = v_user and status in ('shared', 'done')
      and period = case v_scope when 'month' then to_char(v_from, 'YYYY-MM') else to_char(v_from, 'YYYY') end
      and v_from = (public.office_perf_bounds(period)).lo and v_to = (public.office_perf_bounds(period)).hi;
    if rv.id is not null then snap := jsonb_build_object('kind', 'review', 'period', rv.period, 'status', rv.status, 'shared_at', rv.shared_at, 'totals', rv.snapshot->'totals'); end if;
  end if;

  v_at := clock_timestamp();
  if v_src is not null and nullif(p_data->>'created_at', '') is not null then -- 이관: 원본 작성 시각(미래는 거절)
    begin v_at := (p_data->>'created_at')::timestamptz; exception when others then raise exception 'perf_input'; end;
    if v_at > clock_timestamp() + interval '1 minute' then raise exception 'perf_input'; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-perf-eval:' || p_org, 0));
  if (select count(*) from public.office_perf_evals where org_id = p_org and created_at > now() - interval '1 year') >= 5000 then raise exception 'perf_limit'; end if;
  insert into public.office_perf_evals(id, org_id, subject_kind, subject_user, subject_name, subject_type, scope, period_from, period_to, period_label, title,
    performance, quality, productivity, expertise, collaboration, total, review, work, achievements, basis, author_kind, author_user, author_name, replaces, source, source_id, created_at)
  values (eid, p_org, v_kind, v_user, v_name, v_type, v_scope, v_from, v_to, left(coalesce(btrim(p_data->>'period_label'), ''), 100),
    btrim(coalesce(p_data->>'title', '')), sc[1], sc[2], sc[3], sc[4], sc[5], v_total,
    coalesce(p_data->>'review', ''), coalesce(p_data->>'work', ''), coalesce(p_data->>'achievements', ''), snap,
    case when v_src is not null then 'import' when v_crew is not null then 'crew' else 'person' end, who,
    left(case when v_src is not null then coalesce(btrim(p_data->>'author_name'), '') when v_crew is not null then v_crew else public.office_member_name(p_org, who) end, 100),
    prev.id, v_src, v_srcid, v_at) returning * into e;
  return jsonb_build_object('ok', true, 'eval', public.office_perf_eval_json(e));
exception
  when unique_violation then raise exception 'perf_conflict';
  when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range then raise exception 'perf_input';
end $$;

-- ── 이관 전용: 할 일 한 건(Notion 업무보드 → 오피스 할 일) ──
-- task.done은 끝낸 시각을 지금으로 찍어 옛 업무가 오늘 실적으로 잡힌다 — 이관은 원본의 끝낸 날짜를 그대로 둔다.
-- 부른 사람 자신에게 맡긴 일만, source.kind='notion'만. 같은 id로 다시 부르면 한 건(재실행 안전).
create or replace function public.office_task_import(p_org uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); sc text; tid uuid; t public.office_tasks%rowtype; v_title text; v_note text; v_due date; v_done timestamptz; v_created timestamptz;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 20000 then raise exception 'task_input'; end if;
  sc := public.office_business_scope(p_org, false);
  if jsonb_typeof(p_data->'source') is distinct from 'object' or p_data->'source'->>'kind' is distinct from 'notion'
     or length(coalesce(p_data->'source'->>'id', '')) not between 1 and 200 then raise exception 'task_input'; end if;
  begin
    tid := (p_data->>'id')::uuid;
    v_due := nullif(p_data->>'due_on', '')::date;
    v_done := nullif(p_data->>'done_at', '')::timestamptz;
    v_created := coalesce(nullif(p_data->>'created_at', '')::timestamptz, clock_timestamp());
  exception when others then raise exception 'task_input'; end;
  v_title := btrim(coalesce(p_data->>'title', '')); v_note := coalesce(p_data->>'note', '');
  if tid is null or length(v_title) not between 1 and 200 or length(v_note) > 4000 or v_done > clock_timestamp() or v_created > clock_timestamp() + interval '1 minute'
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then raise exception 'task_input'; end if;
  select * into t from public.office_tasks where id = tid;
  if t.id is not null then
    if t.scope = sc and t.created_by = who and t.source->>'id' = p_data->'source'->>'id' then return to_jsonb(t) - 'scope'; end if;
    raise exception 'task_conflict';
  end if;
  if exists (select 1 from public.office_tasks x where x.scope = sc and x.source->>'kind' = 'notion' and x.source->>'id' = p_data->'source'->>'id') then
    select * into t from public.office_tasks x where x.scope = sc and x.source->>'kind' = 'notion' and x.source->>'id' = p_data->'source'->>'id' limit 1;
    return to_jsonb(t) - 'scope'; -- 같은 원본은 한 번만
  end if;
  perform pg_advisory_xact_lock(hashtextextended('office-task-limit:' || who, 0));
  if (select count(*) from public.office_tasks x where x.scope = sc and x.created_by = who and x.created_at > now() - interval '1 year') >= 5000 then raise exception 'task_limit'; end if;
  insert into public.office_tasks(id, scope, title, note, due_on, assignee, created_by, created_at, done_at, source)
    values (tid, sc, v_title, v_note, v_due, who, who, v_created, v_done, jsonb_build_object('kind', 'notion', 'id', p_data->'source'->>'id')) returning * into t;
  insert into public.office_task_events(task_id, kind, actor, at, to_value) values (tid, 'create', who, v_created, v_due::text);
  if v_done is not null then insert into public.office_task_events(task_id, kind, actor, at) values (tid, 'done', who, v_done); end if;
  return to_jsonb(t) - 'scope';
end $$;

-- 퇴사 3년 뒤 정리(시험 실행 기본): 나간 지 3년 지난 사람이 대상인 평가 레포트, 퇴사일이 3년 지난 명부 행
create or replace function public.office_company_purge(p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n_evals bigint; n_people bigint;
begin
  select count(*) into n_evals from public.office_perf_evals e join public.msgr_org_members m on m.org_id = e.org_id and m.user_id = e.subject_user
    where m.removed_at < now() - interval '3 years';
  select count(*) into n_people from public.office_employees where left_on < public.office_perf_today() - interval '3 years';
  if not p_dry then
    update public.office_perf_evals x set replaces = null where replaces in (select e.id from public.office_perf_evals e join public.msgr_org_members m
      on m.org_id = e.org_id and m.user_id = e.subject_user where m.removed_at < now() - interval '3 years');
    delete from public.office_perf_evals e using public.msgr_org_members m where m.org_id = e.org_id and m.user_id = e.subject_user and m.removed_at < now() - interval '3 years';
    delete from public.office_employees where left_on < public.office_perf_today() - interval '3 years';
  end if;
  return jsonb_build_object('dry', p_dry, 'evals', n_evals, 'people', n_people);
end $$;

revoke all on function public.office_member_name(uuid, uuid), public.office_company_in(jsonb, text, text, integer), public.office_company_item_json(public.office_company_items), public.office_company_history_json(public.office_company_items),
  public.office_perf_eval_json(public.office_perf_evals), public.office_company_purge(boolean) from public, anon, authenticated;
revoke all on function public.office_company_read(uuid), public.office_company_write(uuid, text, jsonb), public.office_people_read(uuid), public.office_people_write(uuid, text, jsonb),
  public.office_perf_eval_list(uuid), public.office_perf_eval_write(uuid, text, jsonb), public.office_task_import(uuid, jsonb) from public, anon;
grant execute on function public.office_company_read(uuid), public.office_company_write(uuid, text, jsonb), public.office_people_read(uuid), public.office_people_write(uuid, text, jsonb),
  public.office_perf_eval_list(uuid), public.office_perf_eval_write(uuid, text, jsonb), public.office_task_import(uuid, jsonb) to authenticated;
revoke all on sequence public.office_company_history_id_seq from anon, authenticated;
