-- 아르고 팀 메신저(msgr) 스키마 — 조직·멤버·초대·채널·메시지·크루 신원·결재 미러·감사. 설계 정본: 루트 MESSENGER-DESIGN.md.
-- 원칙: 기존 개인 스키마(entitlements·account_keys·device_keys…)는 손대지 않고 `msgr_` 접두로 얹는다.
--   크루는 소유자 회사 소속으로 남는다(조직은 크루를 소유하지 않는다) — msgr_crews는 (owner_user_id, ws_id, slug)
--   문자열 참조일 뿐 회사 데이터는 로컬이 정본. 서버는 메시지·첨부를 평문 보관한다(docs/privacy-sync.md 고지 대상).
-- 멤버십 판정 함수는 is_pro()(20260723001629) 관례: security definer + 고정 search_path + auth.uid()만 참조 →
--   호출자 본인의 멤버십만 반환하므로 /rest/v1/rpc 노출돼도 오라클이 되지 않는다. anon EXECUTE는 명시 회수.
-- 이 파일 하나가 셀프호스트 배포 단위다(고객 Supabase/Postgres에 그대로 적용). 멱등(if not exists / drop policy if exists).
-- 드릴: test/msgr-pg-integration.test.mjs(npm run test:pg) — auth·storage·realtime 스텁 위에 이 파일을 그대로 적용한다.

create extension if not exists pgcrypto;

-- ── 조직 ────────────────────────────────────────────────────────────────────────
create table if not exists public.msgr_orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  owner_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.msgr_org_members (
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'member', 'guest')),
  display_name text,
  joined_at timestamptz not null default now(),
  removed_at timestamptz,                   -- 오프보딩 = 행 삭제가 아니라 시각 기록(귀속 표기·감사 유지)
  primary key (org_id, user_id)
);

-- 조직 요금(plan·좌석) — 쓰기 정책 없음: 엣지 펑션(ls-webhook)·서비스 롤만 바꾼다(entitlements와 같은 관례).
create table if not exists public.msgr_org_entitlements (
  org_id uuid primary key references public.msgr_orgs (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'team')),
  seats int not null default 3 check (seats >= 0),
  ls_subscription_id text,
  ls_customer_id text,
  ls_status text,
  ls_updated_at timestamptz,
  ends_at timestamptz,                      -- 해지 예약·만료 = 접근 종료 시각(LS 계약, entitlements와 동일 의미)
  addons jsonb not null default '{}'::jsonb, -- 예: {"resident_node": true}
  updated_at timestamptz not null default now()
);

create table if not exists public.msgr_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  code text not null unique default encode(gen_random_bytes(24), 'hex'), -- 앱 로그인 브리지(app/api/auth/pair)와 같은 24B hex
  role text not null default 'member' check (role in ('admin', 'member', 'guest')),
  email text,
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_by uuid references auth.users (id) on delete set null,   -- 계정 삭제가 초대 이력에 막히지 않게(실측: FK restrict로 사용자 삭제 실패)
  accepted_at timestamptz,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ── 멤버십 판정(정책이 참조하는 정본) ─────────────────────────────────────────────
create or replace function public.msgr_role(org uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select m.role from public.msgr_org_members m
      join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
     where m.org_id = org and m.user_id = auth.uid() and m.removed_at is null
$$;
create or replace function public.msgr_is_member(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_role(org) is not null
$$;
create or replace function public.msgr_is_admin(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_role(org) in ('owner', 'admin')
$$;
-- 조직 plan(행 없음 = free). 좌석 한도·is_pro OR 조건이 함께 본다.
create or replace function public.msgr_org_plan(org uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select case when e.plan = 'team' and (e.ends_at is null or e.ends_at > now()) then 'team' else 'free' end
                       from public.msgr_org_entitlements e where e.org_id = org), 'free')
$$;

-- ── 채널 ────────────────────────────────────────────────────────────────────────
create table if not exists public.msgr_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  kind text not null check (kind in ('public', 'private', 'dm')),
  name text not null check (name ~ '^[^\r\n]{1,80}$'), -- 개행 금지: 채널명은 크루 프롬프트의 발신 문맥 줄에 실린다(S2 검수 HIGH-4 인젝션 표면)
  topic text,
  crew_memory boolean not null default true, -- false = 이 채널 발 크루 턴은 소유자 vault 일지에 남기지 않는다(noJournal)
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);
create index if not exists msgr_channels_org on public.msgr_channels (org_id);

create table if not exists public.msgr_channel_members (
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  member_kind text not null check (member_kind in ('user', 'crew')),
  member_id uuid not null,                  -- user: auth.users.id / crew: msgr_crews.id
  added_by uuid references auth.users (id),
  added_at timestamptz not null default now(),
  primary key (channel_id, member_kind, member_id)
);

-- 채널 열람: public은 owner·admin·member(guest 제외), private/dm은 channel_members. 보관된 채널도 읽기는 유지.
create or replace function public.msgr_can_read_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels c
       where c.id = ch and (
         (c.kind = 'public' and public.msgr_role(c.org_id) in ('owner', 'admin', 'member'))
         or (c.created_by = auth.uid() and public.msgr_is_member(c.org_id)) -- 생성자(비공개 채널 insert … returning이 멤버 등록 전에 select 정책을 본다)
         or exists (select 1 from public.msgr_channel_members m
                     where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()
                       and public.msgr_is_member(c.org_id))
       )
    )
$$;
-- 채널 select 정책 전용: 호출자가 이 채널의 user 멤버인가(security definer라 channel_members RLS를 타지 않는다 —
-- channels 정책 → channel_members 정책 → channels 정책 순환("infinite recursion detected", 드릴 실측)을 끊는다).
create or replace function public.msgr_is_channel_user(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = ch and m.member_kind = 'user' and m.member_id = auth.uid())
$$;
create or replace function public.msgr_can_write_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_can_read_channel(ch)
       and exists (select 1 from public.msgr_channels c where c.id = ch and c.archived_at is null)
$$;

-- ── 크루 신원(조직에 등록된 크루) ───────────────────────────────────────────────
create table if not exists public.msgr_crews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  owner_user_id uuid not null references auth.users (id) on delete cascade,
  ws_id text not null check (ws_id ~ '^[a-z0-9][a-z0-9-]{0,127}$'),   -- src/workspace.mjs WS_ID_RE
  slug text not null check (length(slug) between 1 and 120),
  display_name text not null,
  role_text text,
  hosting text not null default 'local' check (hosting in ('local', 'resident')),
  status text not null default 'active' check (status in ('active', 'detached')),
  allow text not null default 'all' check (allow in ('all', 'list', 'owner')), -- 누가 이 크루에게 일을 시킬 수 있나
  allow_users uuid[] not null default '{}',
  last_seen_at timestamptz,                 -- 브리지 하트비트(30s). 90s 초과 = 부재중 표시
  cursor_msg_id bigint not null default 0,  -- 서버측 커서 — 적재 직후 전진(텔레그램 offset 규율)
  registered_at timestamptz not null default now(),
  unique (org_id, owner_user_id, ws_id, slug)
);
create index if not exists msgr_crews_org on public.msgr_crews (org_id);

-- ── 메시지·첨부 ─────────────────────────────────────────────────────────────────
create table if not exists public.msgr_messages (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  author_kind text not null check (author_kind in ('user', 'crew', 'system')),
  author_user_id uuid references auth.users (id) on delete set null,
  crew_id uuid references public.msgr_crews (id) on delete set null,
  kind text not null default 'text' check (kind in ('text', 'approval_card', 'system')),
  body text not null default '' check (length(body) <= 20000),
  mentions jsonb not null default '[]'::jsonb, -- [{kind:'user'|'crew', id}]
  reply_to bigint references public.msgr_messages (id) on delete set null,
  thread_root bigint references public.msgr_messages (id) on delete set null,
  client_msg_id text,                       -- 멱등 삽입 키. 브리지 답글 = 'reply:<crew_id>:<src_msg_id>' → 리더 교체 창 중복을 DB가 거른다
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  -- crew 글의 crew_id는 insert 정책이 요구한다(소유자 명의). CHECK에서 not null을 강제하지 않는 이유: 크루 삭제(on delete set null)
  -- 뒤에도 글은 남아야 하고("삭제된 크루" 표시), 강제하면 FK 캐스케이드가 CHECK 위반으로 크루 삭제 자체를 막는다(드릴 실측).
  check ((author_kind = 'user' and author_user_id is not null and crew_id is null)
      or (author_kind = 'crew')
      or (author_kind = 'system'))
);
-- 멱등 키는 **작성자 축을 포함**한다(분리 검수 HIGH-4): (channel_id, client_msg_id)만이면 일반 멤버가 'reply:<crew>:<msg>'를
-- 선점해 크루 답글 insert를 유니크 위반으로 막을 수 있었다(DoS 실증). 같은 크루의 재실행(리더 교체 창)은 여전히 한 키다.
drop index if exists public.msgr_messages_client_id;
create unique index if not exists msgr_messages_client_id on public.msgr_messages
  (channel_id, author_kind, coalesce(crew_id::text, author_user_id::text, ''), client_msg_id) where client_msg_id is not null;
create index if not exists msgr_messages_org_id_id on public.msgr_messages (org_id, id);
create index if not exists msgr_messages_channel_id_id on public.msgr_messages (channel_id, id);

create table if not exists public.msgr_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references public.msgr_messages (id) on delete cascade,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  storage_path text not null,               -- 버킷 msgr 안 경로 <org_id>/<channel_id>/<message_id>/<file> (Storage name — 버킷명은 포함하지 않는다)
  name text not null,
  mime text,
  bytes bigint not null default 0 check (bytes >= 0),
  created_at timestamptz not null default now()
);
create index if not exists msgr_attachments_msg on public.msgr_attachments (message_id);

-- ── 결재 미러(정본은 로컬 approvals.json — 여기는 채널에 보이는 투영 + 확정 권한의 서버측 집행) ──
create table if not exists public.msgr_crew_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  crew_id uuid not null references public.msgr_crews (id) on delete cascade,
  approval_id text not null,                -- 로컬 'ap-…'
  action text not null,
  reason text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  decided_by uuid references auth.users (id),
  decided_at timestamptz,
  message_id bigint references public.msgr_messages (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (crew_id, approval_id)
);

-- ── 감사 로그(직접 insert 정책 없음 — 트리거·security definer만) ───────────────
create table if not exists public.msgr_audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  actor_user_id uuid,
  actor_crew_id uuid,
  action text not null,
  target_kind text,
  target_id text,
  meta jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists msgr_audit_org_at on public.msgr_audit_log (org_id, at);

create or replace function public.msgr_audit(org uuid, act text, tkind text, tid text, m jsonb default '{}'::jsonb) returns void
  language sql security definer set search_path = public, pg_temp as $$
    insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
    values (org, auth.uid(), act, tkind, tid, coalesce(m, '{}'::jsonb))
$$;

-- ── 트리거 ──────────────────────────────────────────────────────────────────────
-- 불변 컬럼 잠금(분리 검수 2026-09-03 CRITICAL-1·2): RLS with check는 "새 값"만 보므로 org_id·channel_id 같은 소속 컬럼을
-- 같은 UPDATE에서 바꾸면 채널 재부모화(타 조직 메시지 노출)·결재 확정과 동시에 org 이동(감사 회피)이 가능했다(exploit 실증).
-- 처방은 old 값을 볼 수 있는 유일한 자리인 트리거. 서비스 문맥(auth.uid() null)은 통과 — 운영 도구·엣지 펑션용.
create or replace function public.msgr_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  if pg_trigger_depth() > 1 then return new; end if; -- FK 캐스케이드(on delete set null)·다른 트리거의 내부 UPDATE는 통과(실측: 크루 삭제가 막혔다)
  foreach col in array tg_argv loop
    if n->col is distinct from o->col then raise exception 'msgr_immutable_%', col; end if;
  end loop;
  return new;
end $$;
drop trigger if exists msgr_lock_channels on public.msgr_channels;
create trigger msgr_lock_channels before update on public.msgr_channels for each row execute function public.msgr_lock_cols('org_id', 'kind', 'created_by', 'created_at');
drop trigger if exists msgr_lock_approvals on public.msgr_crew_approvals;
create trigger msgr_lock_approvals before update on public.msgr_crew_approvals for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'created_at');
drop trigger if exists msgr_lock_crews on public.msgr_crews;
create trigger msgr_lock_crews before update on public.msgr_crews for each row execute function public.msgr_lock_cols('org_id', 'owner_user_id', 'ws_id', 'slug', 'registered_at');
drop trigger if exists msgr_lock_members on public.msgr_org_members;
create trigger msgr_lock_members before update on public.msgr_org_members for each row execute function public.msgr_lock_cols('org_id', 'user_id');
drop trigger if exists msgr_lock_messages on public.msgr_messages;
create trigger msgr_lock_messages before update on public.msgr_messages for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'author_kind', 'author_user_id', 'crew_id', 'kind', 'client_msg_id', 'created_at');
-- 조직 생성자는 자동 owner 멤버(security definer — 아직 멤버가 아니라 members insert 정책을 못 지난다).
create or replace function public.msgr_org_after_insert() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.msgr_org_members (org_id, user_id, role) values (new.id, new.owner_user_id, 'owner');
  insert into public.msgr_org_entitlements (org_id) values (new.id) on conflict do nothing;
  perform public.msgr_audit(new.id, 'org.create', 'org', new.id::text);
  return new;
end $$;
drop trigger if exists msgr_org_after_insert on public.msgr_orgs;
create trigger msgr_org_after_insert after insert on public.msgr_orgs for each row execute function public.msgr_org_after_insert();

-- 좌석 한도: free = 3명(guest 포함), team = seats. 활성(removed_at null) 멤버 수로 센다. 되살림(update)도 같은 게이트.
create or replace function public.msgr_member_seat_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare lim int; n int;
begin
  if new.removed_at is not null then return new; end if;
  if tg_op = 'UPDATE' and old.removed_at is null then return new; end if; -- 활성→활성(역할 변경)은 좌석 불변
  perform pg_advisory_xact_lock(hashtext('msgr_seats:' || new.org_id::text)); -- 동시 insert 2건이 각자 스냅샷에서 통과하던 레이스(분리 검수 HIGH-3 실증) 직렬화
  select case when public.msgr_org_plan(new.org_id) = 'team' then coalesce(e.seats, 0) else 3 end
    into lim from public.msgr_org_entitlements e where e.org_id = new.org_id;
  if lim is null then lim := 3; end if;
  select count(*) into n from public.msgr_org_members where org_id = new.org_id and removed_at is null and user_id <> new.user_id;
  if n >= lim then raise exception 'msgr_seat_limit' using detail = format('%s/%s', n, lim); end if;
  return new;
end $$;
drop trigger if exists msgr_member_seat_gate on public.msgr_org_members;
create trigger msgr_member_seat_gate before insert or update on public.msgr_org_members for each row execute function public.msgr_member_seat_gate();

create or replace function public.msgr_member_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then perform public.msgr_audit(new.org_id, 'member.add', 'user', new.user_id::text, jsonb_build_object('role', new.role));
  elsif tg_op = 'DELETE' then perform public.msgr_audit(old.org_id, 'member.delete', 'user', old.user_id::text); return old;
  elsif new.removed_at is not null and old.removed_at is null then perform public.msgr_audit(new.org_id, 'member.remove', 'user', new.user_id::text);
  elsif new.role <> old.role then perform public.msgr_audit(new.org_id, 'member.role', 'user', new.user_id::text, jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  return new;
end $$;
drop trigger if exists msgr_member_audit on public.msgr_org_members;
create trigger msgr_member_audit after insert or update or delete on public.msgr_org_members for each row execute function public.msgr_member_audit();

-- free 조직은 공개 채널 1개.
create or replace function public.msgr_channel_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform pg_advisory_xact_lock(hashtext('msgr_channels:' || new.org_id::text)); -- 좌석 게이트와 같은 레이스 계열
  if new.kind = 'public' and public.msgr_org_plan(new.org_id) = 'free'
     and (select count(*) from public.msgr_channels where org_id = new.org_id and kind = 'public' and archived_at is null) >= 1 then
    raise exception 'msgr_channel_limit';
  end if;
  return new;
end $$;
drop trigger if exists msgr_channel_gate on public.msgr_channels;
create trigger msgr_channel_gate before insert on public.msgr_channels for each row execute function public.msgr_channel_gate();

-- 메시지: org_id는 채널에서 채운다(클라이언트가 남의 org_id를 적어도 무시), reply/thread는 같은 채널만.
create or replace function public.msgr_message_fill() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select org_id into new.org_id from public.msgr_channels where id = new.channel_id;
  if new.org_id is null then raise exception 'msgr_channel_missing'; end if;
  if new.reply_to is not null and not exists (select 1 from public.msgr_messages where id = new.reply_to and channel_id = new.channel_id) then
    raise exception 'msgr_reply_cross_channel';
  end if;
  if new.thread_root is null then new.thread_root := new.reply_to; end if;
  return new;
end $$;
drop trigger if exists msgr_message_fill on public.msgr_messages;
create trigger msgr_message_fill before insert on public.msgr_messages for each row execute function public.msgr_message_fill();

-- Realtime 방송: 본문 없이 id·채널·멘션만(수신자는 PostgREST에서 RLS를 통과한 행만 받는다). private topic org:<org_id>.
create or replace function public.msgr_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'crew_id', new.crew_id,
                       'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to),
    'message', 'org:' || new.org_id::text, true);
  return new;
end $$;
drop trigger if exists msgr_message_broadcast on public.msgr_messages;
create trigger msgr_message_broadcast after insert on public.msgr_messages for each row execute function public.msgr_message_broadcast();

create or replace function public.msgr_approval_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'crew_id', new.crew_id, 'approval_id', new.approval_id, 'status', new.status),
    'approval', 'org:' || new.org_id::text, true);
  if tg_op = 'UPDATE' and new.status <> old.status then
    perform public.msgr_audit(new.org_id, 'approval.' || new.status, 'approval', new.approval_id, jsonb_build_object('crew_id', new.crew_id));
  end if;
  return new;
end $$;
drop trigger if exists msgr_approval_broadcast on public.msgr_crew_approvals;
create trigger msgr_approval_broadcast after insert or update on public.msgr_crew_approvals for each row execute function public.msgr_approval_broadcast();

-- 초대 수락: 코드 일치·미만료·미사용이면 호출자를 멤버로. 좌석 게이트는 members 트리거가 집행한다.
create or replace function public.msgr_accept_invite(code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites i where i.code = msgr_accept_invite.code and i.accepted_at is null and i.expires_at > now() for update;
  if inv.id is null then raise exception 'msgr_invite_invalid'; end if;
  insert into public.msgr_org_members (org_id, user_id, role, display_name)
    values (inv.org_id, auth.uid(), inv.role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()))
    on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, joined_at = now(),
      display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  update public.msgr_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  perform public.msgr_audit(inv.org_id, 'invite.accept', 'invite', inv.id::text);
  return inv.org_id;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────────
alter table public.msgr_orgs enable row level security;
alter table public.msgr_org_members enable row level security;
alter table public.msgr_org_entitlements enable row level security;
alter table public.msgr_invites enable row level security;
alter table public.msgr_channels enable row level security;
alter table public.msgr_channel_members enable row level security;
alter table public.msgr_crews enable row level security;
alter table public.msgr_messages enable row level security;
alter table public.msgr_attachments enable row level security;
alter table public.msgr_crew_approvals enable row level security;
alter table public.msgr_audit_log enable row level security;

drop policy if exists msgr_orgs_select on public.msgr_orgs;
-- 소유자 본인 OR 멤버. 소유자 조건이 필요한 이유(드릴 실측): insert … returning은 select 정책도 검사하는데, 생성자를 멤버로
-- 넣는 AFTER 트리거는 문장 끝에 돌아 RETURNING 시점엔 아직 멤버가 아니다 → 소유자 조건 없이는 조직 생성 자체가 실패한다.
create policy msgr_orgs_select on public.msgr_orgs for select to authenticated
  using (owner_user_id = (select auth.uid()) or public.msgr_is_member(id));
drop policy if exists msgr_orgs_insert on public.msgr_orgs;
create policy msgr_orgs_insert on public.msgr_orgs for insert to authenticated with check (owner_user_id = (select auth.uid()) and deleted_at is null);
drop policy if exists msgr_orgs_update on public.msgr_orgs;
create policy msgr_orgs_update on public.msgr_orgs for update to authenticated
  using (public.msgr_is_admin(id)) with check (public.msgr_is_admin(id));
-- 소유권 이전·삭제 표시는 owner만(정책의 자기 참조 대신 트리거 — old 값을 볼 수 있는 유일한 자리).
create or replace function public.msgr_org_before_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 서비스 문맥(auth.uid() null: 서비스 롤·엣지 펑션·운영 도구)은 통과 — 일반 사용자는 RLS(admin)가 먼저 거르고,
  -- 이 트리거는 admin 중 owner가 아닌 사람의 소유권 이전·삭제 표시를 막는 두 번째 층이다.
  if auth.uid() is not null
     and (new.owner_user_id is distinct from old.owner_user_id or new.deleted_at is distinct from old.deleted_at)
     and public.msgr_role(old.id) is distinct from 'owner' then
    raise exception 'msgr_owner_only';
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    if not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.owner_user_id and removed_at is null) then
      raise exception 'msgr_owner_not_member';
    end if;
    update public.msgr_org_members set role = 'admin' where org_id = old.id and user_id = old.owner_user_id;
    update public.msgr_org_members set role = 'owner' where org_id = old.id and user_id = new.owner_user_id;
    perform public.msgr_audit(old.id, 'org.transfer', 'user', new.owner_user_id::text);
  end if;
  return new;
end $$;
drop trigger if exists msgr_org_before_update on public.msgr_orgs;
create trigger msgr_org_before_update before update on public.msgr_orgs for each row execute function public.msgr_org_before_update();

drop policy if exists msgr_members_select on public.msgr_org_members;
create policy msgr_members_select on public.msgr_org_members for select to authenticated using (public.msgr_is_member(org_id));
drop policy if exists msgr_members_insert on public.msgr_org_members;
create policy msgr_members_insert on public.msgr_org_members for insert to authenticated
  with check (public.msgr_is_admin(org_id) and role <> 'owner');
drop policy if exists msgr_members_update on public.msgr_org_members;
create policy msgr_members_update on public.msgr_org_members for update to authenticated
  using (public.msgr_is_admin(org_id) and (role <> 'owner' or public.msgr_role(org_id) = 'owner'))
  with check (public.msgr_is_admin(org_id) and (role <> 'owner' or public.msgr_role(org_id) = 'owner'));
drop policy if exists msgr_members_delete on public.msgr_org_members;
create policy msgr_members_delete on public.msgr_org_members for delete to authenticated
  using (public.msgr_is_admin(org_id) and role <> 'owner');

drop policy if exists msgr_entitlements_select on public.msgr_org_entitlements;
create policy msgr_entitlements_select on public.msgr_org_entitlements for select to authenticated using (public.msgr_is_member(org_id));

-- update 정책 없음(분리 검수 MEDIUM-8): 수락 표기는 msgr_accept_invite RPC만 쓴다 — admin이 남의 초대를 "수락됨"으로 위조하던 경로 차단.
drop policy if exists msgr_invites_admin on public.msgr_invites;
drop policy if exists msgr_invites_select on public.msgr_invites;
create policy msgr_invites_select on public.msgr_invites for select to authenticated using (public.msgr_is_admin(org_id));
drop policy if exists msgr_invites_insert on public.msgr_invites;
create policy msgr_invites_insert on public.msgr_invites for insert to authenticated
  with check (public.msgr_is_admin(org_id) and created_by = (select auth.uid()));
drop policy if exists msgr_invites_delete on public.msgr_invites;
create policy msgr_invites_delete on public.msgr_invites for delete to authenticated using (public.msgr_is_admin(org_id));

drop policy if exists msgr_channels_select on public.msgr_channels;
-- 자기 테이블 select 정책은 함수(msgr_can_read_channel) 대신 행 컬럼으로 판정한다(드릴 실측): STABLE 함수는 호출 문장의
-- 스냅샷을 써서 insert … returning 시점에 방금 넣은 행을 못 본다 → 함수로 쓰면 채널 생성이 RETURNING에서 실패한다.
create policy msgr_channels_select on public.msgr_channels for select to authenticated
  using ((kind = 'public' and public.msgr_role(org_id) in ('owner', 'admin', 'member'))
      or (created_by = (select auth.uid()) and public.msgr_is_member(org_id))
      or (public.msgr_is_channel_user(id) and public.msgr_is_member(org_id)));
drop policy if exists msgr_channels_insert on public.msgr_channels;
create policy msgr_channels_insert on public.msgr_channels for insert to authenticated
  with check (created_by = (select auth.uid()) and public.msgr_role(org_id) in ('owner', 'admin', 'member'));
drop policy if exists msgr_channels_update on public.msgr_channels;
create policy msgr_channels_update on public.msgr_channels for update to authenticated
  using (public.msgr_is_admin(org_id) or (created_by = (select auth.uid()) and public.msgr_is_member(org_id)))
  with check (public.msgr_is_admin(org_id) or (created_by = (select auth.uid()) and public.msgr_is_member(org_id)));

drop policy if exists msgr_channel_members_select on public.msgr_channel_members;
create policy msgr_channel_members_select on public.msgr_channel_members for select to authenticated using (public.msgr_can_read_channel(channel_id));
-- 멤버 쓰기: 관리자·채널 생성자. DM 참가자는 **자기 행 삭제(나가기)만** — 검수 MEDIUM-5(2026-09-03): 참가자면 누구나
-- 제3자를 1:1에 끼워 넣거나 생성자를 축출할 수 있었다. DM 구성은 생성 시점 트리거(msgr_dm_shape)가 사람 2·크루 1로 고정한다.
drop policy if exists msgr_channel_members_write on public.msgr_channel_members;
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
-- 관리자 조항은 DM에는 적용하지 않는다(검수 2R LOW-4: 참가 중인 관리자가 상대를 축출하던 경로) — DM은 생성자와 본인만.
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (exists (select 1 from public.msgr_channels c where c.id = channel_id
                   and ((public.msgr_is_admin(c.org_id) and c.kind <> 'dm') or c.created_by = (select auth.uid()))));
drop policy if exists msgr_channel_members_update on public.msgr_channel_members;
create policy msgr_channel_members_update on public.msgr_channel_members for update to authenticated
  using (exists (select 1 from public.msgr_channels c where c.id = channel_id and ((public.msgr_is_admin(c.org_id) and c.kind <> 'dm') or c.created_by = (select auth.uid()))))
  with check (exists (select 1 from public.msgr_channels c where c.id = channel_id and ((public.msgr_is_admin(c.org_id) and c.kind <> 'dm') or c.created_by = (select auth.uid()))));
drop policy if exists msgr_channel_members_delete on public.msgr_channel_members;
create policy msgr_channel_members_delete on public.msgr_channel_members for delete to authenticated
  using ((member_kind = 'user' and member_id = (select auth.uid()))
      or exists (select 1 from public.msgr_channels c where c.id = channel_id and ((public.msgr_is_admin(c.org_id) and c.kind <> 'dm') or c.created_by = (select auth.uid()))));

-- DM 구성 고정: 사람 ≤ 2(생성자·상대 또는 생성자·크루 소유자), 크루 ≤ 1. 초과 insert는 거절(제3자 끼워넣기 차단).
create or replace function public.msgr_dm_shape() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; nu int; nc int;
begin
  select kind into k from public.msgr_channels where id = new.channel_id;
  if k <> 'dm' then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || new.channel_id::text)); -- 좌석·채널 게이트와 같은 레이스 계열(검수 2R LOW-2)
  select count(*) filter (where member_kind = 'user'), count(*) filter (where member_kind = 'crew') into nu, nc
    from public.msgr_channel_members where channel_id = new.channel_id;
  if (new.member_kind = 'user' and nu >= 2) or (new.member_kind = 'crew' and nc >= 1) then raise exception 'msgr_dm_full'; end if;
  return new;
end $$;
revoke execute on function public.msgr_dm_shape() from anon, public;
drop trigger if exists msgr_dm_shape on public.msgr_channel_members;
create trigger msgr_dm_shape before insert on public.msgr_channel_members for each row execute function public.msgr_dm_shape();

drop policy if exists msgr_crews_select on public.msgr_crews;
create policy msgr_crews_select on public.msgr_crews for select to authenticated using (public.msgr_is_member(org_id));
drop policy if exists msgr_crews_insert on public.msgr_crews;
create policy msgr_crews_insert on public.msgr_crews for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and public.msgr_role(org_id) in ('owner', 'admin', 'member'));
-- 소유자: 전부 수정 가능(하트비트·커서·허용 범위). admin: 타인 크루의 status(detach)만 — with check에서 다른 컬럼 불변을 강제.
drop policy if exists msgr_crews_update_owner on public.msgr_crews;
create policy msgr_crews_update_owner on public.msgr_crews for update to authenticated
  using (owner_user_id = (select auth.uid())) with check (owner_user_id = (select auth.uid()));
drop policy if exists msgr_crews_update_admin on public.msgr_crews;
create policy msgr_crews_update_admin on public.msgr_crews for update to authenticated
  using (public.msgr_is_admin(org_id))
  with check (public.msgr_is_admin(org_id) and (owner_user_id, ws_id, slug, allow, allow_users, cursor_msg_id, hosting) =
    (select c.owner_user_id, c.ws_id, c.slug, c.allow, c.allow_users, c.cursor_msg_id, c.hosting from public.msgr_crews c where c.id = msgr_crews.id));
drop policy if exists msgr_crews_delete on public.msgr_crews;
create policy msgr_crews_delete on public.msgr_crews for delete to authenticated
  using (owner_user_id = (select auth.uid()) or public.msgr_is_admin(org_id));

drop policy if exists msgr_messages_select on public.msgr_messages;
create policy msgr_messages_select on public.msgr_messages for select to authenticated using (public.msgr_can_read_channel(channel_id));
drop policy if exists msgr_messages_insert on public.msgr_messages;
create policy msgr_messages_insert on public.msgr_messages for insert to authenticated
  with check (
    public.msgr_can_write_channel(channel_id)
    and ((author_kind = 'user' and author_user_id = (select auth.uid()))
      or (author_kind = 'crew' and exists (select 1 from public.msgr_crews c where c.id = crew_id and c.owner_user_id = (select auth.uid())
                                             and c.status = 'active' and c.org_id = (select org_id from public.msgr_channels ch where ch.id = channel_id))))
  );
drop policy if exists msgr_messages_update on public.msgr_messages;
create policy msgr_messages_update on public.msgr_messages for update to authenticated
  using (author_kind = 'user' and author_user_id = (select auth.uid()))
  with check (author_kind = 'user' and author_user_id = (select auth.uid()));

drop policy if exists msgr_attachments_select on public.msgr_attachments;
create policy msgr_attachments_select on public.msgr_attachments for select to authenticated
  using (exists (select 1 from public.msgr_messages m where m.id = message_id and public.msgr_can_read_channel(m.channel_id)));
drop policy if exists msgr_attachments_insert on public.msgr_attachments;
create policy msgr_attachments_insert on public.msgr_attachments for insert to authenticated
  with check (exists (select 1 from public.msgr_messages m where m.id = msgr_attachments.message_id and m.org_id = msgr_attachments.org_id
                        and ((m.author_kind = 'user' and m.author_user_id = (select auth.uid()))
                          or (m.author_kind = 'crew' and exists (select 1 from public.msgr_crews c where c.id = m.crew_id and c.owner_user_id = (select auth.uid()))))));

drop policy if exists msgr_approvals_select on public.msgr_crew_approvals;
create policy msgr_approvals_select on public.msgr_crew_approvals for select to authenticated using (public.msgr_can_read_channel(channel_id));
drop policy if exists msgr_approvals_insert on public.msgr_crew_approvals;
create policy msgr_approvals_insert on public.msgr_crew_approvals for insert to authenticated
  -- ⚠ 서브쿼리 안의 맨 org_id는 c.org_id로 묶인다(자기 비교=항상 참) — 바깥 행은 테이블명으로 한정한다(실측 2026-09-03).
  with check (status = 'pending' and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid()) and c.org_id = msgr_crew_approvals.org_id));
-- 확정은 크루 소유자만(역할 무관 — BYOK·책임 귀속). pending인 행만, 최종 상태로만.
drop policy if exists msgr_approvals_decide on public.msgr_crew_approvals;
create policy msgr_approvals_decide on public.msgr_crew_approvals for update to authenticated
  using (status = 'pending' and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))
  with check (exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid()))
              and ((status = 'pending' and decided_by is null)                                     -- 브리지의 카드 링크(message_id) 등 pending 유지 갱신
                or (status in ('approved', 'rejected', 'expired') and decided_by = (select auth.uid())))); -- 확정은 본인 명의로만

drop policy if exists msgr_audit_select on public.msgr_audit_log;
create policy msgr_audit_select on public.msgr_audit_log for select to authenticated using (public.msgr_is_admin(org_id));

-- ── 권한 ────────────────────────────────────────────────────────────────────────
grant select, insert, update, delete on public.msgr_orgs, public.msgr_org_members, public.msgr_invites, public.msgr_channels,
  public.msgr_channel_members, public.msgr_crews, public.msgr_messages, public.msgr_attachments, public.msgr_crew_approvals to authenticated;
grant select on public.msgr_org_entitlements, public.msgr_audit_log to authenticated;
grant all on public.msgr_orgs, public.msgr_org_members, public.msgr_org_entitlements, public.msgr_invites, public.msgr_channels,
  public.msgr_channel_members, public.msgr_crews, public.msgr_messages, public.msgr_attachments, public.msgr_crew_approvals, public.msgr_audit_log to service_role;
grant usage, select on all sequences in schema public to authenticated, service_role;

do $$ declare f text; begin
  foreach f in array array['msgr_role(uuid)', 'msgr_is_member(uuid)', 'msgr_is_admin(uuid)', 'msgr_org_plan(uuid)', 'msgr_is_channel_user(uuid)',
                           'msgr_can_read_channel(uuid)', 'msgr_can_write_channel(uuid)', 'msgr_accept_invite(text)',
                           'msgr_audit(uuid,text,text,text,jsonb)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f); -- Supabase default privileges 갭(20260723 실측) 방어
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.msgr_audit(uuid,text,text,text,jsonb) from authenticated; -- 감사는 트리거·RPC 내부에서만(직접 위조 금지)

-- uuid 형식이 아니면 null → 비멤버 판정(캐스트 예외로 정책 평가 자체가 터지지 않게 — AND 평가 순서는 보장되지 않는다). Realtime·Storage 정책 공용.
create or replace function public.msgr_uuid_or_null(t text) returns uuid
  language sql immutable as $$
    select case when t ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then t::uuid else null end
$$;

-- ── Realtime 인가(private topic org:<org_id>) ─────────────────────────────────
-- 수신(select)·송신(insert, 타이핑 표시) 모두 조직 멤버만. payload에 본문이 없으니 채널 비밀은 PostgREST RLS가 지킨다.
drop policy if exists msgr_realtime_recv on realtime.messages;
create policy msgr_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'org:%'
         and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))));
drop policy if exists msgr_realtime_send on realtime.messages;
create policy msgr_realtime_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and (select realtime.topic()) like 'org:%'
              and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))));

-- ── Storage 버킷 msgr — name = <org_id>/<channel_id>/<message_id>/<file>, 1세그먼트 = 조직 멤버십 ────
-- 채널 단위(분리 검수 HIGH-5): Supabase Storage는 서명 URL 없이도 authenticated 경로로 RLS select만 통과하면 직접 내려받는다 —
-- 조직 단위 정책이면 비공개 채널·DM 첨부가 조직 전체에 공개된다. 2세그먼트(channel_id)로 채널 열람 판정을 건다.
drop policy if exists msgr_files_select on storage.objects;
create policy msgr_files_select on storage.objects for select to authenticated
  using (bucket_id = 'msgr' and public.msgr_can_read_channel(public.msgr_uuid_or_null((storage.foldername(name))[2])));
drop policy if exists msgr_files_insert on storage.objects;
create policy msgr_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'msgr' and public.msgr_is_member(public.msgr_uuid_or_null((storage.foldername(name))[1]))
              and public.msgr_can_write_channel(public.msgr_uuid_or_null((storage.foldername(name))[2])));
drop policy if exists msgr_files_delete on storage.objects;
create policy msgr_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'msgr' and public.msgr_is_admin(public.msgr_uuid_or_null((storage.foldername(name))[1])));

-- ── is_pro(): 활성 Team 좌석 보유자도 Pro(좌석 ⊇ 개인 Pro). 개인 entitlements·14일 체험 OR은 20260730050000 그대로. ──
create or replace function public.is_pro() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select plan = 'pro' and (ends_at is null or ends_at > now())
                       from public.entitlements where user_id = auth.uid()), false)
        or coalesce((select created_at > now() - interval '14 days' from auth.users where id = auth.uid()), false)
        or exists (select 1 from public.msgr_org_members m
                     join public.msgr_org_entitlements e on e.org_id = m.org_id
                     join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
                    where m.user_id = auth.uid() and m.removed_at is null and m.role <> 'guest'
                      and e.plan = 'team' and (e.ends_at is null or e.ends_at > now()))
$$;
revoke all on function public.is_pro() from public;
revoke execute on function public.is_pro() from anon;
grant execute on function public.is_pro() to authenticated;

-- ── H-0 조직 정책(부록 H, 2026-09-03): 정책의 정본은 조직. 항목마다 기본값+잠금. 관리자만 편집, 변경은 감사 로그.
--    잠긴 항목은 크루 소유자·채널 생성자가 못 바꾼다(서버 트리거가 거절 — 소유자 코드가 우회 못 함). 잠그는 순간 기존 행을 기본값으로 정리(sweep).
--    조직이 강제할 수 있는 것은 서버가 검증하는 항목뿐이다 — 개인 PC 브리지의 실제 러너·로컬 기록은 여기서 못 막는다(관리자 화면에 정직 표기).
create table if not exists public.msgr_org_policies (
  org_id uuid primary key references public.msgr_orgs (id) on delete cascade,
  allow_default text not null default 'owner' check (allow_default in ('all', 'list', 'owner')), -- 크루 허용 범위 기본값(등록 시 강제 적용은 잠금일 때만)
  allow_locked boolean not null default false,
  crew_memory_default boolean not null default true,                                             -- 채널 crew_memory 기본값
  crew_memory_locked boolean not null default false,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.msgr_org_policies enable row level security;
grant select, update on public.msgr_org_policies to authenticated;
grant all on public.msgr_org_policies to service_role;
drop policy if exists msgr_policies_select on public.msgr_org_policies;
create policy msgr_policies_select on public.msgr_org_policies for select to authenticated using (public.msgr_is_member(org_id));
drop policy if exists msgr_policies_update on public.msgr_org_policies;
create policy msgr_policies_update on public.msgr_org_policies for update to authenticated
  using (public.msgr_is_admin(org_id)) with check (public.msgr_is_admin(org_id));
drop trigger if exists msgr_lock_policies on public.msgr_org_policies;
create trigger msgr_lock_policies before update on public.msgr_org_policies for each row execute function public.msgr_lock_cols('org_id');
-- 행은 조직 생성 트리거가 만든다(클라이언트 insert 정책 없음). 이미 있는 조직은 백필.
insert into public.msgr_org_policies (org_id) select id from public.msgr_orgs on conflict do nothing;
create or replace function public.msgr_org_after_insert() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.msgr_org_members (org_id, user_id, role) values (new.id, new.owner_user_id, 'owner');
  insert into public.msgr_org_entitlements (org_id) values (new.id) on conflict do nothing;
  insert into public.msgr_org_policies (org_id) values (new.id) on conflict do nothing;
  perform public.msgr_audit(new.id, 'org.create', 'org', new.id::text);
  return new;
end $$;
-- 정책 갱신: 도장(updated_by·at) → 잠금이면 기존 크루·채널을 기본값으로 정리 → 감사.
create or replace function public.msgr_policy_before_update() returns trigger
  language plpgsql as $$
begin
  new.updated_by := auth.uid(); new.updated_at := now();
  return new;
end $$;
drop trigger if exists msgr_policy_before_update on public.msgr_org_policies;
create trigger msgr_policy_before_update before update on public.msgr_org_policies for each row execute function public.msgr_policy_before_update();
create or replace function public.msgr_policy_after_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.allow_locked then
    update public.msgr_crews set allow = new.allow_default, allow_users = case when new.allow_default = 'list' then allow_users else '{}'::uuid[] end
     where org_id = new.org_id and allow <> new.allow_default;
  end if;
  if new.crew_memory_locked then
    update public.msgr_channels set crew_memory = new.crew_memory_default where org_id = new.org_id and crew_memory <> new.crew_memory_default;
  end if;
  perform public.msgr_audit(new.org_id, 'policy.update', 'policy', new.org_id::text, jsonb_build_object(
    'allow_default', new.allow_default, 'allow_locked', new.allow_locked, 'crew_memory_default', new.crew_memory_default, 'crew_memory_locked', new.crew_memory_locked));
  return new;
end $$;
drop trigger if exists msgr_policy_after_update on public.msgr_org_policies;
create trigger msgr_policy_after_update after update on public.msgr_org_policies for each row execute function public.msgr_policy_after_update();
-- 크루 허용 범위 게이트: 잠금이면 insert는 기본값으로 맞추고(등록 카드가 읽어 보여준다), update로 다른 값을 넣으면 거절.
create or replace function public.msgr_crew_policy_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.msgr_org_policies;
begin
  select * into p from public.msgr_org_policies where org_id = new.org_id;
  if p.org_id is null or not p.allow_locked then return new; end if;
  if tg_op = 'INSERT' then
    new.allow := p.allow_default; if new.allow <> 'list' then new.allow_users := '{}'::uuid[]; end if;
    return new;
  end if;
  if new.allow <> p.allow_default then raise exception 'msgr_policy_locked' using detail = 'allow'; end if;
  return new;
end $$;
drop trigger if exists msgr_crew_policy_gate on public.msgr_crews;
create trigger msgr_crew_policy_gate before insert or update on public.msgr_crews for each row execute function public.msgr_crew_policy_gate();
-- 채널 크루 기억 게이트: 같은 규칙(insert 맞춤·update 거절).
create or replace function public.msgr_channel_policy_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.msgr_org_policies;
begin
  select * into p from public.msgr_org_policies where org_id = new.org_id;
  if p.org_id is null or not p.crew_memory_locked then return new; end if;
  if tg_op = 'INSERT' then new.crew_memory := p.crew_memory_default; return new; end if;
  if new.crew_memory <> p.crew_memory_default then raise exception 'msgr_policy_locked' using detail = 'crew_memory'; end if;
  return new;
end $$;
drop trigger if exists msgr_channel_policy_gate on public.msgr_channels;
create trigger msgr_channel_policy_gate before insert or update on public.msgr_channels for each row execute function public.msgr_channel_policy_gate();

-- ── H-1 결재권 규칙·위험 등급(부록 H): 저위험은 크루 소유자, 고위험(발송·결제·삭제·게시·계약·커넥터 쓰기)은 조직 정책의 결재권자.
--    risk는 브리지가 등록 시 코드 판정(src/approval-risk.mjs)으로 싣고, 이후 잠긴다(등급 하향 금지). 정책 approval_high_by: 'admin'(기본) | 'owner'.
alter table public.msgr_crew_approvals add column if not exists risk text not null default 'low' check (risk in ('low', 'high'));
alter table public.msgr_org_policies add column if not exists approval_high_by text not null default 'admin' check (approval_high_by in ('owner', 'admin'));
drop trigger if exists msgr_lock_approvals on public.msgr_crew_approvals;
create trigger msgr_lock_approvals before update on public.msgr_crew_approvals for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'created_at', 'risk');
-- 결재 확정권 판정(호출자 본인 기준, 행은 문장 전 스냅샷 — STABLE). 저위험=크루 소유자 / 고위험=정책이 'owner'면 소유자, 'admin'이면 조직 관리자.
create or replace function public.msgr_can_decide(ap uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when a.risk = 'low' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'owner' then c.owner_user_id = auth.uid()
      else public.msgr_is_admin(a.org_id)
    end
      from public.msgr_crew_approvals a
      join public.msgr_crews c on c.id = a.crew_id
      left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap
$$;
revoke all on function public.msgr_can_decide(uuid) from public;
revoke execute on function public.msgr_can_decide(uuid) from anon;
grant execute on function public.msgr_can_decide(uuid) to authenticated;
drop policy if exists msgr_approvals_decide on public.msgr_crew_approvals;
create policy msgr_approvals_decide on public.msgr_crew_approvals for update to authenticated
  using (status = 'pending' and (public.msgr_can_decide(id) or exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid()))))
  with check ((status = 'pending' and decided_by is null                                             -- 브리지(크루 소유자)의 카드 링크(message_id) 등 pending 유지 갱신
                and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))
           or (status in ('approved', 'rejected', 'expired') and decided_by = (select auth.uid()) and public.msgr_can_decide(id))); -- 확정은 결재권자 본인 명의로만
