-- 무료 계정 에이전트의 메신저 연결 일시 중지(2026-10-10 유건 지시: "옛 버전 사용자든 누구든 이제 Pro 결제 안 하면 클라우드 사용 못하게 해").
-- 배경: Supabase 전송량이 한도 직전이고, 호출 상위 20개 계정 중 17개가 무료 계정이다(게이트웨이 받은 글·심박·리스 폴링).
-- 판정: public.is_pro_for(owner) — 결제·운영자 부여·유료 조직 좌석·남은 체험이면 true. 새 판정을 만들지 않는다(msgr_free_grace 유예는 방 인원 한도용이라 여기서는 쓰지 않는다).
--
-- 방식(사람이 띄우는 에이전트 = hosting <> 'bot'): 무료 계정의 active 행을 새 상태 'paused'로 둔다.
--   모든 버전(0.1.94~0.1.101) 게이트웨이의 myCrews가 status='active'만 읽으므로(src/gateway/msgr.mjs myCrews) paused 행은 받은 글·방 참여·심박·
--   업무 심박·루틴 조회를 하지 않는다. 옛 앱도 바꿀 필요가 없다.
--   - 'available'을 쓰지 않는 이유: active→available은 msgr_crew_recall_sweep이 채널 참여를 지우고, 게이트웨이 미러가 카드 없는 available 행을
--     delete한다(결재·자동화·실행 기록이 FK on delete cascade로 연쇄 삭제). paused는 두 경로 모두 타지 않는다.
--   - 'detached'를 쓰지 않는 이유: 0.1.96+ 미러가 카드가 다시 보이면 detached→active로 되돌린다.
--   - 방 참여·메시지·결재·자동화·실행 기록·커서는 그대로 둔다. 루틴 미러(msgr_crew_routines)도 지우지 않게 offboard 함수에서 paused를 뺀다.
-- 외부 봇(hosting='bot')은 상태를 바꾸지 않는다 — 엣지 msgr-bot getUpdates가 msgr_bot_gate(20261010200100)로 막는다. 이 파일의 sweep은
--   봇의 일시 중지 기록(msgr_crew_pauses)만 남기고, 재개 때 봇 커서를 지금 끝으로 옮긴다(밀린 글을 한꺼번에 주지 않게).
-- 재개: 결제·부여가 바뀌면(entitlements 트리거) 그 사용자만 즉시, 체험 만료·조직 좌석 변화는 10분 크론. 재개할 때 커서를 지금 끝으로 옮겨
--   멈춘 동안 받은 글에는 답하지 않는다(글은 그대로 남는다).
--
-- 부하(DB 위생): sweep은 바뀐 행만 쓴다. 유휴(바뀐 계정 없음)에는 msgr_crews·msgr_crew_pauses 쓰기 0 — 읽기는 msgr_crews 한 번(약 1,700행) +
--   주인마다 is_pro_for 1회. 10분마다 1회 = 하루 144회, 실행 기록(cron.job_run_details)은 기존 purge-cron-run-details(7일)가 지운다.
--   msgr_crew_pauses는 재개 뒤 30일 지나면 sweep이 지운다(보존 기간).
--
-- 적용: bash scripts/msgr-live-apply.sh 20261010200000_msgr_crews_pro_pause — drop trigger가 있어 스크립트가 auth·storage 표를 NOWAIT로 먼저 잠근다(#872).
--   msgr_crews 체크 제약 교체는 그 표를 짧게 독점한다(약 1,700행 검사). 적용만으로는 상태가 바뀌지 않는다 — 첫 중지는 첫 크론(10분 안) 또는
--   select public.msgr_crews_plan_sweep(); 한 번.
-- 전체 끄기 스위치: 설정 msgr.pro_gate = 'off'(데이터베이스 기본값 또는 세션)면 관문·sweep·봇 관문이 모두 아무것도 하지 않는다.
--   pg 드릴(scripts/billing-pg-drill.sh)은 테스트 DB마다 이 값을 off로 만든다 — 다른 pg 테스트의 사용자는 Pro를 전제로 쓰였다.
--   이 기능의 시험(test/msgr-crews-pro-pause-pg.test.mjs)만 on으로 돌린다.
-- 되돌리기(데이터를 지우지 않는다):
--   select cron.unschedule('msgr-crews-plan-sweep');
--   drop trigger msgr_crews_plan_sweep_ent on public.entitlements; drop trigger msgr_crews_pro_gate on public.msgr_crews;
--   insert into public.msgr_settings(key, value) values ('bot_plan_gate', 'off') on conflict (key) do update set value = 'off';  -- 봇
--   select public.msgr_crews_plan_unpause_all();   -- 사람 paused·봇 기록 전부 재개 경로로(커서를 끝으로). status만 바꾸는 update는 쓰지 않는다
--   상태 제약은 paused 행이 0이 된 뒤에만 원래 세 값으로.
--   함께 바꾼 함수(msgr_crew_routines_offboard·msgr_automation_dispatch_internal·msgr_member_offboard)는 paused 행이 없으면 원래 정의와 같게 동작해
--   되돌리지 않아도 된다(되돌리려면 각 함수의 원래 파일 20260924160000·20260913110000·20260924100000 정의를 다시 적용).

-- 1) 상태 값에 paused 추가
alter table public.msgr_crews drop constraint if exists msgr_crews_status_check;
alter table public.msgr_crews add constraint msgr_crews_status_check check (status in ('active', 'detached', 'available', 'paused'));

-- 2) 일시 중지 기록 — 봇에게는 상태(열린 기록 = 중지 중), 사람 에이전트에게는 감사·되돌리기용 기록. 보존: 재개 뒤 30일(sweep이 정리).
create table if not exists public.msgr_crew_pauses (
  crew_id uuid primary key references public.msgr_crews(id) on delete cascade,
  owner_user_id uuid not null,
  paused_at timestamptz not null default now(),
  cursor_at_pause bigint,
  resumed_at timestamptz,
  resume_after bigint  -- 재개 때 옮긴 커서(이 id 이하의 글은 답하지 않는다)
);
alter table public.msgr_crew_pauses enable row level security; -- 정책 없음 = 클라이언트 접근 0 (security definer 함수만)
revoke all on public.msgr_crew_pauses from public, anon, authenticated;

-- 3) 루틴 미러 보존: active→paused에서는 지우지 않는다(트리거 WHEN은 그대로 두고 함수 본문만 — 표 잠금 없음). 라이브 정의와 같은 속성(security definer·search_path).
create or replace function public.msgr_crew_routines_offboard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'paused' then return new; end if; -- 2026-10-10 Pro 일시 중지: 재개하면 게이트웨이가 같은 행을 다시 쓴다
  delete from public.msgr_crew_routines where crew_id = new.id;
  return new;
end $$;

-- 4) 쓰기 관문: 무료 계정은 사람 에이전트를 active로 올리지 못한다.
--    INSERT(미러·설정 화면의 새 파견)와 paused/detached→active(미러 되살리기·업서트 충돌)는 조용히 paused로 바꾼다 —
--    오류로 던지면 옛 미러가 15초마다 같은 insert를 다시 보낸다(호출이 줄지 않는다). paused로 들어가면 다음 틱부터 그 행을 보고 다시 쓰지 않는다.
--    available→active(사람이 메신저·설정에서 누른 '파견')는 이유가 보이게 msgr_pro_required로 거절한다.
--    paused는 서버(sweep·이 관문)만 만든다: 업데이트로 paused를 쓰려 하면 원래 상태를 둔다 — 업서트 충돌(insert 쪽 관문이 excluded.status를
--    paused로 바꾼 값)이 사용자가 파견 해제한 available 행을 paused로 바꾸지 않게.
--    트리거 순서(이름 알파벳): msgr_bot_role_gate·msgr_bot_twin_lock·msgr_crew_policy_gate·msgr_crews_bot_guard 다음, msgr_crews_ws_owner_gate·msgr_lock_crews 앞.
--    어느 쪽이 먼저 거절해도 문장 전체가 실패하므로 결과는 같다.
create or replace function public.msgr_crews_pro_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.hosting = 'bot' then return new; end if; -- 봇은 엣지 관문(msgr_bot_gate)
  if coalesce(current_setting('msgr.pro_gate', true), '') = 'off' then return new; end if; -- sweep 자신의 재개·중지, 그리고 전체 끄기(아래 주석)
  if to_regprocedure('public.is_pro_for(uuid)') is null then return new; end if; -- 요금제 함수가 없는 DB(요금제 마이그레이션을 안 태운 테스트)
  if tg_op = 'UPDATE' and new.status = 'paused' and old.status is distinct from 'paused' then
    new.status := old.status;
    return new;
  end if;
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' then return new; end if; -- 이미 active인 행(상태를 그대로 다시 쓰는 갱신)은 sweep이 정리한다
  if public.is_pro_for(new.owner_user_id) then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'available' then
    raise exception 'msgr_pro_required' using errcode = 'P0001',
      detail = 'Messenger agents need Argo Pro for the agent owner';
  end if;
  new.status := 'paused';
  return new;
end $$;
revoke all on function public.msgr_crews_pro_gate() from public, anon, authenticated;
drop trigger if exists msgr_crews_pro_gate on public.msgr_crews;
create trigger msgr_crews_pro_gate before insert or update of status on public.msgr_crews
  for each row execute function public.msgr_crews_pro_gate();

-- 중지 기록 — 관문이 INSERT를 paused로 바꾼 행도, sweep이 멈춘 행도 같은 자리에서 남긴다(행이 생긴 뒤라 FK가 성립하는 AFTER).
create or replace function public.msgr_crews_pro_gate_log() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'UPDATE' and old.status = 'paused' then return new; end if; -- 이미 멈춘 행을 다시 쓰는 갱신은 기록을 건드리지 않는다
  insert into public.msgr_crew_pauses (crew_id, owner_user_id, cursor_at_pause)
  values (new.id, new.owner_user_id, new.cursor_msg_id)
  on conflict (crew_id) do update set paused_at = now(), cursor_at_pause = excluded.cursor_at_pause, resumed_at = null, resume_after = null;
  return new;
end $$;
revoke all on function public.msgr_crews_pro_gate_log() from public, anon, authenticated;
drop trigger if exists msgr_crews_pro_gate_log on public.msgr_crews;
create trigger msgr_crews_pro_gate_log after insert or update of status on public.msgr_crews
  for each row when (new.status = 'paused') execute function public.msgr_crews_pro_gate_log();

-- 5-0) 한 에이전트 재개 — sweep의 Pro 재개와 되돌리기(msgr_crews_plan_unpause_all)가 같은 경로를 쓴다.
--      멈춘 동안 쌓인 글은 처리하지 않는다(커서를 지금 끝 p_top으로) — 몇 주 전 글에 한꺼번에 답하거나 24시간 넘은 글마다 안내를 쓰지 않게. 글 자체는 그대로 남는다.
--      부르는 쪽이 msgr.pro_gate=off로 관문을 비켜 둔다(이 함수는 판정하지 않는다).
create or replace function public._msgr_crew_plan_resume(p_crew uuid, p_top bigint) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.msgr_crews
     set status = case when status = 'paused' then 'active' else status end,
         cursor_msg_id = greatest(coalesce(cursor_msg_id, 0), p_top)
   where id = p_crew;
  update public.msgr_crew_pauses set resumed_at = now(), resume_after = p_top where crew_id = p_crew and resumed_at is null;
  -- 자동화도 같은 규칙: 멈추기 전에 줄 서 있던 실행(커서 뒤로 넘어가 게이트웨이가 다시 읽지 않는다)은 막힘으로 닫고,
  -- 멈춘 동안 지난 예정 시각은 다음 시각으로 옮긴다 — 재개하자마자 밀린 실행을 보내지 않는다. 행·설정(enabled)은 그대로.
  update public.msgr_automation_runs ru set status = 'blocked', error = 'paused', finished_at = now()
    from public.msgr_automations au
   where au.id = ru.automation_id and au.crew_id = p_crew and ru.status = 'queued' and ru.message_id <= p_top
     and not exists (select 1 from public.msgr_executions e where e.source_msg_id = ru.message_id);
  update public.msgr_automations set next_run_at = public.msgr_automation_next(schedule, now()), updated_at = now()
   where crew_id = p_crew and enabled and deleted_at is null and next_run_at <= now();
end $$;
revoke all on function public._msgr_crew_plan_resume(uuid, bigint) from public, anon, authenticated;

-- 5) 정리 함수: 무료 → 중지, Pro → 재개. 바뀌어야 하는 행만 고르고 그 행만 쓴다(유휴 쓰기 0). 10분마다 + 결제 반영 즉시(p_uid).
--    행마다 따로 처리한다 — 한 행이 다른 트리거(예: 잠긴 조직 정책 msgr_crew_policy_gate)에 걸려도 나머지는 계속 간다.
create or replace function public.msgr_crews_plan_sweep(p_uid uuid default null) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record; top bigint; prev text := current_setting('msgr.pro_gate', true);
  n_paused int := 0; n_resumed int := 0; n_failed int := 0;
begin
  if coalesce(prev, '') = 'off' then return jsonb_build_object('skipped', 'msgr.pro_gate=off'); end if; -- 전체 끄기
  perform set_config('msgr.pro_gate', 'off', true); -- 재개 update가 관문에 다시 걸리지 않게(판정은 아래 조건이 한다). 끝에서 되돌린다.
  for r in
    with owners as (
      select distinct c.owner_user_id uid from public.msgr_crews c
       where (p_uid is null or c.owner_user_id = p_uid)
         and (c.status in ('active', 'paused') or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null))
    ), verdict as (select uid, public.is_pro_for(uid) pro from owners)
    select c.id, c.hosting, c.status, v.pro,
           exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null) open_pause
      from public.msgr_crews c join verdict v on v.uid = c.owner_user_id
     where (not v.pro and c.status = 'active'
              and (c.hosting <> 'bot' or not exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null)))
        or (v.pro and (c.status = 'paused' or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null)))
     order by c.id
  loop
    begin
      if not r.pro then
        if r.hosting <> 'bot' then
          update public.msgr_crews set status = 'paused' where id = r.id and status = 'active'; -- 기록은 msgr_crews_pro_gate_log
        else
          insert into public.msgr_crew_pauses (crew_id, owner_user_id, cursor_at_pause)
            select id, owner_user_id, cursor_msg_id from public.msgr_crews where id = r.id
          on conflict (crew_id) do update set paused_at = now(), cursor_at_pause = excluded.cursor_at_pause, resumed_at = null, resume_after = null;
        end if;
        n_paused := n_paused + 1;
      else
        if top is null then select coalesce(max(id), 0) into top from public.msgr_messages; end if;
        perform public._msgr_crew_plan_resume(r.id, top);
        n_resumed := n_resumed + 1;
      end if;
    exception when others then
      n_failed := n_failed + 1;
      raise warning 'msgr_crews_plan_sweep: crew % skipped (%: %)', r.id, sqlstate, sqlerrm;
    end;
  end loop;
  -- 사람이 paused 행을 직접 다른 상태로 바꿨으면(파견 해제 등) 열린 기록을 닫는다 — 바뀐 행만
  update public.msgr_crew_pauses k set resumed_at = now()
   where k.resumed_at is null and (p_uid is null or k.owner_user_id = p_uid)
     and exists (select 1 from public.msgr_crews c where c.id = k.crew_id and c.hosting <> 'bot' and c.status <> 'paused');
  if p_uid is null then delete from public.msgr_crew_pauses where resumed_at < now() - interval '30 days'; end if; -- 보존 기간
  perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
  return jsonb_build_object('paused', n_paused, 'resumed', n_resumed, 'failed', n_failed);
end $$;
revoke all on function public.msgr_crews_plan_sweep(uuid) from public, anon, authenticated;

-- 5-1) 되돌리기 — 멈춘 에이전트 전부(사람 paused + 봇 열린 기록)를 재개와 같은 경로로 되살린다(커서를 끝으로·기록 닫기·자동화 정리, 봇 커서 포함).
--      그냥 update … set status='active'로 되돌리면 커서가 그대로라 옛 게이트웨이가 멈춘 동안 온 글을 처리하고, 24시간 넘은 글마다 안내를 쓴다.
--      먼저 크론·관문 트리거를 내린 뒤 부른다(머리 주석 '되돌리기'). service_role 전용. 행 단위 예외 처리.
create or replace function public.msgr_crews_plan_unpause_all() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; top bigint; prev text := current_setting('msgr.pro_gate', true); n int := 0; n_failed int := 0;
begin
  perform set_config('msgr.pro_gate', 'off', true);
  select coalesce(max(id), 0) into top from public.msgr_messages;
  for r in select c.id from public.msgr_crews c
            where c.status = 'paused' or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = c.id and k.resumed_at is null)
            order by c.id loop
    begin
      perform public._msgr_crew_plan_resume(r.id, top);
      n := n + 1;
    exception when others then
      n_failed := n_failed + 1;
      raise warning 'msgr_crews_plan_unpause_all: crew % skipped (%: %)', r.id, sqlstate, sqlerrm;
    end;
  end loop;
  perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
  return jsonb_build_object('resumed', n, 'failed', n_failed, 'cursor', top);
end $$;
revoke all on function public.msgr_crews_plan_unpause_all() from public, anon, authenticated;
grant execute on function public.msgr_crews_plan_unpause_all() to service_role;

-- 결제·부여가 바뀌면 그 사용자만 바로 재개/중지(10분 기다리지 않게). 결제 웹훅(apply_ls_event)의 트랜잭션 안에서 돌므로 어떤 오류도 밖으로 던지지 않는다 —
-- 여기서 실패해 결제 반영이 되돌려지면 안 된다(다음 10분 크론이 같은 판정을 다시 한다).
create or replace function public.msgr_crews_plan_sweep_on_entitlement() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    perform public.msgr_crews_plan_sweep(new.user_id);
  exception when others then
    raise warning 'msgr_crews_plan_sweep_on_entitlement: % skipped (%: %)', new.user_id, sqlstate, sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.msgr_crews_plan_sweep_on_entitlement() from public, anon, authenticated;
drop trigger if exists msgr_crews_plan_sweep_ent on public.entitlements;
create trigger msgr_crews_plan_sweep_ent after insert or update on public.entitlements
  for each row execute function public.msgr_crews_plan_sweep_on_entitlement();
-- 조직 좌석(msgr_org_entitlements·msgr_org_members)·체험 만료는 아래 10분 크론이 맡는다.

-- 6) 멈춘 에이전트인가(사람 에이전트 paused, 또는 봇의 열린 중지 기록) — 자동화 발송이 본다.
create or replace function public.msgr_crew_plan_paused(crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_crews c where c.id = crew and c.status = 'paused')
      or exists (select 1 from public.msgr_crew_pauses k where k.crew_id = crew and k.resumed_at is null)
$$;
revoke all on function public.msgr_crew_plan_paused(uuid) from public, anon, authenticated;

-- 7) 자동화 발송(크론 argo-msgr-automations 매분·msgr_automation_dispatch_due): 멈춘 에이전트를 겨냥한 자동화는 건너뛴다(쓰기 0).
--    그대로 두면 msgr_automation_authorized(cr.status='active')가 false라 '권한 철회'로 보고 자동화를 꺼 버린다(enabled=false) —
--    재개 뒤에도 꺼진 채로 남는다. 본문은 20260913110000 정의 그대로 + 두 반복의 대상 조건에 msgr_crew_plan_paused 한 줄씩(운영 prosrc와 대조함).
create or replace function public.msgr_automation_dispatch_internal(p_ws text, cloud boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a public.msgr_automations; rejected record; results jsonb := '[]';
begin
  if not cloud and auth.uid() is null then raise exception 'msgr_automation_forbidden' using errcode = '42501'; end if;
  -- Reconcile only not-yet-started commands, independent of the next schedule time.
  -- Lock automation then run, the same order as the claim guard and enqueue path.
  for rejected in select r.id as run_id,au.id as automation_id,r.message_id
    from public.msgr_automations au join public.msgr_automation_runs r on r.automation_id = au.id
    join public.msgr_messages source on source.id = r.message_id
    where r.status = 'queued'
      and not exists(select 1 from public.msgr_executions e where e.source_msg_id = r.message_id)
      and not public.msgr_crew_plan_paused(au.crew_id) -- 2026-10-10 무료 계정 일시 중지: 권한 철회가 아니다(재개 때 sweep이 닫는다)
      and not public.msgr_automation_authorized(source.author_user_id,source.channel_id,
        public.msgr_uuid_or_null(source.mentions->0->>'id'))
      and (cloud or (public.msgr_can_write_channel(au.channel_id)
        and exists(select 1 from public.msgr_crews c where c.org_id = au.org_id and c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.status = 'active')))
    order by r.created_at limit 20 for update of au,r skip locked
  loop
    update public.msgr_automation_runs set status = 'blocked',error = 'permission_revoked',finished_at = now() where id = rejected.run_id;
    update public.msgr_automations set enabled = false,updated_at = now(),
      last_status = case when last_message_id = rejected.message_id then 'blocked' else last_status end where id = rejected.automation_id;
  end loop;
  for a in select au.* from public.msgr_automations au
    where au.enabled and au.deleted_at is null and au.next_run_at <= now()
      -- Never pile up unattended commands or restart an uncertain in-flight execution.
      and not exists(select 1 from public.msgr_automation_runs pending
        join public.msgr_messages source on source.id = pending.message_id and source.deleted_at is null
        where pending.automation_id = au.id and pending.status in ('queued','running'))
      and not public.msgr_crew_plan_paused(au.crew_id) -- 2026-10-10 무료 계정 일시 중지: 보내지도 끄지도 않는다(재개 때 sweep이 다음 시각으로 옮긴다)
      and (cloud or (public.msgr_can_write_channel(au.channel_id)
      and exists(select 1 from public.msgr_crews c where c.org_id = au.org_id and c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.status = 'active')))
    order by au.next_run_at limit 20 for update of au skip locked
  loop
    begin
      results := results || jsonb_build_array(public.msgr_automation_enqueue(a,'schedule'));
    exception when others then
      -- One broken row must not starve every other organization. No exception text
      -- is stored or logged: database errors may contain message/prompt values.
      update public.msgr_automations set enabled = false,last_status = 'blocked',updated_at = now() where id = a.id;
      insert into public.msgr_automation_runs(automation_id,scheduled_for,trigger,status,error,finished_at)
        values(a.id,a.next_run_at,'schedule','blocked','dispatch_failed',now()) on conflict do nothing;
    end;
  end loop;
  return results;
end $$;

-- 8) 멤버 내보내기: paused 행도 detached로(조직을 떠난 사람의 에이전트가 Pro 재개 때 active로 되살아나지 않게).
--    본문은 20260924100000 정의 그대로 + 상태 목록에 'paused' 하나(운영 prosrc와 대조함). 다시 들이면 detached→active는 관문이 판정한다.
create or replace function public.msgr_member_offboard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    update public.msgr_crews set status = 'detached' where org_id = new.org_id and owner_user_id = new.user_id and status in ('active', 'available', 'paused');
    delete from public.msgr_channel_members cm using public.msgr_channels c
     where cm.channel_id = c.id and c.org_id = new.org_id
       and ((cm.member_kind = 'user' and cm.member_id = new.user_id)
         or (cm.member_kind = 'crew' and cm.member_id in (select id from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id)));
    -- 본인 계정 삭제(msgr_delete_me)도 이 사슬을 탄다 — 채널장 검사의 '만든 사람·관리자만' 판정은 떠난 사람만 빼는 이 제거에 걸지 않는다(아래 가드의 데이터 조건)
    update public.msgr_channels set admin_user_ids = array_remove(admin_user_ids, new.user_id) where org_id = new.org_id and new.user_id = any (admin_user_ids);
    perform public.msgr_audit(new.org_id, 'member.offboard', 'user', new.user_id::text, jsonb_build_object('crews_detached', (select count(*) from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached')));
  elsif new.removed_at is null and old.removed_at is not null then
    update public.msgr_crews set status = 'active' where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached';
  end if;
  return new;
end $$;

-- pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('msgr-crews-plan-sweep', '*/10 * * * *', $c$select public.msgr_crews_plan_sweep()$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
