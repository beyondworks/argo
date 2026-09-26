-- 조직 무료 기간 30일(유건 결정 2026-09-26: "한도 유지하고 무료 기간 30일로 하자. 안정화가 안 되면 서버에서 연장").
-- 방향 정정(같은 날 저녁): "유료로 배포하고 가입 후 첫 달 무료 + 필요 시 쿠폰으로 연장" — 무료 기간·서버 쪽 연장은 그대로,
--   기간이 끝난 뒤 조직이 어떻게 되는지(한도 복귀 vs 결제 전 제한)는 보류. 지금은 기존 좌석·채널 한도 트리거를
--   무료 기간 중에만 우회하고, 종료 뒤 동작은 기존 트리거 그대로 둔다(판정은 msgr_org_trial_active 한 곳에 모은다).
-- 앱 안 쿠폰 입력 화면은 만들지 않는다(App Store 3.1.1 — 자체 수단으로 기능을 여는 것 금지). 연장은 service_role 전용
--   함수로만 하고, 대상 조직 멤버의 알림함에 서버 표(msgr_org_announcements)로 안내한다(기존 알림함 v1 클라이언트 집계에
--   새 소스로 얹는다 — 알림함 자체를 새로 만들지 않는다).
-- DB 위생(CLAUDE.md): 새 주기 작업·폴링 없음. 한도 판정은 기존 좌석·채널 게이트 트리거 안에서 시각 비교 한 줄만 추가.
-- 추가 확정(같은 날 저녁 2차 정정): 조직 단위 유료 구독, 결제는 관리자가 웹에서(웹 결제 연동은 이번 범위 밖 — 자리만 만든다).
--   paid_until은 service_role 전용(웹훅이 나중에 채운다). 자격 판정은 msgr_org_entitled(org) = 무료 기간 중 OR paid_until > now() 한 곳.
--   무료 기간이 끝나고 미결제(entitled=false)인 조직은 "크루(에이전트)에게 일을 맡기는 것"만 멈춘다 — 사람끼리 대화·기존 기록 열람은
--   그대로. 개인 공간(채널 org_id null)은 조직 소속이 아니므로 항상 영향 밖. 서버(게이트웨이)가 크루 턴을 시작하지 않는 것이 1차 방어,
--   DB는 crew 저자의 'text'·'approval_card' 삽입 자체를 막는 2차 방어('system' 안내는 그대로 허용 — 안내 자체가 막히면 안 된다).

-- ── 무료 기간 열: 새 조직은 생성 시각 + 30일(컬럼 기본값), 이미 있던 조직은 이 마이그레이션 적용 시각 + 30일(ADD COLUMN 백필) ──
alter table public.msgr_org_entitlements
  add column if not exists trial_ends_at timestamptz not null default (now() + interval '30 days');
-- ── 결제 기간: 웹 결제 연동(Lemon Squeezy 등)이 채울 자리 — 이번 범위는 열과 판정 함수만. 관리자·앱은 쓰기 권한이 없다(service_role만).
alter table public.msgr_org_entitlements
  add column if not exists paid_until timestamptz;

-- ── 무료 기간 판정 — 좌석·채널 게이트가 참조 ──
create or replace function public.msgr_org_trial_active(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select e.trial_ends_at > now() from public.msgr_org_entitlements e where e.org_id = org), false)
$$;

-- ── 자격 판정 단일 관문 — 무료 기간 중 OR 결제 기간 중. 좌석·채널 게이트·크루 턴 게이트가 모두 이 함수 하나만 부른다. ──
create or replace function public.msgr_org_entitled(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_org_trial_active(org)
        or coalesce((select e.paid_until > now() from public.msgr_org_entitlements e where e.org_id = org), false)
$$;

-- ── 좌석 게이트 재정의(20260903120000의 최종 정의 그대로 + 무료 기간 우회 한 줄) ──
create or replace function public.msgr_member_seat_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare lim int; n int; gseats boolean;
begin
  if new.removed_at is not null then return new; end if;
  if tg_op = 'UPDATE' and old.removed_at is null then return new; end if; -- 활성→활성(역할 변경)은 좌석 불변
  if public.msgr_org_entitled(new.org_id) then return new; end if; -- 무료 기간 중이거나 결제한 조직엔 좌석 한도 미적용(2026-09-26)
  select coalesce(p.guest_seats, false) into gseats from public.msgr_org_policies p where p.org_id = new.org_id;
  gseats := coalesce(gseats, false);
  if new.role = 'guest' and not gseats then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_seats:' || new.org_id::text));
  select case when public.msgr_org_plan(new.org_id) = 'team' then coalesce(e.seats, 0) else 3 end
    into lim from public.msgr_org_entitlements e where e.org_id = new.org_id;
  if lim is null then lim := 3; end if;
  select count(*) into n from public.msgr_org_members where org_id = new.org_id and removed_at is null and user_id <> new.user_id
     and (role <> 'guest' or gseats) and (expires_at is null or expires_at > now());
  if n >= lim then raise exception 'msgr_seat_limit' using detail = format('%s/%s', n, lim); end if;
  return new;
end $$;

-- ── 채널 게이트 재정의(20260903120000 그대로 + 무료 기간 우회 한 줄) ──
create or replace function public.msgr_channel_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('msgr_channels:' || new.org_id::text)); -- 좌석 게이트와 같은 레이스 계열
  if public.msgr_org_entitled(new.org_id) then return new; end if; -- 무료 기간 중이거나 결제한 조직엔 채널 한도 미적용(2026-09-26)
  if new.kind = 'public' and public.msgr_org_plan(new.org_id) = 'free'
     and (select count(*) from public.msgr_channels where org_id = new.org_id and kind = 'public' and archived_at is null) >= 1 then
    raise exception 'msgr_channel_limit';
  end if;
  return new;
end $$;

do $$ declare f text; begin
  foreach f in array array['msgr_org_trial_active(uuid)', 'msgr_org_entitled(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ── 크루 턴 DB 쪽 방어(2차 방어선) — 게이트웨이가 막지 못한 우회도 여기서 막는다. 'system' 안내는 예외(막히면 안내 자체가 안 나간다). ──
create or replace function public.msgr_message_entitlement_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare oid uuid;
begin
  if new.author_kind = 'crew' and new.kind in ('text', 'approval_card') then
    select org_id into oid from public.msgr_channels where id = new.channel_id; -- 개인 공간(org_id null)은 대상 밖
    if oid is not null and not public.msgr_org_entitled(oid) then raise exception 'msgr_org_unentitled'; end if;
  end if;
  return new;
end $$;
drop trigger if exists msgr_message_entitlement_gate on public.msgr_messages;
create trigger msgr_message_entitlement_gate before insert on public.msgr_messages for each row execute function public.msgr_message_entitlement_gate();

-- ── 무료 기간 연장 안내 — 기존 알림함(App.jsx Inbox v1 클라이언트 집계)에 얹는 새 소스. 서비스 계정 전용 쓰기. ──
create table if not exists public.msgr_org_announcements (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  kind text not null check (kind in ('trial_extended')),
  meta jsonb not null default '{}'::jsonb, -- trial_extended: {trial_ends_at, days, reason}
  created_at timestamptz not null default now()
);
create index if not exists msgr_org_announcements_org on public.msgr_org_announcements (org_id, created_at);
alter table public.msgr_org_announcements enable row level security;
create policy msgr_org_announcements_select on public.msgr_org_announcements for select to authenticated using (public.msgr_is_member(org_id));
grant select on public.msgr_org_announcements to authenticated;
grant all on public.msgr_org_announcements to service_role;

-- ── 무료 기간 연장 — service_role 전용(앱 안에는 쿠폰·코드 입력 화면을 두지 않는다). org=null이면 활성(삭제 안 된) 전 조직. ──
create or replace function public.msgr_extend_trial(p_org uuid, p_days int, p_reason text default null) returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r record; new_end timestamptz;
begin
  if p_days is null or p_days <= 0 or p_days > 365 then raise exception 'msgr_extend_trial_days'; end if;
  for r in
    select e.org_id, greatest(coalesce(e.trial_ends_at, now()), now()) + make_interval(days => p_days) as ends
      from public.msgr_org_entitlements e
      join public.msgr_orgs o on o.id = e.org_id and o.deleted_at is null
     where p_org is null or e.org_id = p_org
  loop
    update public.msgr_org_entitlements set trial_ends_at = r.ends, updated_at = now() where org_id = r.org_id;
    insert into public.msgr_org_announcements (org_id, kind, meta)
      values (r.org_id, 'trial_extended', jsonb_build_object('trial_ends_at', r.ends, 'days', p_days, 'reason', p_reason));
    perform public.msgr_audit(r.org_id, 'org.trial_extend', 'org', r.org_id::text, jsonb_build_object('days', p_days, 'reason', p_reason, 'trial_ends_at', r.ends));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.msgr_extend_trial(uuid, int, text) from public;
revoke execute on function public.msgr_extend_trial(uuid, int, text) from anon, authenticated;
grant execute on function public.msgr_extend_trial(uuid, int, text) to service_role;
