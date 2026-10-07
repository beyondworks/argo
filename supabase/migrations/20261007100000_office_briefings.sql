-- 브리핑(유건 10/5 "브리핑은 필요해. 모듈 새로 만들어서", "브리핑은 개인 공간에서 보이도록").
-- 인트라넷 briefings(페퍼가 매일 0시·12시에 쓰던 글 94건)를 오피스로 옮기고, 앞으로는 에이전트 도구가 여기에 쓴다.
--
-- · 받는 사람(recipient)이 있는 글이다. 받는 사람의 '내 공간'에 여러 조직 것이 모여 보이고, 카드마다 어느 조직에서 왔는지 표시한다.
--   조직이 클수록 조직 단위로 모두가 보면 양이 감당 안 된다(유건 10/5) — 그래서 기본은 받는 사람 한 명.
-- · recipient가 null이면 '조직 전체' 글 — 그 조직 구성원(손님 제외) 모두의 내 공간에 들어간다. 쓰기는 조직 관리자만.
-- · 남에게 온 글은 관리자도 못 본다. 지우기는 받는 사람 본인(조직 전체 글은 그 조직 관리자). 본문 고치기는 없다(기록).
-- · org_id가 null이면 개인 공간 글 — 받는 사람은 쓴 사람 본인뿐.
-- · 부하: 읽기는 화면·홈 모듈을 열 때 1회(30건씩 커서), 쓰기는 에이전트 도구·이관 스크립트가 부를 때만. 폴링 없음.
-- · 누적·보존: 기억으로 쓰이는 기록이라 자동 정리하지 않는다(DB 위생 1번). 대신 한 건 32KB, 받는 사람당 하루 50건·조직 전체 글은 조직당 하루 20건 상한.

create table if not exists public.office_briefings (
  id uuid primary key,                                                   -- 부른 쪽이 만든 id(두 번 불려도 한 건)
  org_id uuid references public.msgr_orgs(id) on delete cascade,         -- null = 개인 공간
  recipient uuid references auth.users(id) on delete cascade,            -- null = 조직 전체
  kind text not null default 'custom' check (kind in ('daily', 'weekly', 'custom')),
  period text not null default '' check (length(period) <= 100),
  title text not null check (length(btrim(title)) between 1 and 300), -- 인트라넷 브리핑은 제목에 그날 요약을 길게 담았다(최대 300자) — 자르지 않고 옮긴다
  body text not null default '' check (length(body) <= 32768),
  author_kind text not null default 'agent' check (author_kind in ('agent', 'person')),
  author_name text not null default '' check (length(author_name) <= 100),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  source jsonb check (source is null or (jsonb_typeof(source) = 'object' and source->>'kind' = 'intranet' and length(coalesce(source->>'id', '')) between 1 and 200)),
  check (org_id is not null or recipient is not null)
);
create index if not exists office_briefings_recipient on public.office_briefings (recipient, created_at desc, id desc) where recipient is not null;
create index if not exists office_briefings_org_wide on public.office_briefings (org_id, created_at desc, id desc) where recipient is null;
create unique index if not exists office_briefings_source on public.office_briefings (org_id, (source->>'id')) where source is not null;
alter table public.office_briefings enable row level security;
revoke all on public.office_briefings from anon, authenticated;

-- 이 사람이 그 조직의 구성원(손님 제외)인가
create or replace function public.office_briefing_member(p_org uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
    where m.org_id = p_org and m.user_id = p_user and m.removed_at is null and m.role <> 'guest' and o.deleted_at is null);
$$;

-- 내가 볼 수 있는 글인가 — 나에게 온 글, 또는 내가 구성원인 조직의 전체 글
create or replace function public.office_briefing_visible(b public.office_briefings, p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select case when b.recipient is not null then b.recipient = p_user and (b.org_id is null or public.office_briefing_member(b.org_id, p_user))
              else public.office_briefing_member(b.org_id, p_user) end;
$$;

create or replace function public.office_briefing_json(b public.office_briefings, p_body boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', b.id, 'org_id', b.org_id, 'org_name', (select o.name from public.msgr_orgs o where o.id = b.org_id),
    'org_wide', b.recipient is null, 'kind', b.kind, 'period', b.period, 'title', b.title, 'author_kind', b.author_kind, 'author_name', b.author_name,
    'created_at', b.created_at, 'excerpt', left(regexp_replace(b.body, '\s+', ' ', 'g'), 160))
    || case when p_body then jsonb_build_object('body', b.body) else '{}'::jsonb end;
$$;

-- 목록: 최신순 30건씩(p_before_at·p_before_id 커서). p_q는 제목·본문 글자 찾기(대소문자 무시). p_body = 본문까지(홈 모듈 1건용)
create or replace function public.office_briefing_list(p_before_at timestamptz default null, p_before_id uuid default null, p_q text default null,
  p_limit integer default 30, p_body boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); q text := lower(nullif(btrim(coalesce(p_q, '')), '')); lim integer := least(greatest(coalesce(p_limit, 30), 1), 100);
begin
  if who is null then raise exception 'briefing_forbidden' using errcode = '42501'; end if;
  if length(q) > 100 then raise exception 'briefing_input'; end if;
  return coalesce((select jsonb_agg(public.office_briefing_json(b, p_body) order by b.created_at desc, b.id desc) from (
    select * from public.office_briefings b
    where (b.recipient = who or (b.recipient is null and b.org_id in (select m.org_id from public.msgr_org_members m where m.user_id = who and m.removed_at is null and m.role <> 'guest')))
      and public.office_briefing_visible(b, who)
      and (p_before_at is null or (b.created_at, b.id) < (p_before_at, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
      and (q is null or position(q in lower(b.title || ' ' || b.body)) > 0)
    order by b.created_at desc, b.id desc limit lim) b), '[]'::jsonb);
end $$;

create or replace function public.office_briefing_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare b public.office_briefings%rowtype;
begin
  select * into b from public.office_briefings where id = p_id;
  if b.id is null or not public.office_briefing_visible(b, auth.uid()) then raise exception 'briefing_missing'; end if; -- 남의 글은 없는 글과 같게
  return public.office_briefing_json(b, true);
end $$;

-- 쓰기: briefing.create(에이전트 도구·사람) / briefing.delete
-- create p_data: { id, title, body, kind?, period?, recipient?: uuid | 'org', author_kind?, author_name? }
--   recipient 없으면 부른 사람 본인. 남에게·조직 전체로는 그 조직 관리자만.
create or replace function public.office_briefing_write(p_org uuid, p_action text, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := auth.uid(); manager boolean := false; b public.office_briefings%rowtype; bid uuid; target uuid; org_wide boolean;
  v_title text; v_body text; v_kind text; v_period text; v_akind text; v_aname text;
begin
  if who is null then raise exception 'briefing_forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 140000 then raise exception 'briefing_input'; end if;
  begin bid := (p_data->>'id')::uuid; exception when others then raise exception 'briefing_input'; end;
  if bid is null then raise exception 'briefing_input'; end if;
  if p_org is not null then
    if not public.office_briefing_member(p_org, who) then raise exception 'briefing_forbidden' using errcode = '42501'; end if;
    manager := public.office_perf_role(p_org) = 'manager';
  end if;

  if p_action = 'briefing.delete' then
    select * into b from public.office_briefings where id = bid;
    if b.id is null or not public.office_briefing_visible(b, who) then raise exception 'briefing_missing'; end if;
    if b.recipient is null and public.office_perf_role(b.org_id) is distinct from 'manager' then raise exception 'briefing_forbidden' using errcode = '42501'; end if;
    delete from public.office_briefings where id = bid;
    return jsonb_build_object('id', bid, 'deleted', true);
  elsif p_action is distinct from 'briefing.create' then raise exception 'briefing_input';
  end if;

  select * into b from public.office_briefings where id = bid;
  if b.id is not null then
    if b.created_by = who then return public.office_briefing_json(b, false); end if; -- 같은 요청을 다시 보낸 것
    raise exception 'briefing_conflict';
  end if;
  v_title := btrim(coalesce(p_data->>'title', '')); v_body := coalesce(p_data->>'body', '');
  v_kind := coalesce(nullif(p_data->>'kind', ''), 'custom'); v_period := btrim(coalesce(p_data->>'period', ''));
  v_akind := coalesce(nullif(p_data->>'author_kind', ''), 'person'); v_aname := btrim(coalesce(p_data->>'author_name', ''));
  if length(v_title) not between 1 and 300 or length(v_body) > 32768 or v_kind not in ('daily', 'weekly', 'custom') or length(v_period) > 100
     or v_akind not in ('agent', 'person') or length(v_aname) > 100 then raise exception 'briefing_input'; end if;
  org_wide := p_data->>'recipient' = 'org';
  if org_wide then
    if p_org is null or not manager then raise exception 'briefing_forbidden' using errcode = '42501'; end if;
    target := null;
  else
    begin target := coalesce(nullif(p_data->>'recipient', '')::uuid, who); exception when others then raise exception 'briefing_input'; end;
    if target <> who then
      if p_org is null or not manager then raise exception 'briefing_forbidden' using errcode = '42501'; end if; -- 남에게는 관리자만
      if not public.office_briefing_member(p_org, target) then raise exception 'briefing_recipient'; end if;
    end if;
  end if;
  if org_wide then
    perform pg_advisory_xact_lock(hashtextextended('office-briefing-org:' || p_org, 0));
    if (select count(*) from public.office_briefings x where x.org_id = p_org and x.recipient is null and x.created_at > now() - interval '1 day') >= 20 then raise exception 'briefing_limit'; end if;
  else
    perform pg_advisory_xact_lock(hashtextextended('office-briefing-to:' || target, 0));
    if (select count(*) from public.office_briefings x where x.recipient = target and x.created_at > now() - interval '1 day') >= 50 then raise exception 'briefing_limit'; end if;
  end if;
  insert into public.office_briefings(id, org_id, recipient, kind, period, title, body, author_kind, author_name, created_by)
    values (bid, p_org, target, v_kind, v_period, v_title, v_body, v_akind, v_aname, who) returning * into b;
  return public.office_briefing_json(b, false);
end $$;

-- 이관 전용(인트라넷 briefings): service_role만 부른다(이관 스크립트) — 실행자(p_actor)는 그 조직 관리자여야 하고, 원본 작성 시각·작성자 이름을 지킨다.
-- 하루 상한(받는 사람당 50건)을 거치지 않고 지난 날짜로 넣는 길이라 로그인 계정에는 열지 않는다(보안 검토: 관리자가 상한을 피해 구성원에게 대량으로 넣을 수 있었다).
-- 받는 사람은 그 조직 구성원. 같은 원본(source.id)은 조직마다 한 번만 — 다시 돌려도 두 번 들어가지 않는다.
create or replace function public.office_briefing_import(p_org uuid, p_actor uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare who uuid := p_actor; b public.office_briefings%rowtype; bid uuid; target uuid; v_created timestamptz;
  v_title text; v_body text; v_kind text; v_period text; v_aname text; sid text;
begin
  if p_org is null or who is null or not exists (select 1 from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id
      where m.org_id = p_org and m.user_id = who and m.removed_at is null and m.role in ('owner', 'admin') and o.deleted_at is null) then
    raise exception 'briefing_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 140000
     or jsonb_typeof(p_data->'source') is distinct from 'object' or p_data->'source'->>'kind' is distinct from 'intranet' then raise exception 'briefing_input'; end if;
  sid := p_data->'source'->>'id';
  begin
    bid := (p_data->>'id')::uuid; target := (p_data->>'recipient')::uuid; v_created := (p_data->>'created_at')::timestamptz;
  exception when others then raise exception 'briefing_input'; end;
  v_title := btrim(coalesce(p_data->>'title', '')); v_body := coalesce(p_data->>'body', '');
  v_kind := coalesce(nullif(p_data->>'kind', ''), 'custom'); v_period := btrim(coalesce(p_data->>'period', '')); v_aname := btrim(coalesce(p_data->>'author_name', ''));
  if bid is null or target is null or v_created is null or v_created > clock_timestamp() + interval '1 minute' or length(coalesce(sid, '')) not between 1 and 200
     or length(v_title) not between 1 and 300 or length(v_body) > 32768 or v_kind not in ('daily', 'weekly', 'custom') or length(v_period) > 100 or length(v_aname) > 100 then raise exception 'briefing_input'; end if;
  if not public.office_briefing_member(p_org, target) then raise exception 'briefing_recipient'; end if;
  select * into b from public.office_briefings x where x.org_id = p_org and x.source->>'id' = sid;
  if b.id is not null then return public.office_briefing_json(b, false); end if; -- 같은 원본은 한 번만
  if exists (select 1 from public.office_briefings where id = bid) then raise exception 'briefing_conflict'; end if;
  insert into public.office_briefings(id, org_id, recipient, kind, period, title, body, author_kind, author_name, created_by, created_at, source)
    values (bid, p_org, target, v_kind, v_period, v_title, v_body, 'agent', v_aname, who, v_created, jsonb_build_object('kind', 'intranet', 'id', sid)) returning * into b;
  return public.office_briefing_json(b, false);
end $$;

revoke all on function public.office_briefing_member(uuid, uuid), public.office_briefing_visible(public.office_briefings, uuid),
  public.office_briefing_json(public.office_briefings, boolean) from public, anon, authenticated;
revoke all on function public.office_briefing_list(timestamptz, uuid, text, integer, boolean), public.office_briefing_get(uuid),
  public.office_briefing_write(uuid, text, jsonb) from public, anon;
grant execute on function public.office_briefing_list(timestamptz, uuid, text, integer, boolean), public.office_briefing_get(uuid),
  public.office_briefing_write(uuid, text, jsonb) to authenticated;
revoke all on function public.office_briefing_import(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.office_briefing_import(uuid, uuid, jsonb) to service_role; -- 이관 스크립트만
