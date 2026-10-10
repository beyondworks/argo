-- 기기 단위 심박(유건 2026-10-10 "이번 발행에 하트비트도 기기 단위 심박으로 바꾸자").
-- 지금: Argo 앱(메신저 브리지)이 회사마다 15초 틱으로 에이전트 행 하나하나의 last_seen_at을 30초마다 고쳐 썼다.
--   운영 2분 측정(10/10 09:48 KST, 읽기 전용): msgr_crews 갱신 분당 약 990건 — DB에서 가장 큰 쓰기. 접속 중 로컬 행 625개(조직 474 + 개인 151).
-- 바꾼 것:
--   1) msgr_device_beats — (주인, 회사, 기기)마다 한 행. 그 기기가 맡은 에이전트 이름(slug) 목록과 마지막 심박 시각.
--      쓰기는 목록이 바뀌었거나 35초가 지났을 때만(신선도 90초의 절반 이하 — DB 위생 2번). 기기 1대·회사 1곳이면 약 45초마다 1행.
--   2) msgr_device_beat(회사, 기기, 행 id들) — 브리지가 부르는 하나의 요청. 기기 행 + 옛 읽기 호환 + 업무 기능 표시(msgr_work_heartbeat와 같은 일)를 한 번에.
--      종전에는 틱마다 PATCH 1건 + msgr_work_heartbeat 1건이었다 → 1건.
--   3) 읽는 쪽 = greatest(행의 last_seen_at, 그 에이전트(주인·회사·slug)를 맡은 기기의 마지막 심박).
--      - 앱은 계산 열 msgr_crew_seen을 `last_seen_at:msgr_crew_seen`으로 읽는다(열 이름 그대로 — 판정 코드는 바꾸지 않는다).
--      - 서버 함수 msgr_personal_room_crews·msgr_work_create(그리고 오피스 office_work_status — 별도 파일)도 같은 값을 쓴다.
--      - 옛 Argo(0.1.100 이하)는 계속 행마다 심박을 쓴다 — greatest라 그 신호도 그대로 받는다. 봇 행(hosting='bot')은 봇 경로가 쓰는 행 시각 그대로.
-- 옛 읽기 호환(이 함수 안에서만 정한다 — 단계를 바꿀 때 앱 발행 없이 이 함수만 다시 정의한다):
--   설치된 메신저는 msgr_crews.last_seen_at을 직접 읽는다. 그래서 기기 행만 쓰면 옛 메신저에서 에이전트가 '꺼짐'이 된다 → 행도 계속 고쳐 쓰되 덜 자주.
--   · 조직 행: 35초 넘은 것만(15초 틱이라 대개 45초마다). 메신저 0.1.47 이하는 30초마다 다시 읽고 지금 시각과 계속 비교한다 — 보이는 나이 = 행 나이 + 30초 < 90초.
--     틱 안에서 심박 요청이 나가는 시각은 0~10초 늦어질 수 있다(자동화·미러가 먼저 돈다). 모의 실험(요청 지연 균등 0.3~10초, 20만 틱):
--     종전 30초 기한은 쓰기 직전 나이 최대 54.3초·평균 주기 38.7초(운영 측정 분당 989건과 맞다), 35초 기한은 최대 54.6초·평균 43.4초(지연 3초면 47.7초·45초).
--     40초로 하면 지연이 6초를 넘을 때 3번째 틱을 놓쳐 최대 64초가 된다(옛 메신저 '꺼짐' 깜빡임 — 분리 검수 M1). 최악 나이는 종전과 같게 두고 평균 쓰기만 줄인다.
--   · 개인 행(org NULL): 50초 넘은 것만(대개 60초마다, 같은 모의에서 최대 69.7초). 개인 행을 표에서 직접 읽는 메신저는 0.1.48 이상뿐이고
--     (0.1.47 이하는 msgr_personal_room_crews로 읽는다 — 서버 계산), 0.1.48부터는 받아 온 때의 나이로 판정한다(presence-clock.mjs) — 70초 < 90초.
--   다음 단계(서버만): 메신저 0.1.47 이하가 없어지면 조직 행도 50초 → 메신저 0.1.55 이하·Argo 0.1.100 이하·오피스 옛 읽기가 없어지면 행 쓰기 0.
-- 보존: 기기 행은 7일 넘게 심박이 없으면 지운다(pg_cron 매일, 로컬 PG에는 없음). 꺼진 기기·바뀐 기기 id 행이 쌓이지 않게.
--   상한: 주인당 50행(새 기기 행을 넣을 때만 가장 오래된 것부터 지운다). 맡은 에이전트가 없거나 회사 이름이 규칙에 맞지 않으면 넣지 않는다(분리 검수 M2 — 아무 값으로 행을 무한히 만들 수 있었다).

create table if not exists public.msgr_device_beats (
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  ws_id text not null check (length(ws_id) between 1 and 200),
  device_id text not null check (length(device_id) between 1 and 200),
  slugs text[] not null default '{}',
  seen_at timestamptz not null default now(),
  primary key (owner_user_id, ws_id, device_id)
);
alter table public.msgr_device_beats enable row level security;
revoke all on public.msgr_device_beats from public, anon, authenticated; -- 직접 읽기·쓰기 없음 — 아래 함수로만(기기 이름에 컴퓨터 이름이 들어 있다)

-- 그 에이전트(주인·회사·slug)를 맡은 기기의 마지막 심박. 내부용 — 정의자 함수만 부른다.
create or replace function public._msgr_device_seen(p_owner uuid, p_ws text, p_slug text) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select max(d.seen_at) from public.msgr_device_beats d
   where d.owner_user_id = p_owner and d.ws_id = p_ws and p_slug = any(d.slugs)
$$;
revoke all on function public._msgr_device_seen(uuid, text, text) from public, anon, authenticated;

-- 계산 열(PostgREST): select=...,last_seen_at:msgr_crew_seen. 표에 저장된 행을 다시 읽고(넘겨받은 값은 id만 쓴다)
-- 표 읽기 정책 msgr_crews_select와 같은 조건을 건다 — 함수를 직접 불러 남의 에이전트 접속을 알아낼 수 없게.
create or replace function public.msgr_crew_seen(public.msgr_crews) returns timestamptz
language sql stable security definer set search_path = public, pg_temp as $$
  select greatest(x.last_seen_at, case when x.status = 'active' then public._msgr_device_seen(x.owner_user_id, x.ws_id, x.slug) end) -- 파견 해제·분리된 행은 행 시각만(검수 L3 — 다른 조직의 해제된 행으로 주인 기기 상태가 보이지 않게)
    from public.msgr_crews x
   where x.id = $1.id
     and case when x.org_id is null then x.owner_user_id = auth.uid() else public.msgr_is_member(x.org_id) end
$$;
revoke all on function public.msgr_crew_seen(public.msgr_crews) from public, anon;
grant execute on function public.msgr_crew_seen(public.msgr_crews) to authenticated;

-- 브리지 심박 하나. p_crews = 종전 PATCH가 받던 행 id 목록 그대로(조직 행 + 방에 든 개인 행, 조직 행이 없으면 개인 행 전부, 카드가 있는 것만).
-- 쉬는 동안(목록 그대로·기한 안) 쓰기 0 — 갱신은 조건에 맞는 행이 없으면 아무것도 쓰지 않는다(on conflict do update는 기존 행을 잠가 쓰기가 생겨 쓰지 않는다).
create or replace function public.msgr_device_beat(p_ws text, p_device text, p_crews uuid[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); s text[];
begin
  if me is null then raise exception 'msgr_device_beat_forbidden' using errcode = '42501'; end if;
  if p_ws is null or p_ws !~ '^[a-z0-9][a-z0-9-]{0,127}$' or p_device is null or length(p_device) not between 1 and 200
     or coalesce(cardinality(p_crews), 0) > 2000 then raise exception 'msgr_device_beat_invalid' using errcode = '22023'; end if; -- 회사 id 규칙 = workspace.mjs WS_ID_RE
  -- 이 기기가 맡은 에이전트 = 받은 행 중 내 행·이 회사 행의 slug(남의 에이전트·다른 회사를 '접속'으로 만들 수 없다)
  select coalesce(array_agg(distinct c.slug order by c.slug), '{}') into s
    from public.msgr_crews c where c.id = any(coalesce(p_crews, '{}')) and c.owner_user_id = me and c.ws_id = p_ws;
  update public.msgr_device_beats d set slugs = s, seen_at = now()
   where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device
     and (d.slugs is distinct from s or d.seen_at < now() - interval '35 seconds');
  if not found and s <> '{}' and not exists (select 1 from public.msgr_device_beats d where d.owner_user_id = me and d.ws_id = p_ws and d.device_id = p_device) then
    -- 새 (회사, 기기) — 주인당 50행 상한: 가장 오래 안 뛴 것부터 비운다(넣을 때만 — 쉬는 틱은 여기 오지 않는다)
    delete from public.msgr_device_beats d where d.owner_user_id = me and (d.ws_id, d.device_id) in (
      select o.ws_id, o.device_id from public.msgr_device_beats o where o.owner_user_id = me order by o.seen_at desc offset 49);
    insert into public.msgr_device_beats (owner_user_id, ws_id, device_id, slugs) values (me, p_ws, p_device, s) on conflict do nothing;
  end if;
  -- 옛 읽기 호환(머리말) — 기한이 지난 행만
  update public.msgr_crews c set last_seen_at = now()
   where c.id = any(p_crews) and c.owner_user_id = me and c.ws_id = p_ws
     and (c.last_seen_at is null or c.last_seen_at < now() - case when c.org_id is null then interval '50 seconds' else interval '35 seconds' end);
  -- 업무 기능 표시 — msgr_work_heartbeat와 같은 일(조직 행만, 같은 값은 쓰지 않는다). 따로 보내던 요청을 여기로 합쳤다.
  update public.msgr_crews set work_protocol = 1
   where id = any(p_crews) and owner_user_id = me and ws_id = p_ws and org_id is not null and status = 'active' and work_protocol is distinct from 1;
end $$;
revoke all on function public.msgr_device_beat(text, text, uuid[]) from public, anon;
grant execute on function public.msgr_device_beat(text, text, uuid[]) to authenticated;

-- 개인 공간 목록 — 20261001160000 정의 그대로 + 접속 시각에 기기 심박을 더한다(방에 들지 않은 개인 행은 조직 행 시각을 빌리던 것과 같은 자리).
create or replace function public.msgr_personal_room_crews()
returns table(id uuid, org_id uuid, slug text, display_name text, role_text text, owner_user_id uuid, hosting text, status text,
              avatar_url text, face jsonb, department text, last_seen_at timestamptz, commands jsonb, bot_kind text, org_label text, ready boolean, paused text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.org_id, c.slug, c.display_name,
         case when c.hosting = 'bot' and c.owner_user_id is distinct from auth.uid() then null else c.role_text end,
         c.owner_user_id, c.hosting, c.status, c.avatar_url, c.face, c.department,
         -- 접속: 방에 들지 않은 개인 행은 심박을 쓰지 않는다 — 같은 크루(주인·회사·slug)의 조직 행 시각을 빌린다(쓰기 0). 쌍둥이는 조직 봇 행 시각.
         -- 기기 단위 심박(20261010120000): 그 에이전트를 맡은 기기의 마지막 심박도 더한다.
         greatest(c.last_seen_at, (select max(o.last_seen_at) from public.msgr_crews o where o.owner_user_id = c.owner_user_id and o.ws_id = c.ws_id and o.slug = c.slug and o.org_id is not null),
                  case when c.status = 'active' then public._msgr_device_seen(c.owner_user_id, c.ws_id, c.slug) end),
         case when c.owner_user_id = auth.uid() then c.commands else null end,
         case when c.owner_user_id = auth.uid() then bb.kind end,
         case when c.owner_user_id = auth.uid() and bb.id is not null and exists (
                select 1 from public.msgr_bot_personal p2 join public.msgr_bots b2 on b2.id = p2.bot_id join public.msgr_crews c2 on c2.id = p2.crew_id
                 where c2.owner_user_id = c.owner_user_id and c2.status = 'active' and p2.bot_id <> bb.id
                   and (lower(c2.display_name) = lower(c.display_name) or (b2.external_id is not null and b2.external_id = bb.external_id)))
              then (select o.name from public.msgr_orgs o where o.id = bb.org_id) end,
         case when c.owner_user_id = auth.uid() and bp.bot_id is not null then public._msgr_bot_twin(bp.bot_id) is not distinct from c.id end,
         -- 쓸 수 없는 이유(주인에게만): 'relink' 다시 연결 필요 / 'left_org' 조직을 나가(또는 조직 삭제) 사용할 수 없음. 쓸 수 있으면 NULL.
         case when c.owner_user_id = auth.uid() and bp.bot_id is not null then nullif(coalesce(public._msgr_bot_twin_state(bp.bot_id), 'relink'), 'ready') end
    from public.msgr_crews c
    left join public.msgr_bot_personal bp on bp.crew_id = c.id
    left join public.msgr_bots bb on bb.id = bp.bot_id
   where c.org_id is null and c.status <> 'available'
     and (c.owner_user_id = auth.uid()
          or exists (select 1 from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = ch.id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where cm.member_kind = 'crew' and cm.member_id = c.id)
          -- 대기 중인 넣기 요청 — 요청이 걸린 개인 방의 사람 구성원만(방 밖 사람·다른 방 사람은 못 본다)
          or exists (select 1 from public.msgr_channel_crew_requests q join public.msgr_channels ch on ch.id = q.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = q.channel_id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where q.crew_id = c.id and q.status = 'pending'))
$$;
revoke all on function public.msgr_personal_room_crews() from public, anon;
grant execute on function public.msgr_personal_room_crews() to authenticated;

-- 팀 업무 총괄 고르기 — 20260913010000 정의 그대로 + 접속 판정(90초)·정렬에 기기 심박을 더한다.
create or replace function public.msgr_work_create(p_channel uuid, p_request uuid, p_goal text, p_completion text default '', p_lead uuid default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare w public.msgr_work_runs; ch public.msgr_channels; lead public.msgr_crews; mid bigint; me uuid := auth.uid();
begin
  if me is null or p_request is null then raise exception 'msgr_work_auth_required'; end if;
  if p_goal is null or length(btrim(p_goal)) not between 1 and 6000 or length(coalesce(p_completion,'')) > 2000 then raise exception 'msgr_work_bad_goal'; end if;
  -- Serialize identical client requests, including concurrent devices and uncertain network responses.
  perform pg_advisory_xact_lock(hashtextextended(me::text || ':' || p_request::text, 0));
  select * into w from public.msgr_work_runs where created_by = me and request_id = p_request;
  if found then
    if w.channel_id is distinct from p_channel or w.goal is distinct from btrim(p_goal) or w.completion_criteria is distinct from coalesce(p_completion,'')
       or (p_lead is not null and w.lead_crew_id is distinct from p_lead) then raise exception 'msgr_work_request_conflict'; end if;
    if not coalesce(public.msgr_can_read_channel(w.channel_id),false) then raise exception 'msgr_work_forbidden'; end if;
    return to_jsonb(w);
  end if;
  select * into ch from public.msgr_channels where id = p_channel and archived_at is null;
  if ch.id is null or not coalesce(public.msgr_can_write_channel(p_channel),false) then raise exception 'msgr_work_forbidden'; end if;
  select c.* into lead from public.msgr_crews c
    where c.org_id = ch.org_id and c.status = 'active'
      and (c.hosting='bot' or c.work_protocol>=1)
      and (p_lead is null or c.id = p_lead)
      and (p_lead is not null or greatest(c.last_seen_at, public._msgr_device_seen(c.owner_user_id, c.ws_id, c.slug)) > now() - interval '90 seconds')
      and public.msgr_crew_in_channel(p_channel, c.id)
      and public.msgr_can_instruct(c.id, me, p_channel)
    order by case when coalesce(c.role_text,'') ~* '(총괄|조율|조정|moderator|coordinator|lead|manager)' then 0 else 1 end,
      greatest(c.last_seen_at, public._msgr_device_seen(c.owner_user_id, c.ws_id, c.slug)) desc nulls last, c.id limit 1;
  if lead.id is null then raise exception 'msgr_work_no_available_lead'; end if;
  insert into public.msgr_work_runs(org_id,channel_id,created_by,request_id,goal,completion_criteria,lead_crew_id)
    values(ch.org_id,p_channel,me,p_request,btrim(p_goal),coalesce(p_completion,''),lead.id) returning * into w;
  insert into public.msgr_messages(channel_id,author_kind,author_user_id,kind,body,mentions,client_msg_id,meta)
    values(p_channel,'user',me,'text',btrim(p_goal),'[]'::jsonb || jsonb_build_object('kind','crew','id',lead.id),
      'work:' || p_request::text,jsonb_build_object('work_run_id',w.id)) returning id into mid;
  update public.msgr_messages set thread_root = mid where id = mid;
  update public.msgr_work_runs set root_message_id = mid where id = w.id returning * into w;
  return to_jsonb(w);
end $$;
revoke all on function public.msgr_work_create(uuid,uuid,text,text,uuid) from public,anon;
grant execute on function public.msgr_work_create(uuid,uuid,text,text,uuid) to authenticated;

-- 보존 7일 — pg_cron이 없는 환경(로컬 PG 테스트)에서는 아무것도 하지 않는다. 같은 이름이면 cron.schedule이 갱신하므로 다시 적용해도 하나다.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-msgr-device-beats', '41 3 * * *', $c$delete from public.msgr_device_beats where seen_at < now() - interval '7 days'$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
