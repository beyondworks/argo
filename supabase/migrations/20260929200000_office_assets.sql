-- 노하우(스킬)·업무 세트(하네스) 4단계(유건 9/29): 일을 할수록 쌓여 개인과 회사의 자산이 된다.
-- · 개인 노하우 = 사람에게 속한다(scope 'u:<사람>') — 조직을 옮기거나 퇴사해도 본인 것. 회사 노하우 = 조직에 속한다(scope 'o:<조직>').
--   직원이 "회사 노하우로 올리기"를 요청하고 관리자가 승인하면 회사 쪽에 사본이 생긴다(개인 것은 그대로).
-- · 고칠 때마다 버전이 남는다(office_asset_versions). 지우지 않고 보관만 한다. 쓸 때마다 사용 횟수를 센다.
-- · 업무 세트 = 노하우 여러 개 + 쓰는 도구 + 끝나기 전 점검 목록(spec). 크루에게 일을 맡길 때 고르면 그 내용이 글에 실린다.
-- · 후보(AI 없음): 최근 180일에 내가 끝낸 할 일 제목에서 거래처 이름·날짜·숫자·문장부호를 빼고 같은 것이 3번 이상.
-- · 부하: 쓰기는 사람이 누를 때와 크루에게 맡길 때(세트 1 + 노하우 N행)만. 후보는 목록을 열 때 계산(저장 안 함).

create table if not exists public.office_assets (
  id uuid primary key,
  scope text not null check (scope ~ '^(u|o):'),
  owner uuid not null,                                   -- 만든 사람(회사 사본은 올린 사람 — 기여 표시)
  kind text not null check (kind in ('knowhow', 'set', 'tool')), -- tool = 5단계 도구함(이름·종류·주소·사용법·켜짐·배정 크루)
  title text not null check (length(btrim(title)) between 1 and 200),
  body text not null default '' check (length(body) <= 20000),
  spec jsonb not null default '{}'::jsonb check (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 20000),
  source_key text check (source_key is null or length(source_key) <= 200),
  promoted_from uuid,
  version integer not null default 1,
  uses integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  archived_at timestamptz
);
create index if not exists office_assets_scope on public.office_assets(scope) where archived_at is null;
-- 먼저 만들어진 표(도구 이전)에 다시 적용해도 종류 제약이 새 값으로 바뀌게
alter table public.office_assets drop constraint if exists office_assets_kind_check;
alter table public.office_assets add constraint office_assets_kind_check check (kind in ('knowhow', 'set', 'tool'));
create table if not exists public.office_asset_versions (
  asset_id uuid not null references public.office_assets(id),
  version integer not null, title text not null, body text not null, spec jsonb not null,
  author uuid not null, at timestamptz not null default clock_timestamp(),
  primary key (asset_id, version)
);
create table if not exists public.office_asset_promotions (
  id uuid primary key,
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  asset_id uuid not null references public.office_assets(id),
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid, decided_at timestamptz, result_id uuid,
  created_at timestamptz not null default clock_timestamp()
);
create unique index if not exists office_asset_promotions_open on public.office_asset_promotions(org_id, asset_id) where status = 'pending';
create table if not exists public.office_asset_dismissed (
  user_id uuid not null, scope text not null, key text not null, at timestamptz not null default clock_timestamp(),
  primary key (user_id, scope, key)
);
alter table public.office_assets enable row level security; -- 정책 없음: 함수로만
alter table public.office_asset_versions enable row level security;
alter table public.office_asset_promotions enable row level security;
alter table public.office_asset_dismissed enable row level security;
revoke all on public.office_assets, public.office_asset_versions, public.office_asset_promotions, public.office_asset_dismissed from anon, authenticated;

-- 같은 종류 일 판별 열쇠: 제목에서 거래처 이름·날짜·숫자·문장부호를 뺀다. 두 글자 미만이면 null
create or replace function public.office_asset_key(p_title text, p_names text[]) returns text
language plpgsql immutable set search_path = public, pg_temp as $$
declare k text := lower(coalesce(p_title, '')); n text;
begin
  foreach n in array coalesce(p_names, '{}') loop
    if length(btrim(n)) >= 2 then k := replace(k, lower(btrim(n)), ' '); end if;
  end loop;
  k := regexp_replace(k, '[0-9]+\s*(회차|번째|월|일|년|주|차|회|건|호)?', ' ', 'g');
  k := regexp_replace(k, '[^a-z가-힣ㄱ-ㅎ ]', ' ', 'g');
  k := btrim(regexp_replace(k, '\s+', ' ', 'g'));
  return case when length(k) >= 2 then k end;
end $$;

-- 부른 사람 기준: 조직 역할(null | member | manager). 조직 없이 부르면(내 공간) 'me'
create or replace function public.office_asset_ctx(p_org uuid, out who uuid, out role text, out sc text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  who := auth.uid();
  if who is null then raise exception 'asset_forbidden' using errcode = '42501'; end if;
  if p_org is null then role := 'me'; sc := 'u:' || who; return; end if;
  select case when m.role in ('owner', 'admin') then 'manager' else 'member' end into role
    from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
    where m.org_id = p_org and m.user_id = who and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null;
  if role is null then raise exception 'asset_forbidden' using errcode = '42501'; end if;
  sc := 'o:' || p_org;
end $$;

create or replace function public.office_asset_json(a public.office_assets) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', a.id, 'kind', a.kind, 'scope', case when a.scope like 'u:%' then 'me' else 'org' end, 'title', a.title, 'body', a.body, 'spec', a.spec,
    'source_key', a.source_key, 'promoted_from', a.promoted_from, 'version', a.version, 'uses', a.uses, 'owner', a.owner, 'updated_at', a.updated_at)
$$;

-- 세트 spec 검사: 노하우는 부른 사람이 볼 수 있는 것만(회사 세트는 같은 조직 회사 노하우만), 도구 20개·점검 30개까지
create or replace function public.office_asset_spec(p_spec jsonb, p_scope text, p_who uuid, p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare ids uuid[]; tools text[]; checks text[]; tids uuid[];
begin
  begin
    select coalesce(array_agg(distinct x::uuid), '{}') into ids from jsonb_array_elements_text(coalesce(p_spec->'knowhow', '[]')) x;
    select coalesce(array_agg(distinct x::uuid), '{}') into tids from jsonb_array_elements_text(coalesce(p_spec->'tool_ids', '[]')) x;
    select coalesce(array_agg(btrim(x)), '{}') into tools from jsonb_array_elements_text(coalesce(p_spec->'tools', '[]')) x where btrim(x) <> '';
    select coalesce(array_agg(btrim(x)), '{}') into checks from jsonb_array_elements_text(coalesce(p_spec->'checks', '[]')) x where btrim(x) <> '';
  exception when others then raise exception 'asset_input'; end;
  if cardinality(ids) > 20 or cardinality(tools) > 20 or cardinality(checks) > 30
    or exists (select 1 from unnest(tools) x where length(x) > 60) or exists (select 1 from unnest(checks) x where length(x) > 200) then raise exception 'asset_input'; end if;
  if exists (select 1 from unnest(ids) i where not exists (select 1 from public.office_assets a where a.id = i and a.kind = 'knowhow' and a.archived_at is null
      and (a.scope = p_scope or (p_scope like 'u:%' and p_org is not null and a.scope = 'o:' || p_org)))) then raise exception 'asset_input'; end if;
  if cardinality(tids) > 20 or exists (select 1 from unnest(tids) i where not exists (select 1 from public.office_assets a where a.id = i and a.kind = 'tool' and a.archived_at is null
      and (a.scope = p_scope or (p_scope like 'u:%' and p_org is not null and a.scope = 'o:' || p_org)))) then raise exception 'asset_input'; end if;
  return jsonb_build_object('knowhow', to_jsonb(ids), 'tools', to_jsonb(tools), 'checks', to_jsonb(checks), 'tool_ids', to_jsonb(tids));
end $$;

-- 도구 spec 검사(5단계): 종류·주소(http/https)·켜짐·배정 크루(회사 도구 = 같은 조직 크루, 개인 도구 = 내 크루)
create or replace function public.office_asset_tool_spec(p_spec jsonb, p_scope text, p_who uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare kind text := coalesce(p_spec->>'tool_kind', 'service'); url text := nullif(btrim(coalesce(p_spec->>'url', '')), ''); crews uuid[];
begin
  begin
    select coalesce(array_agg(distinct x::uuid), '{}') into crews from jsonb_array_elements_text(coalesce(p_spec->'crews', '[]')) x;
  exception when others then raise exception 'asset_input'; end;
  if kind not in ('service', 'mcp', 'plugin', 'account', 'other') or (url is not null and (url !~* '^https?://[^\s]+$' or length(url) > 500)) or cardinality(crews) > 50
    or exists (select 1 from unnest(crews) i where not exists (select 1 from public.msgr_crews c where c.id = i
      and (case when p_scope like 'o:%' then c.org_id = substr(p_scope, 3)::uuid else c.owner_user_id = p_who end))) then raise exception 'asset_input'; end if;
  return jsonb_build_object('tool_kind', kind, 'url', url, 'enabled', coalesce((p_spec->>'enabled')::boolean, true), 'crews', to_jsonb(crews));
end $$;

create or replace function public.office_asset_list(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare c record; sugg jsonb;
begin
  select * into c from public.office_asset_ctx(p_org);
  with names as (select coalesce(array_agg(name), '{}') a from public.office_business_customers where scope = c.sc),
  d as (select t.id, t.title, t.note, t.done_at, public.office_asset_key(t.title, (select a from names)) k from public.office_tasks t
        where t.scope = c.sc and t.assignee = c.who and t.done_at > now() - interval '180 days'),
  g as (select k, count(*) n from d where k is not null group by k having count(*) >= 3)
  select coalesce(jsonb_agg(jsonb_build_object('key', g.k, 'count', g.n,
      'tasks', (select jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'note', x.note, 'done_at', x.done_at) order by x.done_at desc)
                from (select * from d where d.k = g.k order by d.done_at desc limit 10) x)) order by g.n desc, g.k), '[]') into sugg
  from g
  where not exists (select 1 from public.office_assets a where a.owner = c.who and a.source_key = g.k and a.archived_at is null)
    and not exists (select 1 from public.office_asset_dismissed x where x.user_id = c.who and x.scope = c.sc and x.key = g.k);
  return jsonb_build_object(
    'mine', coalesce((select jsonb_agg(public.office_asset_json(a) order by a.updated_at desc) from public.office_assets a where a.scope = 'u:' || c.who and a.archived_at is null), '[]'::jsonb),
    'company', case when p_org is null then '[]'::jsonb else coalesce((select jsonb_agg(public.office_asset_json(a) order by a.kind, a.title) from public.office_assets a where a.scope = c.sc and a.archived_at is null), '[]'::jsonb) end,
    'promotions', case when p_org is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'asset_id', p.asset_id, 'requested_by', p.requested_by, 'status', p.status,
        'title', a.title, 'body', a.body, 'created_at', p.created_at) order by p.created_at)
      from public.office_asset_promotions p join public.office_assets a on a.id = p.asset_id
      where p.org_id = p_org and p.status = 'pending' and (c.role = 'manager' or p.requested_by = c.who)), '[]'::jsonb) end,
    'suggestions', sugg, 'role', c.role);
end $$;

create or replace function public.office_asset_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; a public.office_assets%rowtype; aid uuid; target text; ttl text; bod text; sp jsonb; k public.office_assets%rowtype; out jsonb := '[]'::jsonb; tl jsonb;
begin
  select * into c from public.office_asset_ctx(p_org);
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 60000 then raise exception 'asset_input'; end if;
  aid := public.office_task_input(p_data->>'id', 'uuid')::uuid;
  if aid is null and p_action <> 'suggest.dismiss' then raise exception 'asset_input'; end if;

  if p_action = 'asset.create' then
    target := case when p_data->>'scope' = 'org' then c.sc else 'u:' || c.who end;
    if target like 'o:%' and c.role <> 'manager' then raise exception 'asset_forbidden' using errcode = '42501'; end if; -- 회사 노하우를 바로 만드는 것은 관리자만(직원은 올리기 요청)
    ttl := btrim(coalesce(p_data->>'title', '')); bod := coalesce(p_data->>'body', '');
    if p_data->>'kind' not in ('knowhow', 'set', 'tool') or length(ttl) not between 1 and 200 or length(bod) > 20000 then raise exception 'asset_input'; end if;
    sp := case p_data->>'kind' when 'set' then public.office_asset_spec(coalesce(p_data->'spec', '{}'), target, c.who, p_org)
      when 'tool' then public.office_asset_tool_spec(coalesce(p_data->'spec', '{}'), target, c.who) else '{}'::jsonb end;
    if exists (select 1 from public.office_assets where id = aid) then
      if exists (select 1 from public.office_assets where id = aid and scope = target and owner = c.who and title = ttl and body = bod) then return jsonb_build_object('id', aid); end if;
      raise exception 'asset_conflict';
    end if;
    insert into public.office_assets(id, scope, owner, kind, title, body, spec, source_key) values (aid, target, c.who, p_data->>'kind', ttl, bod, sp, nullif(left(p_data->>'source_key', 200), ''));
    insert into public.office_asset_versions(asset_id, version, title, body, spec, author) values (aid, 1, ttl, bod, sp, c.who);
    return jsonb_build_object('id', aid);
  elsif p_action = 'asset.promote' then -- (id = 요청 id, asset_id = 올릴 내 노하우) -- 개인 노하우 → 이 조직 회사 노하우로 올리기 요청
    select * into a from public.office_assets where id = public.office_task_input(p_data->>'asset_id', 'uuid')::uuid and scope = 'u:' || c.who and kind = 'knowhow' and archived_at is null;
    if not found or p_org is null then raise exception 'asset_input'; end if;
    insert into public.office_asset_promotions(id, org_id, asset_id, requested_by) values (aid, p_org, a.id, c.who);
    return jsonb_build_object('id', aid);
  elsif p_action = 'crew.tools' then -- 크루에게 맡길 때: 그 크루에게 배정되고 켜진, 내가 볼 수 있는 도구와 사용법(쓴 횟수도 올린다)
    select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'url', x.spec->>'url', 'guide', x.body, 'tool_kind', x.spec->>'tool_kind') order by x.title), '[]') into out
      from public.office_assets x where x.kind = 'tool' and x.archived_at is null and (x.scope = 'u:' || c.who or x.scope = c.sc)
        and coalesce((x.spec->>'enabled')::boolean, true) and x.spec->'crews' ? (p_data->>'crew_id');
    update public.office_assets set uses = uses + 1 where id in (select (e->>'id')::uuid from jsonb_array_elements(out) e);
    return jsonb_build_object('tools', out);
  elsif p_action = 'suggest.dismiss' then
    if length(coalesce(p_data->>'key', '')) not between 1 and 200 then raise exception 'asset_input'; end if;
    insert into public.office_asset_dismissed(user_id, scope, key) values (c.who, c.sc, p_data->>'key') on conflict do nothing;
    return jsonb_build_object('ok', true);
  end if;

  select * into a from public.office_assets where id = aid and archived_at is null and (scope = 'u:' || c.who or scope = c.sc) for update;
  if not found then raise exception 'asset_not_found'; end if;

  if p_action = 'asset.use' then -- 크루에게 맡길 때: 세트면 묶인 노하우 본문을 같이 돌려주고 사용 횟수를 올린다
    update public.office_assets set uses = uses + 1 where id = a.id;
    if a.kind = 'set' then
      for k in select x.* from public.office_assets x where x.id in (select (jsonb_array_elements_text(a.spec->'knowhow'))::uuid) and x.archived_at is null
          and (x.scope = 'u:' || c.who or x.scope = c.sc) order by x.title loop
        update public.office_assets set uses = uses + 1 where id = k.id;
        out := out || jsonb_build_array(jsonb_build_object('id', k.id, 'title', k.title, 'body', k.body));
      end loop;
    end if;
    with t as (update public.office_assets x set uses = uses + 1 -- 세트가 묶은 도구 중 켜진 것(쓴 횟수도 올린다)
        where x.kind = 'tool' and x.archived_at is null and (x.scope = 'u:' || c.who or x.scope = c.sc) and coalesce((x.spec->>'enabled')::boolean, true)
          and x.id in (select (jsonb_array_elements_text(coalesce(a.spec->'tool_ids', '[]')))::uuid) returning x.id, x.title, x.body, x.spec)
    select jsonb_agg(jsonb_build_object('id', t.id, 'title', t.title, 'url', t.spec->>'url', 'guide', t.body) order by t.title) into tl from t;
    return jsonb_build_object('id', a.id, 'kind', a.kind, 'title', a.title, 'body', a.body, 'tools', coalesce(a.spec->'tools', '[]'), 'checks', coalesce(a.spec->'checks', '[]'), 'knowhow', out,
      'tool_list', coalesce(tl, '[]'::jsonb));
  end if;

  -- 고치기·보관·올리기: 개인 것은 본인, 회사 것은 관리자
  if not ((a.scope = 'u:' || c.who) or (a.scope like 'o:%' and c.role = 'manager')) then raise exception 'asset_forbidden' using errcode = '42501'; end if;
  if p_action = 'asset.update' then
    if (p_data->>'version')::int is distinct from a.version then raise exception 'asset_version'; end if;
    ttl := btrim(coalesce(p_data->>'title', '')); bod := coalesce(p_data->>'body', '');
    if length(ttl) not between 1 and 200 or length(bod) > 20000 then raise exception 'asset_input'; end if;
    sp := case a.kind when 'set' then public.office_asset_spec(coalesce(p_data->'spec', '{}'), a.scope, c.who, p_org)
      when 'tool' then public.office_asset_tool_spec(coalesce(p_data->'spec', '{}'), a.scope, c.who) else '{}'::jsonb end;
    if a.title = ttl and a.body = bod and a.spec = sp then return jsonb_build_object('id', a.id, 'version', a.version); end if; -- 같은 값이면 버전을 늘리지 않는다
    update public.office_assets set title = ttl, body = bod, spec = sp, version = version + 1, updated_at = clock_timestamp() where id = a.id;
    insert into public.office_asset_versions(asset_id, version, title, body, spec, author) values (a.id, a.version + 1, ttl, bod, sp, c.who);
    return jsonb_build_object('id', a.id, 'version', a.version + 1);
  elsif p_action = 'asset.archive' then
    update public.office_assets set archived_at = clock_timestamp() where id = a.id;
    return jsonb_build_object('id', a.id);
  end if;
  raise exception 'asset_input';
exception when unique_violation then raise exception 'asset_conflict';
end $$;

create or replace function public.office_asset_manage(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c record; p public.office_asset_promotions%rowtype; a public.office_assets%rowtype; nid uuid := gen_random_uuid();
begin
  select * into c from public.office_asset_ctx(p_org);
  if p_org is null or c.role <> 'manager' then raise exception 'asset_forbidden' using errcode = '42501'; end if;
  if p_action = 'promotion.decide' then
    select * into p from public.office_asset_promotions where id = public.office_task_input(p_data->>'id', 'uuid')::uuid and org_id = p_org for update;
    if not found or p.status <> 'pending' then raise exception 'asset_input'; end if;
    if not coalesce((p_data->>'approve')::boolean, false) then
      update public.office_asset_promotions set status = 'rejected', decided_by = c.who, decided_at = clock_timestamp() where id = p.id;
      return jsonb_build_object('id', p.id);
    end if;
    select * into a from public.office_assets where id = p.asset_id;
    insert into public.office_assets(id, scope, owner, kind, title, body, spec, promoted_from) values (nid, c.sc, a.owner, a.kind, a.title, a.body, '{}'::jsonb, a.id);
    insert into public.office_asset_versions(asset_id, version, title, body, spec, author) values (nid, 1, a.title, a.body, '{}'::jsonb, c.who);
    update public.office_asset_promotions set status = 'approved', decided_by = c.who, decided_at = clock_timestamp(), result_id = nid where id = p.id;
    return jsonb_build_object('id', p.id, 'asset_id', nid);
  end if;
  raise exception 'asset_input';
end $$;

revoke all on function public.office_asset_key(text, text[]), public.office_asset_ctx(uuid), public.office_asset_json(public.office_assets), public.office_asset_tool_spec(jsonb, text, uuid),
  public.office_asset_spec(jsonb, text, uuid, uuid), public.office_asset_list(uuid), public.office_asset_write(uuid, text, jsonb),
  public.office_asset_manage(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.office_asset_list(uuid), public.office_asset_write(uuid, text, jsonb), public.office_asset_manage(uuid, text, jsonb) to authenticated;
