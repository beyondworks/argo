-- 외부 에이전트 크루 계약 1-b(2026-09-29) — 누가 연결하든 같은 계약이 되도록, 1-a 운영 반영 때 VPS에서 손으로 한 일을 시스템으로 옮긴다.
-- 설계: _argo-internal-docs/docs/external-agent-contract-phase1-2026-09-29.md(1-b·H5·M7·M8·M11) + 2026-09-29 유건 결정(추천안 그대로):
--   ① 어댑터가 자기 버전·실제 승인 모드를 보고 → 메신저 에이전트 카드에 "업데이트 필요"·"위험 명령을 스스로 승인" 안내(설정 강제는 안 함)
--   ② "모든 예약 작업 보기"는 크루 소유자가 메신저에서 켠다(환경 변수 ARGO_MSGR_MIRROR_ALL 대신) — 켜도 메신저로 안 보내는 작업은 읽기 전용
--   ③ 결과를 보낼 곳이 없는 작업(status.delivery='none')은 소유자가 메신저에서 방을 고른다 — 소유자·그 봇의 1:1 방 또는 그 봇이 들어간 채널만
--   ④ 에이전트가 스스로 올리는 결재(도구) + 결정 뒤 한 번만 올리는 후속 보고. 기한 없음(D1), 기본 고위험(D6)
--
-- msgr_bots에는 열을 더하지 않는다: 1-a 적용 때 msgr_bots 열 추가 순간 기존 연결의 msgr_bot_auth(rowtype 반환) 실행 계획이 어긋나
-- 1회성 500이 났다(2026-09-29 21:17:52). 새 값은 별도 표 msgr_bot_state에, 루틴의 전달 상태는 기존 status jsonb에 둔다.
-- 부하(DB 위생 5): 보고는 값이 바뀔 때만 쓴다(IS DISTINCT FROM) — 어댑터는 연결 때 1회 + 바뀔 때만 보낸다(분당 0건이 평상시).
--   설정 이벤트는 event_seq가 바뀐 폴에서만 한 행을 더 읽는다. 후속 보고·결재는 사람이 결재할 때만 생긴다.

-- ── 봇 상태(보고·설정) ──
create table if not exists public.msgr_bot_state (
  bot_id uuid primary key references public.msgr_bots(id) on delete cascade,
  adapter_version text,          -- 어댑터가 보고한 자기 버전(예: '0.3.0'). 보고가 없으면(0.3.0 이전 어댑터) null → 화면은 "업데이트 필요"
  approval_mode text,            -- 에이전트의 실제 승인 모드('manual'·'smart'·'off'·'unknown' 등, 짧은 표시용)
  reported_at timestamptz,
  mirror_all boolean not null default false,   -- 소유자가 켠 "모든 예약 작업 보기"
  mirror_all_applied boolean                   -- 어댑터가 반영했다고 보고한 값(다르면 설정 이벤트를 준다)
);
alter table public.msgr_bot_state enable row level security;
revoke all on public.msgr_bot_state from public, anon, authenticated;
grant select on public.msgr_bot_state to authenticated;
drop policy if exists msgr_bot_state_select on public.msgr_bot_state;
create policy msgr_bot_state_select on public.msgr_bot_state for select to authenticated
  using (exists (select 1 from public.msgr_bots b where b.id = bot_id and public.msgr_is_admin(b.org_id))); -- msgr_bots와 같은 범위(조직 관리자)

-- 짧은 표시 문자열만(제어문자·과한 길이로 화면을 흔들지 못하게)
create or replace function public._msgr_short(t text, n int) returns text
language sql immutable set search_path = public, pg_temp as $$
  select nullif(left(regexp_replace(btrim(coalesce(t,'')), '[^A-Za-z0-9._+-]', '', 'g'), n), '')
$$;
revoke all on function public._msgr_short(text, int) from public, anon, authenticated;

-- ① 봇이 버전·승인 모드·설정 반영값을 보고한다. 값이 같으면 쓰지 않는다. 응답의 mirror_all로 어댑터가 곧바로 맞춘다.
create or replace function public.msgr_bot_report_status(token text, p_version text default null, p_approval_mode text default null, p_mirror_all_applied boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; st public.msgr_bot_state; v text := public._msgr_short(p_version, 40); m text := lower(public._msgr_short(p_approval_mode, 20));
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  insert into public.msgr_bot_state(bot_id) values (b.id) on conflict (bot_id) do nothing;
  update public.msgr_bot_state set adapter_version = coalesce(v, adapter_version), approval_mode = coalesce(m, approval_mode),
      mirror_all_applied = coalesce(p_mirror_all_applied, mirror_all_applied), reported_at = now()
    where bot_id = b.id and (adapter_version is distinct from coalesce(v, adapter_version) or approval_mode is distinct from coalesce(m, approval_mode)
      or mirror_all_applied is distinct from coalesce(p_mirror_all_applied, mirror_all_applied) or reported_at is null);
  select * into st from public.msgr_bot_state where bot_id = b.id;
  return jsonb_build_object('mirror_all', st.mirror_all);
end $$;

-- ② 소유자가 "모든 예약 작업 보기"를 켜고 끈다(D3과 같은 기준: 그 봇 크루의 소유자 = 봇을 만든 사람, 유효 멤버). 바뀔 때만 이벤트 지문을 올린다.
create or replace function public.msgr_bot_set_mirror_all(p_bot uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; changed uuid;
begin
  select * into b from public.msgr_bots where id = p_bot and revoked_at is null;
  if auth.uid() is null or p_on is null or b.id is null or not exists (select 1 from public.msgr_crews c where c.id = b.crew_id and c.owner_user_id = auth.uid())
     or not exists (select 1 from public.msgr_org_members m where m.org_id = b.org_id and m.user_id = auth.uid() and m.removed_at is null
       and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  insert into public.msgr_bot_state(bot_id, mirror_all) values (b.id, p_on)
    on conflict (bot_id) do update set mirror_all = excluded.mirror_all where msgr_bot_state.mirror_all is distinct from excluded.mirror_all
    returning bot_id into changed;
  if changed is not null then update public.msgr_bots set event_seq = event_seq + 1 where id = b.id; end if;
  return p_on;
end $$;

-- ── 루틴 미러: 1-a 본문 + status.delivery('none' = 결과를 보낼 곳이 없음, 'local' = 메신저 밖으로 보내는 작업)를 보존 ──
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
      or (p_source <> 'argo' and pg_column_size(row->'schedule') > 2000) then skipped := skipped + 1; continue; end if;
    kept := kept || (row->>'ext_id');
    chan := null;
    begin chan := nullif(row->>'channel_id','')::uuid; exception when others then chan := null; end;
    if chan is not null and not exists (select 1 from public.msgr_channels ch where ch.id = chan and ch.org_id = c.org_id) then chan := null; end if;
    upd := null;
    begin upd := nullif(row->>'updated_at','')::timestamptz; exception when others then upd := null; end;
    if p_source = 'argo' then
      en := coalesce((row->>'enabled')::boolean, true); ed := true; st := null;
    else
      en := case when jsonb_typeof(row->'enabled') = 'boolean' then (row->'enabled')::boolean else true end;
      ed := coalesce(jsonb_typeof(row->'editable') = 'boolean' and (row->'editable')::boolean, false);
      -- 1-b ③: delivery는 'none'·'local' 두 값만(메신저로 보내는 작업은 키 없음). 메신저로 보내는 작업(ed)에 'none'이 붙으면 버린다.
      st := case when jsonb_typeof(row->'status') = 'object' then jsonb_strip_nulls(jsonb_build_object(
              'last_run_at', left(row->'status'->>'last_run_at', 40), 'last_status', left(row->'status'->>'last_status', 40),
              'delivery', case when not ed and row->'status'->>'delivery' in ('none', 'local') then row->'status'->>'delivery' end)) end;
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

-- 보낼 방으로 고를 수 있는가(③): 같은 조직·보관 안 됨, 그리고 (소유자와 그 크루 둘만 있는 1:1 방) 또는 (그 크루가 들어간 채널).
create or replace function public._msgr_routine_channel_ok(p_crew uuid, p_owner uuid, p_channel uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_channels ch join public.msgr_crews c on c.id = p_crew and c.org_id = ch.org_id
    where ch.id = p_channel and ch.archived_at is null and (
      (ch.kind = 'dm'
        and exists (select 1 from public.msgr_channel_members m where m.channel_id = ch.id and m.member_kind = 'crew' and m.member_id = p_crew)
        and exists (select 1 from public.msgr_channel_members m where m.channel_id = ch.id and m.member_kind = 'user' and m.member_id = p_owner)
        and (select count(*) from public.msgr_channel_members m where m.channel_id = ch.id) = 2)
      or (ch.kind <> 'dm' and public.msgr_crew_in_channel(ch.id, p_crew))))
$$;
revoke all on function public._msgr_routine_channel_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- 편집: 1-a 본문 + 외부 작업의 보낼 방 지정(patch.channel_id). 보낼 곳이 없는 작업(status.delivery='none')은 읽기 전용이어도 방 지정만 받는다.
create or replace function public.msgr_crew_routine_edit(p_routine uuid, p_op text, p_patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_crew_routines; e public.msgr_crew_routine_edits; prior public.msgr_crew_routine_edits; merged jsonb; final_op text; had_prior boolean;
  chan uuid; route_only boolean;
begin
  if auth.uid() is null or p_op not in ('update','delete') then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  select * into r from public.msgr_crew_routines where id = p_routine and owner_user_id = auth.uid();
  if not found then raise exception 'msgr_routine_forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.msgr_org_members m where m.org_id = r.org_id and m.user_id = auth.uid() and m.removed_at is null
      and (m.expires_at is null or m.expires_at > now())) then
    raise exception 'msgr_routine_forbidden' using errcode = '42501';
  end if;
  -- 방 지정만 담은 수정: 외부 작업(source <> 'argo')이고, 고칠 수 있는 작업이거나 보낼 곳이 없는 작업일 때만
  route_only := p_op = 'update' and jsonb_typeof(p_patch) = 'object' and p_patch ? 'channel_id' and (p_patch - 'channel_id') = '{}'::jsonb;
  -- 검수 M-1: status가 없거나 delivery 키가 없으면 NULL → IF가 거짓으로 빠져 통과하던 빈틈. coalesce로 '보낼 곳 없음'만.
  if not r.editable and not (route_only and r.source <> 'argo' and coalesce(r.status->>'delivery', '') = 'none') then
    raise exception 'msgr_routine_not_editable' using errcode = '42501';
  end if;
  if p_op = 'update' then
    if jsonb_typeof(p_patch) is distinct from 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
    if (coalesce(p_patch,'{}'::jsonb) - array['title','prompt','schedule','enabled','channel_id']) <> '{}'::jsonb then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'enabled' and jsonb_typeof(p_patch->'enabled') <> 'boolean' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'title' and jsonb_typeof(p_patch->'title') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'prompt' and jsonb_typeof(p_patch->'prompt') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'schedule' and jsonb_typeof(p_patch->'schedule') <> 'object' then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'schedule' and (r.schedule->>'type' = 'raw' or p_patch->'schedule'->>'type' = 'raw') then raise exception 'msgr_routine_invalid_patch'; end if;
    if p_patch ? 'channel_id' then
      if r.source = 'argo' or jsonb_typeof(p_patch->'channel_id') <> 'string' then raise exception 'msgr_routine_invalid_patch'; end if;
      begin chan := (p_patch->>'channel_id')::uuid; exception when others then raise exception 'msgr_routine_invalid_patch'; end;
      if not public._msgr_routine_channel_ok(r.crew_id, auth.uid(), chan) then raise exception 'msgr_routine_invalid_channel' using errcode = '42501'; end if;
    end if;
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

-- ── ④ 에이전트가 스스로 올리는 결재(도구). 1-a 셸 결재(msgr_bot_request_approval)와 같은 원문 규칙(M8: 실행 중인 attempt),
--    다른 점: payload.agent(셸 아님 → 실행 완료 트리거가 만료시키지 않는다, D1 기한 없음), 등급 high 고정(D6), 카드 문구는 제목·사유. ──
-- 카드(결재 행 + 카드 메시지 + 선점 행) 만들기 — 에이전트 결재와 "승인된 결재에 이어서 올리는 결재"가 같이 쓴다. 1-a 셸 RPC는 건드리지 않는다.
create or replace function public._msgr_bot_approval_card(p_bot uuid, p_crew uuid, p_org uuid, p_src bigint, p_approval_id text, p_agent boolean,
  p_text text, p_reason text, p_extra jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.msgr_messages; ch public.msgr_channels; a public.msgr_crew_approvals; mid bigint;
  pl jsonb := case when p_agent then jsonb_build_object('agent', true) else jsonb_build_object('shell', true) end || coalesce(p_extra, '{}'::jsonb);
begin
  select * into s from public.msgr_messages where id = p_src;
  select * into ch from public.msgr_channels where id = s.channel_id;
  perform pg_advisory_xact_lock(hashtext('msgr-bot-approval:' || p_crew || ':' || p_approval_id));
  select * into a from public.msgr_crew_approvals where crew_id = p_crew and approval_id = p_approval_id;
  if a.id is not null then -- 멱등: 같은 원문·문구·종류면 그대로, 아니면 충돌(사람이 먼저 넣은 행·셸/에이전트 섞기 포함)
    if a.source_msg_id is distinct from s.id or a.action is distinct from p_text or a.kind <> 'action' or a.risk <> 'high'
       or coalesce((a.payload->>'agent')::boolean, false) is distinct from p_agent or coalesce((a.payload->>'shell')::boolean, false) is distinct from (not p_agent)
       or a.message_id is null then raise exception 'msgr_approval_conflict'; end if;
    return jsonb_build_object('id', a.id, 'message_id', a.message_id, 'status', a.status, 'risk', a.risk);
  end if;
  insert into public.msgr_crew_approvals(org_id, channel_id, crew_id, approval_id, action, reason, risk, kind, payload, source_msg_id, dm_source_msg_id)
    values (p_org, ch.id, p_crew, p_approval_id, p_text, p_reason, 'high', 'action', pl, s.id, case when ch.kind = 'dm' then s.id end)
    returning * into a;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions)
    values (ch.id, 'crew', p_crew, 'approval_card', s.id, coalesce(s.thread_root, s.id), 'ap:' || p_crew || ':' || p_approval_id,
      case when p_agent then
        '결재 요청: ' || p_text || coalesce(E'\n사유: ' || p_reason, '') || E'\n(외부 에이전트가 올린 결재 — 조직 정책의 결재권자가 확정하면 에이전트가 이어서 보고합니다)'
        || E'\n/ Approval requested by an external agent — once decided, the agent continues and reports back'
      else
        '결재 요청(고위험): ' || p_text || coalesce(E'\n사유: ' || p_reason, '') || E'\n(외부 에이전트의 명령 — 조직 정책의 결재권자가 확정합니다)'
        || E'\n/ Approval requested (high risk): external agent command — decided by the approver set in organization policy'
      end,
      jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', a.id)))
    returning id into mid;
  update public.msgr_crew_approvals set message_id = mid where id = a.id;
  insert into public.msgr_bot_approval_acks(approval_id, crew_id) values (a.id, p_crew);
  update public.msgr_bots set event_seq = event_seq + 1 where id = p_bot;
  return jsonb_build_object('id', a.id, 'message_id', mid, 'status', 'pending', 'risk', 'high');
end $$;
revoke all on function public._msgr_bot_approval_card(uuid, uuid, uuid, bigint, text, boolean, text, text, jsonb) from public, anon, authenticated;

create or replace function public.msgr_bot_request_agent_approval(token text, p_attempt uuid, p_approval_id text, p_title text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; c public.msgr_crews; e public.msgr_executions; s public.msgr_messages;
  ttl text := public._msgr_clean_text(p_title, 300); rsn text := public._msgr_clean_text(p_reason, 1000);
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select * into c from public.msgr_crews where id = b.crew_id;
  if c.status <> 'active' then raise exception 'msgr_not_allowed'; end if;
  if coalesce(p_approval_id,'') !~ '^[A-Za-z0-9._:-]{1,80}$' or ttl is null then raise exception 'msgr_approval_invalid'; end if;
  select * into e from public.msgr_executions where crew_id = b.crew_id and attempt = p_attempt and state = 'running';
  if e.crew_id is null then raise exception 'msgr_not_allowed'; end if;
  select * into s from public.msgr_messages where id = e.source_msg_id;
  if s.deleted_at is not null or not public.msgr_delivery_allowed(b.crew_id, s.id) then raise exception 'msgr_not_allowed'; end if;
  return public._msgr_bot_approval_card(b.id, b.crew_id, c.org_id, s.id, p_approval_id, true, ttl, rsn);
end $$;

-- 결정 뒤 재개 판정(H5·L-7): 크루 active·전달 허용·조직 자격·원문과 뿌리 작성자의 AI 동의. 이벤트와 후속 보고가 같은 판정을 쓴다.
create or replace function public._msgr_bot_resume_block(p_crew uuid, p_org uuid, p_source bigint) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.msgr_messages; r public.msgr_messages;
begin
  select * into s from public.msgr_messages where id = p_source;
  if not exists (select 1 from public.msgr_crews where id = p_crew and status = 'active') then return 'crew_inactive'; end if;
  if s.id is null or s.deleted_at is not null or not public.msgr_delivery_allowed(p_crew, s.id) then return 'delivery_not_allowed'; end if;
  if not coalesce(public.msgr_org_entitled(p_org), true) then return 'org_not_entitled'; end if;
  if s.author_kind = 'user' and not public.msgr_ai_consent_visible(s.author_user_id) then return 'ai_consent'; end if;
  if s.thread_root is not null then
    select * into r from public.msgr_messages where id = s.thread_root;
    if r.author_kind = 'user' and not public.msgr_ai_consent_visible(r.author_user_id) then return 'ai_consent'; end if;
  end if;
  return null;
end $$;
revoke all on function public._msgr_bot_resume_block(uuid, uuid, bigint) from public, anon, authenticated;

-- 후속 보고(M11·T7): 결정된 결재 한 건에 한 번만, 원문의 답글로. 에이전트 결재의 결과 보고와, 에이전트가 기다리기를 멈춘 뒤 늦게 온
-- 셸 결재 결정 알림(1-a L-12 후속)에 쓴다. 넘김·멘션은 없다(done) — 이어서 맡길 일은 다음 사람 지시로.
create or replace function public.msgr_bot_followup(token text, p_approval_id text, p_body text) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; a public.msgr_crew_approvals; s public.msgr_messages; cid text; prior bigint; mid bigint; why text;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if p_body is null or length(btrim(p_body)) = 0 or length(p_body) > 20000 then raise exception 'msgr_bot_bad_body'; end if;
  select * into a from public.msgr_crew_approvals where crew_id = b.crew_id and approval_id = p_approval_id;
  -- 검수 LOW: 결정 뒤 7일 안에만(재개 턴이 길어도 충분하고, 오래된 결재에 뒤늦은 글이 붙지 않게)
  if a.id is null or a.status not in ('approved', 'rejected') or a.source_msg_id is null or a.decided_at < now() - interval '7 days' then raise exception 'msgr_not_allowed'; end if;
  why := public._msgr_bot_resume_block(b.crew_id, b.org_id, a.source_msg_id);
  if why is not null then raise exception 'msgr_not_allowed' using detail = why; end if;
  select * into s from public.msgr_messages where id = a.source_msg_id;
  if s.author_kind = 'user' and not public.msgr_can_instruct(b.crew_id, s.author_user_id, a.channel_id) then raise exception 'msgr_not_allowed'; end if;
  cid := 'followup:' || b.crew_id || ':ap:' || a.id;
  perform pg_advisory_xact_lock(hashtext(cid));
  select id into prior from public.msgr_messages where channel_id = a.channel_id and author_kind = 'crew' and crew_id = b.crew_id and client_msg_id = cid;
  if prior is not null then return prior; end if;
  insert into public.msgr_messages(channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, mentions, meta)
    values (a.channel_id, 'crew', b.crew_id, 'text', s.id, coalesce(s.thread_root, s.id), cid, p_body, '[]'::jsonb,
      jsonb_build_object('disposition', 'done', 'approval_followup', a.id))
    returning id into mid;
  return mid;
end $$;

-- 결재 원문 가드(20260919110000 본문 그대로) + 한 가지: 재개 턴의 카드(payload.followup_of)는 실행이 끝났어도 받는다 —
-- 단, 부모가 같은 크루·같은 원문의 승인된 결재이고 결정 24시간 안일 때만(부모 없이 followup_of만 적어서는 통과 못 한다).
create or replace function public.msgr_approval_source_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare source public.msgr_messages; card public.msgr_messages; crew public.msgr_crews; parent_id uuid;
begin
  if tg_op = 'UPDATE' and old.source_msg_id is not null then
    if new.source_msg_id is null then return new; end if;
    if new.source_msg_id is distinct from old.source_msg_id then
      raise exception 'msgr_immutable_source_msg_id' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.source_msg_id is null and tg_op = 'UPDATE' and new.message_id is distinct from old.message_id and new.message_id is not null then
    select * into card from public.msgr_messages where id = new.message_id;
    if card.id is null or card.deleted_at is not null or card.kind <> 'approval_card' or card.channel_id is distinct from new.channel_id
       or card.crew_id is distinct from new.crew_id
       or not (card.mentions @> jsonb_build_array(jsonb_build_object('kind', 'approval', 'id', new.id::text))) then
      raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
    end if;
    new.source_msg_id := card.reply_to;
  end if;
  if new.source_msg_id is null then return new; end if;
  select * into source from public.msgr_messages where id = new.source_msg_id;
  select * into crew from public.msgr_crews where id = new.crew_id;
  begin parent_id := nullif(new.payload->>'followup_of', '')::uuid; exception when others then parent_id := null; end;
  if source.id is null or source.deleted_at is not null or source.channel_id is distinct from new.channel_id
     or source.org_id is distinct from new.org_id or crew.org_id is distinct from new.org_id
     or not (exists (select 1 from public.msgr_executions e where e.crew_id = new.crew_id and e.source_msg_id = source.id and e.state = 'running')
       or (parent_id is not null and exists (select 1 from public.msgr_crew_approvals pa where pa.id = parent_id and pa.crew_id = new.crew_id
             and pa.source_msg_id = source.id and pa.status = 'approved' and pa.decided_at > now() - interval '24 hours'))) then
    raise exception 'msgr_approval_source_forbidden' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.msgr_approval_source_guard() from public, anon, authenticated;

-- 검수 M-3: 결재가 승인돼 재개된 턴에는 실행 중인 원문(attempt)이 없다 — 그 턴에서 위험 명령·새 결재가 필요하면 카드를 못 올렸다.
-- 승인된 결재(부모)에 이어서 같은 원문에 카드를 붙인다. 부모는 이 크루의 승인된 결재, 결정 24시간 안, 후속 보고 전, 재개 판정 통과.
create or replace function public.msgr_bot_request_followup_approval(token text, p_parent text, p_approval_id text, p_kind text, p_text text, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; pa public.msgr_crew_approvals; agent boolean := p_kind = 'agent';
  txt text := public._msgr_clean_text(p_text, case when p_kind = 'agent' then 300 else 2000 end); rsn text := public._msgr_clean_text(p_reason, 1000);
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if p_kind not in ('agent', 'shell') or coalesce(p_approval_id,'') !~ '^[A-Za-z0-9._:-]{1,80}$' or txt is null then raise exception 'msgr_approval_invalid'; end if;
  select * into pa from public.msgr_crew_approvals where crew_id = b.crew_id and approval_id = p_parent;
  if pa.id is null or pa.status <> 'approved' or pa.decided_at < now() - interval '24 hours' or pa.source_msg_id is null
     or public._msgr_bot_resume_block(b.crew_id, b.org_id, pa.source_msg_id) is not null
     or exists (select 1 from public.msgr_messages m where m.channel_id = pa.channel_id and m.author_kind = 'crew' and m.crew_id = b.crew_id
                and m.client_msg_id = 'followup:' || b.crew_id || ':ap:' || pa.id) then raise exception 'msgr_not_allowed'; end if;
  return public._msgr_bot_approval_card(b.id, b.crew_id, pa.org_id, pa.source_msg_id, p_approval_id, agent, txt, rsn, jsonb_build_object('followup_of', pa.id));
end $$;

-- ── 이벤트: 1-a 본문 + 설정 이벤트(②) + 결재 이벤트에 agent·title 표시와 뿌리 작성자 동의(L-7) ──
create or replace function public.msgr_bot_events(token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; out jsonb := '[]'::jsonb; x record; ok boolean; why text; again boolean; st public.msgr_bot_state;
begin
  b := public.msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if b.event_scan_seq is not distinct from b.event_seq and (b.event_scan_at is null or b.event_scan_at > now() - interval '60 seconds') then return out; end if;
  select * into st from public.msgr_bot_state where bot_id = b.id;
  -- 버전을 보고한 어댑터(0.3.0+)에만 — 예전 어댑터는 반영값을 보고하지 않아 60초마다 다시 주고 쓰기를 만든다
  if st.adapter_version is not null and st.mirror_all is distinct from coalesce(st.mirror_all_applied, false) then
    out := out || jsonb_build_array(jsonb_build_object('event', 'config', 'mirror_all', st.mirror_all));
  end if;
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
    if x.status <> 'approved' then ok := false; why := x.status;
    else why := public._msgr_bot_resume_block(b.crew_id, b.org_id, x.source_msg_id); ok := why is null;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('event', 'approval_decided', 'approval_id', x.approval_id, 'status', x.status, 'resume', ok, 'reason', why,
      'agent', coalesce((x.payload->>'agent')::boolean, false), 'shell', coalesce((x.payload->>'shell')::boolean, false),
      'decided_by_name', (select display_name from public.msgr_org_members where org_id = x.org_id and user_id = x.decided_by),
      'decided_at', x.decided_at, 'channel_id', x.channel_id, 'source_message_id', x.source_msg_id, 'action', x.action, 'reason_text', x.reason));
    update public.msgr_bot_approval_acks set leased_at = now() where approval_id = x.id;
  end loop;
  update public.msgr_executions e set heartbeat_at = now()
    where e.crew_id = b.crew_id and e.state = 'running' and e.heartbeat_at < now() - interval '2 minutes'
      and exists (select 1 from public.msgr_crew_approvals a where a.crew_id = e.crew_id and a.source_msg_id = e.source_msg_id and a.status = 'pending');
  -- 에이전트 결재는 기한이 없어 오래 pending일 수 있다 — 다시 훑을 이유는 "셸 결재 대기(실행 심박)"뿐이라 셸만 센다(유휴 쓰기 0 유지).
  -- 재개 턴에서 올린 셸 카드(실행 행 없음)도 오래 pending일 수 있어, 실행이 running인 셸 카드만 센다(심박이 목적).
  again := jsonb_array_length(out) > 0 or exists (select 1 from public.msgr_crew_approvals a join public.msgr_executions e
      on e.crew_id = a.crew_id and e.source_msg_id = a.source_msg_id and e.state = 'running'
    where a.crew_id = b.crew_id and a.status = 'pending' and a.created_at > now() - interval '24 hours' and coalesce((a.payload->>'shell')::boolean, false));
  if again or b.event_scan_seq is distinct from b.event_seq or b.event_scan_at is not null then
    update public.msgr_bots set event_scan_seq = b.event_seq, event_scan_at = case when again then now() end where id = b.id;
  end if;
  return out;
end $$;

revoke all on function public.msgr_bot_report_status(text, text, text, boolean), public.msgr_bot_request_agent_approval(text, uuid, text, text, text),
  public.msgr_bot_request_followup_approval(text, text, text, text, text, text), public.msgr_bot_followup(text, text, text), public.msgr_bot_events(text) from public;
grant execute on function public.msgr_bot_report_status(text, text, text, boolean), public.msgr_bot_request_agent_approval(text, uuid, text, text, text),
  public.msgr_bot_request_followup_approval(text, text, text, text, text, text), public.msgr_bot_followup(text, text, text), public.msgr_bot_events(text) to anon, authenticated;
revoke all on function public.msgr_bot_set_mirror_all(uuid, boolean) from public, anon;
grant execute on function public.msgr_bot_set_mirror_all(uuid, boolean) to authenticated;
notify pgrst, 'reload schema';
