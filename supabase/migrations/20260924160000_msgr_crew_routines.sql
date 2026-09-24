-- 메신저 "업무 > 자동화" 1단계 — Argo PC 루틴을 메신저에 미러하고, 메신저에서 건 수정을 PC가 반영(양방향).
-- 소유자만 보고 고친다: 두 표 모두 owner_user_id = auth.uid() 단일 컬럼 비교로 RLS를 건다(조인 없음 — 성능·감사 단순).
-- 크루 소유자만 자기 크루의 루틴을 미러·수정한다. source는 지금은 'argo'만 — 2단계(Hermes 등 외부 에이전트)는
-- 이 컬럼값을 늘리는 것으로 확장한다(체크 제약 하나만 넓히면 되게 미리 컬럼을 일반화해 둔다).
create table public.msgr_crew_routines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs(id) on delete cascade,
  crew_id uuid not null references public.msgr_crews(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  source text not null default 'argo' check (source in ('argo')),
  ext_id text not null check (length(ext_id) between 1 and 200),
  title text not null check (length(title) between 1 and 200),
  prompt text not null check (length(prompt) between 1 and 20000),
  schedule jsonb not null,
  enabled boolean not null default true,
  channel_id uuid references public.msgr_channels(id) on delete set null,
  updated_at timestamptz,   -- Argo 쪽 routine.updatedAt(로컬 시계) — "나중 수정이 이긴다" 판정 기준. 구버전 루틴은 null 가능.
  synced_at timestamptz not null default now(),
  unique (crew_id, source, ext_id)
);
create index msgr_crew_routines_owner on public.msgr_crew_routines(owner_user_id);
create index msgr_crew_routines_channel on public.msgr_crew_routines(channel_id) where channel_id is not null;
alter table public.msgr_crew_routines enable row level security;
revoke all on public.msgr_crew_routines from public,anon,authenticated;
grant select on public.msgr_crew_routines to authenticated;
create policy msgr_crew_routines_read on public.msgr_crew_routines for select to authenticated using (owner_user_id = auth.uid());

-- 메신저에서 건 편집 — PC가 켜지면 drain에서 가져가 적용한다. 대기 중(pending) 여러 건이 쌓이면 최신 것만 유효하고
-- 이전 것은 superseded로 접는다(같은 루틴에 두 번 편집해도 PC는 한 번만 반영). 적용 결과(applied/failed)는 PC가 되써준다.
create table public.msgr_crew_routine_edits (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.msgr_crew_routines(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  op text not null check (op in ('update','delete')),
  patch jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','applied','superseded','failed')),
  error text,
  applied_at timestamptz
);
create index msgr_crew_routine_edits_pending on public.msgr_crew_routine_edits(routine_id) where status = 'pending';
create index msgr_crew_routine_edits_owner on public.msgr_crew_routine_edits(owner_user_id);
alter table public.msgr_crew_routine_edits enable row level security;
revoke all on public.msgr_crew_routine_edits from public,anon,authenticated;
grant select on public.msgr_crew_routine_edits to authenticated;
create policy msgr_crew_routine_edits_read on public.msgr_crew_routine_edits for select to authenticated using (owner_user_id = auth.uid());

-- PC → 서버: 이 크루의 Argo 루틴 전체 스냅샷을 올린다. 같은 값이면 쓰지 않는다(IS DISTINCT FROM) — 유휴 폴 때 행이 0으로 남는다.
-- p_rows 원소: {ext_id, title, prompt, schedule, enabled, channel_id, updated_at}. 스냅샷에 없는 ext_id는 이 크루·source의 행에서 지운다(로컬 삭제 반영).
create function public.msgr_crew_routines_sync(p_org uuid, p_crew uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare row jsonb; kept text[] := '{}';
begin
  if auth.uid() is null then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr_crews c where c.id = p_crew and c.org_id = p_org and c.owner_user_id = auth.uid()) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'msgr_routine_invalid_rows'; end if;
  for row in select value from jsonb_array_elements(p_rows) loop
    if coalesce(row->>'ext_id','') = '' or coalesce(row->>'title','') = '' or coalesce(row->>'prompt','') = ''
      or jsonb_typeof(row->'schedule') is distinct from 'object' then raise exception 'msgr_routine_invalid_rows'; end if;
    kept := kept || (row->>'ext_id');
    insert into public.msgr_crew_routines as t(org_id, crew_id, owner_user_id, source, ext_id, title, prompt, schedule, enabled, channel_id, updated_at, synced_at)
      values (p_org, p_crew, auth.uid(), 'argo', row->>'ext_id', row->>'title', row->>'prompt', row->'schedule',
        coalesce((row->>'enabled')::boolean, true), nullif(row->>'channel_id','')::uuid, nullif(row->>'updated_at','')::timestamptz, now())
      on conflict (crew_id, source, ext_id) do update set
        title = excluded.title, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled,
        channel_id = excluded.channel_id, updated_at = excluded.updated_at, synced_at = now()
      where t.title is distinct from excluded.title or t.prompt is distinct from excluded.prompt
        or t.schedule is distinct from excluded.schedule or t.enabled is distinct from excluded.enabled
        or t.channel_id is distinct from excluded.channel_id or t.updated_at is distinct from excluded.updated_at;
  end loop;
  delete from public.msgr_crew_routines where crew_id = p_crew and source = 'argo'
    and not (ext_id = any(kept));
  return jsonb_build_object('kept', array_length(kept,1));
end $$;

-- 메신저 → 서버: 소유자가 자기 루틴에 편집을 건다. 같은 루틴의 이전 pending은 superseded로 접는다(최신 편집만 유효).
create function public.msgr_crew_routine_edit(p_routine uuid, p_op text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_crew_routines; e public.msgr_crew_routine_edits;
begin
  if auth.uid() is null or p_op not in ('update','delete') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  select * into r from public.msgr_crew_routines where id = p_routine and owner_user_id = auth.uid();
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  if p_op = 'update' and jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
  update public.msgr_crew_routine_edits set status = 'superseded' where routine_id = p_routine and status = 'pending';
  insert into public.msgr_crew_routine_edits(routine_id, owner_user_id, op, patch, created_by)
    values (p_routine, auth.uid(), p_op, coalesce(p_patch,'{}'::jsonb), auth.uid()) returning * into e;
  return to_jsonb(e);
end $$;

-- PC → 서버: 내 크루들의 대기 편집을 가져온다(조직 단위 — drain이 조직마다 부른다).
create function public.msgr_crew_routine_edits_pending(p_org uuid) returns table(edit_id uuid, routine_id uuid, crew_id uuid, ext_id text, op text, patch jsonb, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id, e.routine_id, r.crew_id, r.ext_id, e.op, e.patch, e.created_at
    from public.msgr_crew_routine_edits e join public.msgr_crew_routines r on r.id = e.routine_id
    where e.status = 'pending' and r.org_id = p_org and r.owner_user_id = auth.uid()
    order by e.created_at asc
$$;

-- PC → 서버: 적용 결과를 되써준다. applied/failed = 실제 적용 시도 결과. superseded = PC 쪽 루틴이 이 편집보다
-- 나중에(updatedAt) 바뀌어 있어 "나중 수정이 이긴다" 규칙으로 PC가 이 대기 편집을 버린 경우(메신저 쪽 편집 시점의
-- 자동 superseded와 같은 상태값을 PC 판정 경로에서도 쓴다).
create function public.msgr_crew_routine_edit_done(p_id uuid, p_status text, p_error text default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_status not in ('applied','failed','superseded') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  update public.msgr_crew_routine_edits set status = p_status, error = p_error, applied_at = now()
    where id = p_id and owner_user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  return true;
end $$;

revoke all on function public.msgr_crew_routines_sync(uuid,uuid,jsonb), public.msgr_crew_routine_edit(uuid,text,jsonb),
  public.msgr_crew_routine_edits_pending(uuid), public.msgr_crew_routine_edit_done(uuid,text,text) from public,anon,authenticated;
grant execute on function public.msgr_crew_routines_sync(uuid,uuid,jsonb), public.msgr_crew_routine_edit(uuid,text,jsonb),
  public.msgr_crew_routine_edits_pending(uuid), public.msgr_crew_routine_edit_done(uuid,text,text) to authenticated;

-- DB 위생: 처리된 편집(applied/superseded)은 30일 뒤 정리 — 감사가 필요한 건 applied_at까지 남아 있고 그 이후는 기억 데이터가 아니다.
-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-msgr-crew-routine-edits', '23 3 * * *',
      $c$delete from public.msgr_crew_routine_edits where status in ('applied','superseded') and coalesce(applied_at,created_at) < now() - interval '30 days'$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
