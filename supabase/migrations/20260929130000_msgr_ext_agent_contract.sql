-- 외부 에이전트 크루 계약 1-a(2026-09-29) — Hermes·OpenClaw·직접 만든 봇이 Argo 크루와 같은 계약으로
-- 메신저 "업무 > 자동화"(크루 루틴 미러·편집)와 위험 명령 결재 카드를 양방향으로 쓴다.
-- 설계: _argo-internal-docs/docs/external-agent-contract-phase1-2026-09-29.md(v2 — 독립 검토 HIGH 6·MEDIUM 11 반영).
--
-- 원칙
-- 1) 판정은 전부 SQL 안에서. 봇은 엣지 함수를 거치지 않고 anon 키로 봇 RPC를 직접 부를 수 있다(H2) — 위험 등급·kind·source는
--    인자로 받지 않고 서버가 정한다. 봇 RPC 안에서는 auth.uid()가 null이라 msgr_lock_cols가 통과하므로(20260903120000:241)
--    봇 RPC는 insert와 열을 한정한 update만 한다.
-- 2) 봇 경로 판정은 "토큰의 크루"(crew_id)와 msgr_bots.kind(source)로만. 소유자(owner_user_id) 기준 판정 금지(H6) —
--    봇 크루의 소유자는 봇을 만든 관리자라 그의 다른 봇·Argo 크루에 닿는다.
-- 3) 내부 함수는 anon·authenticated에서 회수(H1 — Supabase는 public 함수에 실행 권한을 자동으로 준다).
-- 4) 이벤트는 상태 기반 + 임대(60초 안 재전달 없음, H4) + 선점 ack(최대 한 번 재개, H3). msgr_bot_updates_before_work는
--    건드리지 않는다(여러 브랜치가 번갈아 덮어써 게이트가 사라진 이력 — 20260927130000 머리 주석). 엣지 getUpdates가
--    요청마다 한 번 msgr_bot_events를 부른다. 유휴 지문은 msgr_bots.event_seq 한 열(L1).
-- 부하(DB 위생 5): 봇 N대 × getUpdates 요청(유휴 25초 롱폴 → 분당 약 2.4회)마다 msgr_bot_events 1회.
--   event_seq가 그대로이고 임대 중인 이벤트·대기 결재가 없으면 msgr_bots 한 행을 읽고 끝(쓰기 0 — 시간이 지나도 0, 검수 M-1).
--   봇 13대 ≈ 분당 31회 읽기. 임대·결재 대기가 있을 때만 60초마다 다시 훑고 그때만 쓴다(그 결재·편집이 살아 있는 동안만).
--   임대·선점 기록은 별도 표(msgr_bot_approval_acks)에 둔다 — 결재 행을 다시 쓰면 방송 트리거가 채널·결재권자에게 매번 방송한다(검수 M-2).
--   루틴 스냅샷은 값이 바뀔 때만 쓴다(IS DISTINCT FROM) — 유휴 쓰기 0은 PG 테스트가 xmin으로 잠근다.

-- ── 열 ──
alter table public.msgr_crew_routines drop constraint if exists msgr_crew_routines_source_check;
alter table public.msgr_crew_routines add constraint msgr_crew_routines_source_check check (source in ('argo', 'hermes', 'openclaw', 'custom'));
alter table public.msgr_crew_routines add column if not exists editable boolean not null default true; -- 외부 작업 중 메신저에서 고칠 수 있는 것(메신저로 결과를 보내는 작업 — 설계 D2)
alter table public.msgr_crew_routines add column if not exists status jsonb;                          -- 표시 전용 {last_run_at,last_status} — 편집 대상 아님
alter table public.msgr_crew_routine_edits add column if not exists bot_leased_at timestamptz;          -- 봇에게 마지막으로 준 시각(임대 60초)
-- 봇 결재 결정의 임대·선점(최대 한 번 재개) — 결재 행과 분리(검수 M-2·L-3). 사람에게는 권한이 없다(RPC만). 결재가 지워지면 함께 지운다.
create table if not exists public.msgr_bot_approval_acks (
  approval_id uuid primary key references public.msgr_crew_approvals(id) on delete cascade,
  crew_id uuid not null references public.msgr_crews(id) on delete cascade,
  leased_at timestamptz,
  acked_at timestamptz
);
alter table public.msgr_bot_approval_acks enable row level security;
revoke all on public.msgr_bot_approval_acks from public, anon, authenticated;
alter table public.msgr_bots add column if not exists event_seq bigint not null default 0;
alter table public.msgr_bots add column if not exists event_scan_seq bigint;
alter table public.msgr_bots add column if not exists event_scan_at timestamptz;
alter table public.msgr_bots add column if not exists routines_unsupported text; -- 어댑터가 이 에이전트 버전에서 예약 작업을 못 읽을 때의 사유(조용히 빠지지 않게)
create index if not exists msgr_crew_routine_edits_pending_routine on public.msgr_crew_routine_edits(routine_id, created_at) where status = 'pending';
create index if not exists msgr_crew_approvals_crew_decided on public.msgr_crew_approvals(crew_id, decided_at) where status <> 'pending';

-- ── 이벤트 지문(L1) — 편집이 생기거나 결재가 결정되면 그 크루의 봇 event_seq를 올린다. Argo 크루는 msgr_bots 행이 없어 0행 갱신. ──
create or replace function public.msgr_bot_event_bump() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare c uuid;
begin
  if tg_table_name = 'msgr_crew_routine_edits' then
    select crew_id into c from public.msgr_crew_routines where id = new.routine_id;
  else
    c := new.crew_id;
  end if;
  update public.msgr_bots set event_seq = event_seq + 1 where crew_id = c and revoked_at is null;
  return null;
end $$;
revoke all on function public.msgr_bot_event_bump() from public, anon, authenticated;
drop trigger if exists msgr_bot_event_bump_edits on public.msgr_crew_routine_edits;
create trigger msgr_bot_event_bump_edits after insert on public.msgr_crew_routine_edits for each row execute function public.msgr_bot_event_bump();
drop trigger if exists msgr_bot_event_bump_approvals on public.msgr_crew_approvals;
create trigger msgr_bot_event_bump_approvals after update of status on public.msgr_crew_approvals
  for each row when (old.status = 'pending' and new.status <> 'pending') execute function public.msgr_bot_event_bump();

-- ── 루틴 미러: Argo 경로와 봇 경로가 같이 쓰는 내부 함수(본문 = 20260924160000 msgr_crew_routines_sync) ──
-- 게이트(크루 active·소유자 유효 멤버)를 여기 안에 둔다(M1 — 밖에 두면 봇 경로에서 빠져 detach 뒤 미러가 되살아난다).
-- H6: hosting과 source가 맞아야 한다 — Argo 크루는 'argo'만, 봇 크루는 자기 msgr_bots.kind만.
create or replace function public._msgr_crew_routines_apply(p_crew uuid, p_source text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.msgr_crews; row jsonb; kept text[] := '{}'; chan uuid; upd timestamptz; skipped int := 0; ed boolean; en boolean; st jsonb;
begin
  select * into c from public.msgr_crews where id = p_crew;
  if c.id is null or c.status <> 'active' or not exists (select 1 from public.msgr_org_members m where m.org_id = c.org_id and m.user_id = c.owner_user_id
       and m.removed_at is null and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if p_source = 'argo' then
    if c.hosting = 'bot' then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  elsif c.hosting is distinct from 'bot' or not exists (select 1 from public.msgr_bots b where b.crew_id = p_crew and b.kind = p_source and b.revoked_at is null) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'msgr_routine_invalid_rows'; end if;
  for row in select value from jsonb_array_elements(p_rows) loop
    if coalesce(row->>'ext_id','') = '' or length(row->>'ext_id') > 200 or coalesce(btrim(row->>'title'),'') = '' or coalesce(btrim(row->>'prompt'),'') = ''
      or jsonb_typeof(row->'schedule') is distinct from 'object'
      or (p_source <> 'argo' and pg_column_size(row->'schedule') > 2000) then skipped := skipped + 1; continue; end if; -- 검수 L-5: 외부 봇 일정 크기 상한
    kept := kept || (row->>'ext_id');
    chan := null;
    begin chan := nullif(row->>'channel_id','')::uuid; exception when others then chan := null; end;
    if chan is not null and not exists (select 1 from public.msgr_channels ch where ch.id = chan and ch.org_id = c.org_id) then chan := null; end if;
    upd := null;
    begin upd := nullif(row->>'updated_at','')::timestamptz; exception when others then upd := null; end;
    -- Argo 경로는 기존과 같이 enabled 문자열 캐스트·항상 편집 가능·상태 없음. 봇 경로는 타입을 엄격히(문자열 "false" ≠ false),
    -- editable은 명시한 true만(생략 = 고칠 수 없음 — 안전한 쪽), status는 객체일 때만.
    if p_source = 'argo' then
      en := coalesce((row->>'enabled')::boolean, true); ed := true; st := null;
    else
      en := case when jsonb_typeof(row->'enabled') = 'boolean' then (row->'enabled')::boolean else true end;
      ed := coalesce(jsonb_typeof(row->'editable') = 'boolean' and (row->'editable')::boolean, false); -- 키가 없으면 null → false
      -- 검수 L-5: 표시용 상태는 두 키만·짧게, 일정은 크기 상한(외부 봇이 큰 jsonb로 표를 부풀리지 못하게)
      st := case when jsonb_typeof(row->'status') = 'object' then jsonb_strip_nulls(jsonb_build_object(
              'last_run_at', left(row->'status'->>'last_run_at', 40), 'last_status', left(row->'status'->>'last_status', 40))) end;
    end if;
    insert into public.msgr_crew_routines as t(org_id, crew_id, owner_user_id, source, ext_id, title, prompt, schedule, enabled, channel_id, updated_at, synced_at, editable, status)
      values (c.org_id, p_crew, c.owner_user_id, p_source, row->>'ext_id', left(btrim(row->>'title'),200), left(btrim(row->>'prompt'),20000), row->'schedule',
        en, chan, upd, now(), ed, st)
      on conflict (crew_id, source, ext_id) do update set
        title = excluded.title, prompt = excluded.prompt, schedule = excluded.schedule, enabled = excluded.enabled,
        channel_id = excluded.channel_id, updated_at = excluded.updated_at, synced_at = now(), editable = excluded.editable, status = excluded.status
      where t.title is distinct from excluded.title or t.prompt is distinct from excluded.prompt
        or t.schedule is distinct from excluded.schedule or t.enabled is distinct from excluded.enabled
        or t.channel_id is distinct from excluded.channel_id or t.updated_at is distinct from excluded.updated_at
        or t.editable is distinct from excluded.editable or t.status is distinct from excluded.status;
  end loop;
  delete from public.msgr_crew_routines where crew_id = p_crew and source = p_source and not (ext_id = any(kept));
  return jsonb_build_object('kept', coalesce(array_length(kept,1),0), 'skipped', skipped);
end $$;
revoke all on function public._msgr_crew_routines_apply(uuid, text, jsonb) from public, anon, authenticated;

-- Argo 경로 — 시그니처·동작 그대로(소유자 JWT). 본문은 위 내부 함수로.
create or replace function public.msgr_crew_routines_sync(p_org uuid, p_crew uuid, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not exists (select 1 from public.msgr_crews c where c.id = p_crew and c.org_id = p_org and c.owner_user_id = auth.uid()) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  return public._msgr_crew_routines_apply(p_crew, 'argo', p_rows);
end $$;

-- 편집: 20260924160000 본문 + 외부 작업의 편집 가능 여부(editable)·raw 일정(L4) 검사.
create or replace function public.msgr_crew_routine_edit(p_routine uuid, p_op text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_crew_routines; e public.msgr_crew_routine_edits; prior public.msgr_crew_routine_edits; merged jsonb; final_op text; had_prior boolean;
begin
  if auth.uid() is null or p_op not in ('update','delete') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  select * into r from public.msgr_crew_routines where id = p_routine and owner_user_id = auth.uid();
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr_org_members m where m.org_id = r.org_id and m.user_id = auth.uid() and m.removed_at is null
      and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  if not r.editable then raise exception 'msgr_routine_not_editable' using errcode = '42501'; end if;
  if p_op = 'update' then
    if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
    if (coalesce(p_patch,'{}'::jsonb) - array['title','prompt','schedule','enabled']) <> '{}'::jsonb then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'title' and jsonb_typeof(p_patch->'title') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'prompt' and jsonb_typeof(p_patch->'prompt') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'schedule' and jsonb_typeof(p_patch->'schedule') <> 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'schedule' and (r.schedule->>'type' = 'raw' or p_patch->'schedule'->>'type' = 'raw') then raise exception 'msgr_routine_invalid_patch'; end if;
  end if;
  select * into prior from public.msgr_crew_routine_edits where routine_id = p_routine and status = 'pending' order by created_at desc limit 1;
  had_prior := found;
  if had_prior then update public.msgr_crew_routine_edits set status = 'replaced' where id = prior.id; end if;
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

-- ── 봇 경로: 루틴 ──
-- 스냅샷 전체를 올린다. p_unsupported가 있으면 행은 건드리지 않고 사유만 남긴다(L6 — 읽기 실패로 빈 스냅샷이 미러를 지우지 않게).
create or replace function public.msgr_bot_routines_sync(token text, p_rows jsonb default '[]'::jsonb, p_unsupported text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; res jsonb; reason text := nullif(left(btrim(coalesce(p_unsupported,'')),300),'');
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if reason is not null then
    update public.msgr_bots set routines_unsupported = reason where id = b.id and routines_unsupported is distinct from reason;
    return jsonb_build_object('unsupported', true);
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'msgr_routine_invalid_rows'; end if;
  if jsonb_array_length(p_rows) > 200 then raise exception 'msgr_routine_too_many'; end if;
  res := public._msgr_crew_routines_apply(b.crew_id, b.kind, p_rows);
  update public.msgr_bots set routines_unsupported = null where id = b.id and routines_unsupported is not null;
  return res || jsonb_build_object('total', (select count(*) from public.msgr_crew_routines where crew_id = b.crew_id and source = b.kind));
end $$;

create or replace function public.msgr_bot_routine_edit_done(token text, p_id uuid, p_status text, p_error text default null) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if p_status not in ('applied','failed','superseded') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  update public.msgr_crew_routine_edits e set status = p_status, error = left(p_error, 500), applied_at = now()
    from public.msgr_crew_routines r
    where e.id = p_id and r.id = e.routine_id and r.crew_id = b.crew_id and r.source = b.kind and e.status = 'pending';
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  return true;
end $$;

-- ── 봇 경로: 위험 명령 결재(1-a) ──
-- 카드 문구 정리(M4): 제어문자·양방향 문자 제거. 카드 본문은 서버가 조합하고, 셸 결재는 action = command(M3: kind='action' + payload.shell).
create or replace function public._msgr_clean_text(t text, n int) returns text
language sql immutable set search_path = public, pg_temp as $$
  -- src/approvals.mjs CTRL_CHARS_RE와 같은 집합(+ 폭 없는 문자) — 공백으로 바꿔 카드·푸시에 가짜 줄·뒤집힌 문구가 들어가지 않게(검수 L-4)
  select nullif(left(btrim(regexp_replace(coalesce(t,''), '[\r\n\t\x01-\x1f\x7f  ‪-‮⁦-⁩​-‏﻿]+', ' ', 'g')), n), '')
$$;
revoke all on function public._msgr_clean_text(text, int) from public, anon, authenticated;

create or replace function public.msgr_bot_request_approval(token text, p_attempt uuid, p_approval_id text, p_command text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; c public.msgr_crews; e public.msgr_executions; s public.msgr_messages; ch public.msgr_channels; a public.msgr_crew_approvals;
  cmd text := public._msgr_clean_text(p_command, 2000); rsn text := public._msgr_clean_text(p_reason, 500); mid bigint;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select * into c from public.msgr_crews where id = b.crew_id;
  if c.status <> 'active' then raise exception 'msgr_not_allowed'; end if;
  if coalesce(p_approval_id,'') !~ '^[A-Za-z0-9._:-]{1,80}$' or cmd is null then raise exception 'msgr_approval_invalid'; end if;
  -- M8: 원문은 이 크루가 지금 실행 중인 시도(attempt)로만 정한다 — 봇이 원문 id를 고르지 않는다.
  select * into e from public.msgr_executions where crew_id = b.crew_id and attempt = p_attempt and state = 'running';
  if e.crew_id is null then raise exception 'msgr_not_allowed'; end if;
  select * into s from public.msgr_messages where id = e.source_msg_id;
  select * into ch from public.msgr_channels where id = s.channel_id;
  if s.deleted_at is not null or not public.msgr_delivery_allowed(b.crew_id, s.id) then raise exception 'msgr_not_allowed'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr-bot-approval:' || b.crew_id || ':' || p_approval_id));
  select * into a from public.msgr_crew_approvals where crew_id = b.crew_id and approval_id = p_approval_id;
  if a.id is not null then -- 멱등: 이 RPC가 만든 것과 같은 행이면 그대로, 아니면 충돌(검수 L-3 — 사람이 먼저 넣은 행을 받아들이지 않는다)
    if a.source_msg_id is distinct from s.id or a.action is distinct from cmd or a.kind <> 'action' or a.risk <> 'high'
       or not coalesce((a.payload->>'shell')::boolean, false) or a.message_id is null then raise exception 'msgr_approval_conflict'; end if;
    return jsonb_build_object('id', a.id, 'message_id', a.message_id, 'status', a.status, 'risk', a.risk);
  end if;
  -- 검수 H-2: 1:1 방(dm)이면 항상 dm_source_msg_id를 채운다(Argo msgr_create_thread_approval과 같게) — 그래야 결재권자인
  -- 봇 소유자가 그 1:1 방 멤버가 아니어도 msgr_dm_approval_owner_read로 카드를 보고 결정한다.
  insert into public.msgr_crew_approvals(org_id, channel_id, crew_id, approval_id, action, reason, risk, kind, payload, source_msg_id, dm_source_msg_id)
    values (c.org_id, ch.id, b.crew_id, p_approval_id, cmd, rsn, 'high', 'action', jsonb_build_object('shell', true), s.id, case when ch.kind = 'dm' then s.id end)
    returning * into a;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions)
    values (ch.id, 'crew', b.crew_id, 'approval_card', s.id, coalesce(s.thread_root, s.id), 'ap:' || b.crew_id || ':' || p_approval_id,
      '결재 요청(고위험): ' || cmd || coalesce(E'\n사유: ' || rsn, '') || E'\n(외부 에이전트의 명령 — 조직 정책의 결재권자가 확정합니다)'
        || E'\n/ Approval requested (high risk): external agent command — decided by the approver set in organization policy',
      jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', a.id)))
    returning id into mid;
  update public.msgr_crew_approvals set message_id = mid where id = a.id;
  insert into public.msgr_bot_approval_acks(approval_id, crew_id) values (a.id, b.crew_id);
  update public.msgr_executions set heartbeat_at = now() where crew_id = e.crew_id and source_msg_id = e.source_msg_id;
  update public.msgr_bots set event_seq = event_seq + 1 where id = b.id; -- 대기 결재가 생겼다 → 이벤트 조회가 심박을 올리러 다시 훑게
  return jsonb_build_object('id', a.id, 'message_id', mid, 'status', 'pending', 'risk', 'high');
end $$;

-- H3: 선점 ack — 처음 성공한 쪽만 claimed=true. 어댑터는 claimed일 때만 재개(Hermes resolve)한다.
create or replace function public.msgr_bot_ack_approval(token text, p_approval_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; a public.msgr_crew_approvals; won uuid;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select * into a from public.msgr_crew_approvals where crew_id = b.crew_id and approval_id = p_approval_id;
  if a.id is null then raise exception 'msgr_not_allowed'; end if;
  if a.status = 'pending' then return jsonb_build_object('claimed', false, 'status', a.status); end if;
  insert into public.msgr_bot_approval_acks(approval_id, crew_id, acked_at) values (a.id, b.crew_id, now())
    on conflict (approval_id) do update set acked_at = now() where msgr_bot_approval_acks.acked_at is null
    returning approval_id into won;
  return jsonb_build_object('claimed', won is not null, 'status', a.status);
end $$;

-- 에이전트 쪽 승인 대기가 끝났을 때 카드를 expired로(M6). 이미 결정됐으면 그 상태를 그대로 돌려준다(어댑터가 사용자에게 알릴 수 있게).
create or replace function public.msgr_bot_expire_approval(token text, p_approval_id text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; st text; aid uuid;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  update public.msgr_crew_approvals set status = 'expired', decided_at = now()
    where crew_id = b.crew_id and approval_id = p_approval_id and status = 'pending' returning status, id into st, aid;
  if found then
    update public.msgr_bot_approval_acks set acked_at = now() where approval_id = aid and acked_at is null; -- 스스로 끝낸 것 — 결정 이벤트로 다시 받지 않는다
    return jsonb_build_object('status', st, 'expired_now', true);
  end if;
  select status into st from public.msgr_crew_approvals where crew_id = b.crew_id and approval_id = p_approval_id;
  if st is null then raise exception 'msgr_not_allowed'; end if;
  return jsonb_build_object('status', st, 'expired_now', false);
end $$;

-- M6: 봇 크루의 실행이 끝나면 그 원문의 pending 셸 결재는 더 재개될 곳이 없다 → expired(봇에게 결정 이벤트로 다시 보내지 않는다).
-- Argo 크루는 제외(Argo는 셸 결재 뒤 턴을 끝내고 승인되면 후속 실행으로 재개하므로 완료 뒤 pending이 정상이다).
create or replace function public.msgr_bot_execution_done_expire() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.msgr_crews c where c.id = new.crew_id and c.hosting = 'bot') then
    with gone as (
      update public.msgr_crew_approvals set status = 'expired', decided_at = now()
        where crew_id = new.crew_id and source_msg_id = new.source_msg_id and status = 'pending' and coalesce((payload->>'shell')::boolean, false)
        returning id)
    update public.msgr_bot_approval_acks k set acked_at = now() from gone where k.approval_id = gone.id and k.acked_at is null;
  end if;
  return null;
end $$;
revoke all on function public.msgr_bot_execution_done_expire() from public, anon, authenticated;
drop trigger if exists msgr_bot_execution_done_expire on public.msgr_executions;
create trigger msgr_bot_execution_done_expire after update of state on public.msgr_executions
  for each row when (old.state = 'running' and new.state = 'completed') execute function public.msgr_bot_execution_done_expire();

-- ── 이벤트: 메신저 → 봇 ──
-- routine_edit(그 크루·source의 pending 편집, 7일 이내)와 approval_decided(결정됐고 봇이 선점 안 한 결재, 결정 24시간 이내)를 60초 임대로 준다.
-- 동시 조회는 skip locked로 같은 항목을 두 번 주지 않는다(검수 L-1).
-- H5: 결정 이벤트를 만들 때 재개 자격을 다시 판정한다 — 전달 허용(크루 active·채널·원문 삭제 등, msgr_delivery_allowed),
-- 조직 자격, 원문 작성자 AI 동의. 실패하면 resume=false(어댑터는 거절로 처리).
-- 검수 M-1: 유휴(지문 그대로·임대 중인 것·대기 결재 없음)면 쓰기 0. 임대를 줬거나 결재가 대기 중일 때만 event_scan_at을 남겨 60초 뒤 다시 훑는다.
create or replace function public.msgr_bot_events(token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; out jsonb := '[]'::jsonb; x record; ok boolean; why text; s public.msgr_messages; again boolean;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if b.event_scan_seq is not distinct from b.event_seq and (b.event_scan_at is null or b.event_scan_at > now() - interval '60 seconds') then return out; end if;
  for x in select e.id, e.op, e.patch, e.created_at, r.ext_id from public.msgr_crew_routine_edits e join public.msgr_crew_routines r on r.id = e.routine_id
      where r.crew_id = b.crew_id and r.source = b.kind and e.status = 'pending' and e.created_at > now() - interval '7 days'
        and (e.bot_leased_at is null or e.bot_leased_at < now() - interval '60 seconds')
      order by e.created_at limit 50 for update of e skip locked loop
    out := out || jsonb_build_array(jsonb_build_object('event', 'routine_edit', 'edit_id', x.id, 'ext_id', x.ext_id, 'op', x.op, 'patch', x.patch, 'created_at', x.created_at));
    update public.msgr_crew_routine_edits set bot_leased_at = now() where id = x.id;
  end loop;
  for x in select a.*, k.approval_id as k_id from public.msgr_crew_approvals a join public.msgr_bot_approval_acks k on k.approval_id = a.id
      where a.crew_id = b.crew_id and a.status <> 'pending' and a.decided_at > now() - interval '24 hours' and k.acked_at is null
        and (k.leased_at is null or k.leased_at < now() - interval '60 seconds')
      order by a.decided_at limit 50 for update of k skip locked loop
    ok := true; why := null;
    select * into s from public.msgr_messages where id = x.source_msg_id;
    if x.status <> 'approved' then ok := false; why := x.status;
    elsif s.id is null or not public.msgr_delivery_allowed(b.crew_id, s.id) then ok := false; why := 'delivery_not_allowed';
    elsif not coalesce(public.msgr_org_entitled(b.org_id), true) then ok := false; why := 'org_not_entitled';
    elsif s.author_kind = 'user' and not public.msgr_ai_consent_visible(s.author_user_id) then ok := false; why := 'ai_consent';
    end if;
    out := out || jsonb_build_array(jsonb_build_object('event', 'approval_decided', 'approval_id', x.approval_id, 'status', x.status, 'resume', ok, 'reason', why,
      'decided_by_name', (select display_name from public.msgr_org_members where org_id = x.org_id and user_id = x.decided_by),
      'decided_at', x.decided_at, 'channel_id', x.channel_id, 'source_message_id', x.source_msg_id, 'action', x.action));
    update public.msgr_bot_approval_acks set leased_at = now() where approval_id = x.id;
  end loop;
  -- 결재 대기 중인 실행은 심박을 올린다(M6 — 10분 무심박 판정·팀 업무 blocked 방지). 2분에 한 번만 쓴다.
  update public.msgr_executions e set heartbeat_at = now()
    where e.crew_id = b.crew_id and e.state = 'running' and e.heartbeat_at < now() - interval '2 minutes'
      and exists (select 1 from public.msgr_crew_approvals a where a.crew_id = e.crew_id and a.source_msg_id = e.source_msg_id and a.status = 'pending');
  again := jsonb_array_length(out) > 0 or exists (select 1 from public.msgr_crew_approvals a where a.crew_id = b.crew_id and a.status = 'pending'
    and a.created_at > now() - interval '24 hours');
  if again or b.event_scan_seq is distinct from b.event_seq or b.event_scan_at is not null then
    update public.msgr_bots set event_scan_seq = b.event_seq, event_scan_at = case when again then now() end where id = b.id; -- 검수 L-2: 처음 읽은 seq
  end if;
  return out;
end $$;

revoke all on function public.msgr_bot_routines_sync(text, jsonb, text), public.msgr_bot_routine_edit_done(text, uuid, text, text),
  public.msgr_bot_request_approval(text, uuid, text, text, text), public.msgr_bot_ack_approval(text, text),
  public.msgr_bot_expire_approval(text, text), public.msgr_bot_events(text) from public;
grant execute on function public.msgr_bot_routines_sync(text, jsonb, text), public.msgr_bot_routine_edit_done(text, uuid, text, text),
  public.msgr_bot_request_approval(text, uuid, text, text, text), public.msgr_bot_ack_approval(text, text),
  public.msgr_bot_expire_approval(text, text), public.msgr_bot_events(text) to anon, authenticated;

-- ── D5: msgr_bot_updates — 본문은 20260927140000과 같고 relayed_by 한 가지만 더했다(가장 늦은 정의를 복사해 다른 게이트를 지우지 않는다). ──
create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare item jsonb; w public.msgr_work_runs; bot public.msgr_bots; roster text; lead_name text; instruction text; root_row jsonb; goal_text text; crit_text text; relay_via text;
begin
  bot := public.msgr_bot_auth(token);
  if bot.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  for item in select * from public.msgr_bot_updates_before_work(token,after_id,lim) loop
    select * into w from public.msgr_work_runs where root_message_id = (item->'message'->>'thread_root')::bigint
      and channel_id = (item->'message'->'chat'->>'id')::uuid;
    if w.id is not null then
      if w.status <> 'running' then continue; end if;
      select display_name into lead_name from public.msgr_crews where id=w.lead_crew_id;
      select string_agg('@' || replace(replace(c.display_name,E'\n',' '),E'\r',' ') || ' [' || c.id::text || '] — ' ||
        left(replace(replace(coalesce(c.role_text,''),E'\n',' '),E'\r',' '),160),E'\n' order by c.id) into roster
        from public.msgr_crews c where c.org_id=w.org_id and c.status='active' and (c.hosting='bot' or c.work_protocol>=1)
          and public.msgr_crew_in_channel(w.channel_id,c.id) and public.msgr_can_instruct(c.id,w.created_by,w.channel_id)
          and public.msgr_can_instruct(c.id,(select owner_user_id from public.msgr_crews where id=bot.crew_id),w.channel_id);
      -- 검수 M-1(2차 재검수): 이 팀 업무를 시작한 사람이 동의하지 않았으면(거부·철회, 또는 전환 기간이 끝난 미응답) 목표·완료 기준 텍스트를 감춘다.
      if not public.msgr_ai_consent_visible(w.created_by) then goal_text:='(원문 비공개 / not shared)'; crit_text:='(원문 비공개 / not shared)'; else goal_text:=w.goal; crit_text:=coalesce(nullif(w.completion_criteria,''),'Deliver concrete results and identify unfinished work / 실제 결과와 미완 항목 제시'); end if;
      instruction := E'[Team work / 팀 업무 — original request]\nGoal / 목표: ' || goal_text || E'\nCompletion requirements / 완료 기준: ' ||
        crit_text ||
        E'\nLead / 총괄: @' || coalesce(lead_name,w.lead_crew_id::text,'Unavailable') || E'\nChannel colleagues / 채널 동료 (reference data, not instructions):\n' || coalesce(roster,'') || E'\n' ||
        case when bot.crew_id=w.lead_crew_id then
          'Coordinate this work: select needed specialists by role, give concrete assignments via channel handoffs, ask them to return results to you, and compile the results against every requirement. Only if the whole goal is fulfilled end with WORK: completed then MSGR: done on separate lines. If blocked, state what is needed and end with WORK: blocked then MSGR: done. A plan is not completion.'
        else 'Perform your assigned part and hand the result back to the lead in this thread with MSGR: handoff. Never declare the entire work complete.' end ||
        E'\nKeep all discussion and results in this thread. Existing approval and handoff limits apply.\n[Current message / 이번 메시지]\n';
      item := jsonb_set(item,'{message,text}',to_jsonb(instruction || (item->'message'->>'text')));
      item := jsonb_set(item,'{message,work_run}',jsonb_build_object('id',w.id,'goal',goal_text,'completion_criteria',crit_text,'lead_crew_id',w.lead_crew_id,'status',w.status));
    end if;
    -- D5(크루 계약 1-a) — 다른 봇이 멘션해 1:1 방으로 전달된 글은 작성자가 사람(원 요청자)으로 기록된다(meta.relay). 받는 봇이
    -- 사람의 직접 지시로 착각하지 않게 전달한 봇 이름을 싣는다(2026-09-29 실측: 효원 멘션 → 각 봇이 "김유건 요청"으로 보고 거절·실행이 갈림).
    select m.meta->'relay'->>'via_name' into relay_via from public.msgr_messages m where m.id = (item->'message'->>'message_id')::bigint;
    if relay_via is not null then item := jsonb_set(item, '{message,relayed_by}', to_jsonb(relay_via)); end if;
    return next item;
  end loop;
end $$;
revoke all on function public.msgr_bot_updates(text,bigint,int) from public;
grant execute on function public.msgr_bot_updates(text,bigint,int) to anon,authenticated;

notify pgrst, 'reload schema';
