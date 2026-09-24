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
  updated_at timestamptz,   -- Argo 쪽 routine.editedAt(사람이 고친 시각만 — 실행 필드는 안 찍는다). "나중 수정이 이긴다" 판정 기준. 구버전 루틴은 null 가능.
  synced_at timestamptz not null default now(),
  unique (crew_id, source, ext_id)
);
create index msgr_crew_routines_owner on public.msgr_crew_routines(owner_user_id);
create index msgr_crew_routines_channel on public.msgr_crew_routines(channel_id) where channel_id is not null;
alter table public.msgr_crew_routines enable row level security;
revoke all on public.msgr_crew_routines from public,anon,authenticated;
grant select on public.msgr_crew_routines to authenticated;
create policy msgr_crew_routines_read on public.msgr_crew_routines for select to authenticated using (owner_user_id = auth.uid());

-- 메신저에서 건 편집 — PC가 켜지면 drain에서 가져가 적용한다.
-- status: pending(대기) / applied(PC가 반영) / replaced(같은 루틴에 더 새 편집이 생겨 자동으로 접힘 — 메신저 쪽 판정,
--   H3: 폴드 시 이전 patch가 새 patch에 병합된다) / superseded(PC가 "로컬이 이 편집보다 나중에 바뀌었다"고 판단해 버림 —
--   PC 쪽 판정, H4: 크루가 여러 조직에 파견돼 같은 루틴에 중복 편집이 생기면 오래된 쪽도 이 상태로 닫는다) / failed(적용 시도 실패
--   또는 적용할 로컬 루틴이 없음).
create table public.msgr_crew_routine_edits (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references public.msgr_crew_routines(id) on delete cascade,
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  op text not null check (op in ('update','delete')),
  patch jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','applied','replaced','superseded','failed')),
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
-- M2(분리 검수): 모양이 이상한 행 하나가 크루 전체 미러를 막지 않는다 — 그 행만 건너뛰고(skipped 카운트) 나머지는 반영한다.
-- 존재하지 않는 channel_id(FK 오염)는 예외 대신 null로 떨어뜨린다. title·prompt는 길이 제한에 맞게 자른다(거절하지 않는다).
create function public.msgr_crew_routines_sync(p_org uuid, p_crew uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare row jsonb; kept text[] := '{}'; chan uuid; upd timestamptz; skipped int := 0;
begin
  if auth.uid() is null then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  -- M5: 오프보딩·회수(detached/available)된 크루는 더 미러할 수 없다 — 트리거(msgr_crew_routines_offboard)가
  -- 상태 전이 즉시 기존 행을 지우므로, 여기서 막지 않으면 사라진 미러가 바로 되살아난다.
  -- 재검수(2차) 기한 지난 게스트: msgr_channel_member_ok와 같은 기준(m.expires_at is null or > now())으로 거절한다.
  if not exists (select 1 from public.msgr_crews c join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = c.owner_user_id and m.removed_at is null
        and (m.expires_at is null or m.expires_at > now())
      where c.id = p_crew and c.org_id = p_org and c.owner_user_id = auth.uid() and c.status = 'active') then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'msgr_routine_invalid_rows'; end if;
  for row in select value from jsonb_array_elements(p_rows) loop
    if coalesce(row->>'ext_id','') = '' or coalesce(btrim(row->>'title'),'') = '' or coalesce(btrim(row->>'prompt'),'') = ''
      or jsonb_typeof(row->'schedule') is distinct from 'object' then skipped := skipped + 1; continue; end if;
    kept := kept || (row->>'ext_id');
    chan := null;
    begin chan := nullif(row->>'channel_id','')::uuid; exception when others then chan := null; end;
    if chan is not null and not exists (select 1 from public.msgr_channels c where c.id = chan and c.org_id = p_org) then chan := null; end if;
    upd := null;
    begin upd := nullif(row->>'updated_at','')::timestamptz; exception when others then upd := null; end;
    insert into public.msgr_crew_routines as t(org_id, crew_id, owner_user_id, source, ext_id, title, prompt, schedule, enabled, channel_id, updated_at, synced_at)
      values (p_org, p_crew, auth.uid(), 'argo', row->>'ext_id', left(btrim(row->>'title'),200), left(btrim(row->>'prompt'),20000), row->'schedule',
        coalesce((row->>'enabled')::boolean, true), chan, upd, now())
      on conflict (crew_id, source, ext_id) do update set
        title = excluded.title, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled,
        channel_id = excluded.channel_id, updated_at = excluded.updated_at, synced_at = now()
      where t.title is distinct from excluded.title or t.prompt is distinct from excluded.prompt
        or t.schedule is distinct from excluded.schedule or t.enabled is distinct from excluded.enabled
        or t.channel_id is distinct from excluded.channel_id or t.updated_at is distinct from excluded.updated_at;
  end loop;
  delete from public.msgr_crew_routines where crew_id = p_crew and source = 'argo'
    and not (ext_id = any(kept));
  return jsonb_build_object('kept', coalesce(array_length(kept,1),0), 'skipped', skipped);
end $$;

-- 메신저 → 서버: 소유자가 자기 루틴에 편집을 건다.
-- H3: 같은 루틴에 pending이 이미 있으면 그 patch를 새 patch에 먼저 병합(얕은 병합 — 새 값이 이긴다)하고 이전 것은
-- replaced로 접는다(superseded와 구분 — 이건 "더 새 메신저 편집이 폴드했다"는 뜻이지 PC가 로컬을 더 최신으로 판단한 게 아니다).
-- delete는 항상 우선 — pending이 delete였거나 이번이 delete면 최종 op는 delete, patch는 비운다.
-- M1: update의 patch는 title/prompt/schedule/enabled만 허용 — agentSlug·notifications·loop·verify는 메신저에서 못 바꾼다.
-- 재검수(2차) N3: 필드별 jsonb 타입도 검사한다 — enabled는 boolean, title·prompt는 string, schedule은 object.
-- 문자열 "false"를 boolean 취급하지 않게(예전엔 PC 쪽에서 (row->>'enabled')::boolean로 강제 형변환이 일어나 "false"도 true가 됐다).
create function public.msgr_crew_routine_edit(p_routine uuid, p_op text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_crew_routines; e public.msgr_crew_routine_edits; prior public.msgr_crew_routine_edits; merged jsonb; final_op text; had_prior boolean;
begin
  if auth.uid() is null or p_op not in ('update','delete') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  select * into r from public.msgr_crew_routines where id = p_routine and owner_user_id = auth.uid();
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  -- 재검수(2차) 기한 지난 게스트: 루틴 소유자가 이 조직의 유효(만료 안 된) 멤버가 아니면 편집을 거절한다.
  if not exists (select 1 from public.msgr_org_members m where m.org_id = r.org_id and m.user_id = auth.uid() and m.removed_at is null
      and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if p_op = 'update' then
    if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
    if (coalesce(p_patch,'{}'::jsonb) - array['title','prompt','schedule','enabled']) <> '{}'::jsonb then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'title' and jsonb_typeof(p_patch->'title') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'prompt' and jsonb_typeof(p_patch->'prompt') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'schedule' and jsonb_typeof(p_patch->'schedule') <> 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
  end if;
  select * into prior from public.msgr_crew_routine_edits where routine_id = p_routine and status = 'pending' order by created_at desc limit 1;
  had_prior := found;
  if had_prior then update public.msgr_crew_routine_edits set status = 'replaced' where id = prior.id; end if;
  -- 새로 들어온 편집이 최종 결정이다: 이번이 delete면 이전 patch를 버리고 delete가 이긴다. 이번이 update면
  -- (이전이 delete였더라도) update가 이긴다 — 그래야 "지워달라 했다가 마음이 바뀌어 수정으로 되돌리는" 흐름이 막히지 않는다.
  if p_op = 'delete' then
    final_op := 'delete'; merged := '{}'::jsonb;
  else
    merged := coalesce(case when had_prior and prior.op = 'update' then prior.patch else null end, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb);
    final_op := 'update';
  end if;
  insert into public.msgr_crew_routine_edits(routine_id, owner_user_id, op, patch, created_by)
    values (p_routine, auth.uid(), final_op, merged, auth.uid()) returning * into e;
  return to_jsonb(e);
end $$;

-- PC → 서버: 이 조직에서 **내 크루 목록(p_crews)에 한정해** 대기 편집을 가져온다.
-- H2: 크루로 거르지 않으면, PC가 다른 워크스페이스(다른 로컬 폴더)의 크루가 낀 org의 편집까지 끌어와 로컬에 없는
-- routine으로 오판(noop)해 applied로 닫아버린다 — 실제로는 그 편집이 아직 처리된 적이 없는데도 사라진다.
-- 이 마이그레이션은 아직 라이브에 적용하지 않았다(코드 리뷰 중 인자가 uuid 1개 → uuid,uuid[] 2개로 바뀜) — 개별
-- 함수 라이브 적용(scripts/msgr-live-apply.sh) 등으로 옛 1-인자 버전이 어딘가(스테이징 등) 이미 존재할 가능성을 막는다.
drop function if exists public.msgr_crew_routine_edits_pending(uuid);
create function public.msgr_crew_routine_edits_pending(p_org uuid, p_crews uuid[]) returns table(edit_id uuid, routine_id uuid, crew_id uuid, ext_id text, op text, patch jsonb, created_at timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.id, e.routine_id, r.crew_id, r.ext_id, e.op, e.patch, e.created_at
    from public.msgr_crew_routine_edits e join public.msgr_crew_routines r on r.id = e.routine_id
    where e.status = 'pending' and r.org_id = p_org and r.owner_user_id = auth.uid() and r.crew_id = any(coalesce(p_crews, '{}'::uuid[]))
    order by e.created_at asc
$$;

-- PC → 서버: 적용 결과를 되써준다. applied/failed = 실제 적용 시도 결과(적용할 로컬 루틴이 없는 경우도 failed).
-- superseded = PC 쪽 루틴이 이 편집보다 나중에(editedAt) 바뀌어 있어 "나중 수정이 이긴다" 규칙으로 버린 경우, 또는
-- 한 크루가 여러 조직에 파견돼 같은 루틴(ext_id)에 중복 편집이 쌓였을 때 더 오래된 쪽(H4). replaced는 메신저 쪽 폴드
-- 전용(서버가 msgr_crew_routine_edit에서 직접 찍는다) — PC는 replaced를 쓸 일이 없지만 done 경로도 막지 않는다.
create function public.msgr_crew_routine_edit_done(p_id uuid, p_status text, p_error text default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or p_status not in ('applied','failed','superseded','replaced') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  update public.msgr_crew_routine_edits set status = p_status, error = p_error, applied_at = now()
    where id = p_id and owner_user_id = auth.uid() and status = 'pending';
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  return true;
end $$;

revoke all on function public.msgr_crew_routines_sync(uuid,uuid,jsonb), public.msgr_crew_routine_edit(uuid,text,jsonb),
  public.msgr_crew_routine_edits_pending(uuid,uuid[]), public.msgr_crew_routine_edit_done(uuid,text,text) from public,anon,authenticated;
grant execute on function public.msgr_crew_routines_sync(uuid,uuid,jsonb), public.msgr_crew_routine_edit(uuid,text,jsonb),
  public.msgr_crew_routine_edits_pending(uuid,uuid[]), public.msgr_crew_routine_edit_done(uuid,text,text) to authenticated;

-- M5: 오프보딩(msgr_member_offboard가 크루를 detached로 돌림)·수동 detach·회수(available)로 상태가 active를 벗어나면
-- 그 크루의 미러 행을 지운다(edits는 FK on delete cascade로 함께 사라진다). 되살아나도(active 복귀) 다음 sync가 다시 채운다.
create function public.msgr_crew_routines_offboard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  delete from public.msgr_crew_routines where crew_id = new.id;
  return new;
end $$;
revoke all on function public.msgr_crew_routines_offboard() from public,anon,authenticated;
create trigger msgr_crew_routines_offboard after update of status on public.msgr_crews
  for each row when (old.status = 'active' and new.status is distinct from 'active') execute function public.msgr_crew_routines_offboard();

-- DB 위생: 처리된 편집(applied/replaced/superseded/failed — L5: failed도 진단 가치가 소진되면 정리 대상)은 30일 뒤 정리.
-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-msgr-crew-routine-edits', '23 3 * * *',
      $c$delete from public.msgr_crew_routine_edits where status in ('applied','replaced','superseded','failed') and coalesce(applied_at,created_at) < now() - interval '30 days'$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
