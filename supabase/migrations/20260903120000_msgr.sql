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
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id, 'crew_id', new.crew_id, -- author_user_id: 로컬 알림이 자기 글을 거르고 보낸 이름을 붙인다(F2-5). 본문은 여전히 없음
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

-- ── H-2 허용 판정을 서버로(부록 H·K): "누가 이 크루에게 일을 시킬 수 있나"의 정본 판정은 msgr_can_instruct. 브리지는 이 RPC를 묻고,
--    크루 답글(client_msg_id 'reply:<crew>:<src>')은 서버 트리거가 원문 작성자를 다시 판정해 정책 밖 답글을 거절한다(브리지가 무시해도 서버가 막는다).
create or replace function public.msgr_can_instruct(crew uuid, author uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then false
      when c.owner_user_id = author then true
      when c.allow = 'owner' then false
      when c.allow = 'list' then author = any (c.allow_users) and m.user_id is not null
      else m.user_id is not null   -- 'all' = 활성 조직 멤버 전원
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$$;
revoke all on function public.msgr_can_instruct(uuid, uuid) from public;
revoke execute on function public.msgr_can_instruct(uuid, uuid) from anon;
grant execute on function public.msgr_can_instruct(uuid, uuid) to authenticated;
create or replace function public.msgr_crew_reply_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare src public.msgr_messages; src_id bigint;
begin
  if new.author_kind <> 'crew' or new.client_msg_id is null or new.client_msg_id !~ '^reply:[^:]+:[0-9]+$' then return new; end if;
  src_id := split_part(new.client_msg_id, ':', 3)::bigint;
  select * into src from public.msgr_messages where id = src_id;
  if src.id is null or src.author_kind <> 'user' then return new; end if; -- 원문 없음(삭제)·크루/시스템 원문은 지시가 아니다
  if not public.msgr_can_instruct(new.crew_id, src.author_user_id) then
    raise exception 'msgr_not_allowed' using detail = 'crew reply to an author outside the crew allow policy';
  end if;
  return new;
end $$;
drop trigger if exists msgr_crew_reply_gate on public.msgr_messages;
create trigger msgr_crew_reply_gate before insert on public.msgr_messages for each row execute function public.msgr_crew_reply_gate();

-- ── I-1 조직 서비스 계정·회사 크루 판별(부록 I·K): 회사 크루 = "조직의 서비스 계정이 소유하고 상주 노드에서 도는 크루"를 서버 조인으로 판정한다.
--    브리지가 "나는 회사 크루"라고 주장할 방법이 없다. 서비스 계정은 관리자가 지정하며 활성 멤버여야 한다(상주 노드 부트스트랩 I-4가 채운다).
alter table public.msgr_orgs add column if not exists service_user_id uuid references auth.users (id) on delete set null;
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
  if new.service_user_id is distinct from old.service_user_id then
    if new.service_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.service_user_id and removed_at is null) then
      raise exception 'msgr_service_not_member';
    end if;
    perform public.msgr_audit(old.id, 'org.service_account', 'org', old.id::text, jsonb_build_object('from', old.service_user_id, 'to', new.service_user_id));
  end if;
  return new;
end $$;
-- 크루 등급: 'company'(서비스 계정 소유 + resident) | 'personal'(그 외). 화면·채널 정책(I-3)·결재권의 단일 판정.
create or replace function public.msgr_crew_tier(crew uuid) returns text
  language sql stable security invoker set search_path = public, pg_temp as $$ -- invoker: 호출자의 RLS를 따른다(비멤버는 행이 없어 null) — 판정을 오라클로 쓰지 못하게
    select case when o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident' then 'company' else 'personal' end
      from public.msgr_crews c join public.msgr_orgs o on o.id = c.org_id where c.id = crew
$$;
revoke all on function public.msgr_crew_tier(uuid) from public;
revoke execute on function public.msgr_crew_tier(uuid) from anon;
grant execute on function public.msgr_crew_tier(uuid) to authenticated;

-- ── I-3 채널의 개인 크루 참여 정책(부록 I·K — 민감한 채널은 회사 크루만): allowed | read_only(멤버·열람은 되나 지시 불가) | blocked(멤버 추가도 불가).
--    판정 정본 msgr_instruct_check(crew, author, channel) → 'ok' | 'inactive' | 'crew_allow' | 'channel_policy'. msgr_can_instruct는 그 boolean 포장.
alter table public.msgr_channels add column if not exists personal_crews text not null default 'allowed' check (personal_crews in ('allowed', 'read_only', 'blocked'));
create or replace function public.msgr_instruct_check(crew uuid, author uuid, channel uuid default null) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      when channel is not null and ch.personal_crews <> 'allowed'
           and not (o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident') then 'channel_policy' -- 개인 크루는 이 채널에서 지시 불가(소유자도)
      when c.owner_user_id = author then 'ok'
      when c.allow = 'owner' then 'crew_allow'
      when c.allow = 'list' then case when author = any (c.allow_users) and m.user_id is not null then 'ok' else 'crew_allow' end
      else case when m.user_id is not null then 'ok' else 'crew_allow' end
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_orgs o on o.id = c.org_id
      left join public.msgr_channels ch on ch.id = channel
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$$;
revoke all on function public.msgr_instruct_check(uuid, uuid, uuid) from public;
revoke execute on function public.msgr_instruct_check(uuid, uuid, uuid) from anon;
grant execute on function public.msgr_instruct_check(uuid, uuid, uuid) to authenticated;
create or replace function public.msgr_can_instruct(crew uuid, author uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$ select public.msgr_instruct_check(crew, author, null) = 'ok' $$;
create or replace function public.msgr_can_instruct(crew uuid, author uuid, channel uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$ select public.msgr_instruct_check(crew, author, channel) = 'ok' $$;
revoke all on function public.msgr_can_instruct(uuid, uuid, uuid) from public;
revoke execute on function public.msgr_can_instruct(uuid, uuid, uuid) from anon;
grant execute on function public.msgr_can_instruct(uuid, uuid, uuid) to authenticated;
-- 크루 답글 게이트: 채널 정책까지 재판정
create or replace function public.msgr_crew_reply_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare src public.msgr_messages; src_id bigint;
begin
  if new.author_kind <> 'crew' or new.client_msg_id is null or new.client_msg_id !~ '^reply:[^:]+:[0-9]+$' then return new; end if;
  src_id := split_part(new.client_msg_id, ':', 3)::bigint;
  select * into src from public.msgr_messages where id = src_id;
  if src.id is null or src.author_kind <> 'user' then return new; end if; -- 원문 없음(삭제)·크루/시스템 원문은 지시가 아니다
  if not public.msgr_can_instruct(new.crew_id, src.author_user_id, new.channel_id) then
    raise exception 'msgr_not_allowed' using detail = 'crew reply to an author outside the crew allow policy or channel policy';
  end if;
  return new;
end $$;
-- 채널 멤버 게이트: blocked 채널에는 개인 크루를 넣을 수 없다. 정책을 blocked로 바꾸면 기존 개인 크루 멤버는 제거(sweep).
create or replace function public.msgr_channel_personal_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.member_kind = 'crew' and exists (select 1 from public.msgr_channels ch where ch.id = new.channel_id and ch.personal_crews = 'blocked')
     and not exists (select 1 from public.msgr_crews c join public.msgr_orgs o on o.id = c.org_id
                       where c.id = new.member_id and o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident') then
    raise exception 'msgr_channel_personal_blocked';
  end if;
  return new;
end $$;
drop trigger if exists msgr_channel_personal_gate on public.msgr_channel_members;
create trigger msgr_channel_personal_gate before insert on public.msgr_channel_members for each row execute function public.msgr_channel_personal_gate();
create or replace function public.msgr_channel_policy_sweep() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.personal_crews = 'blocked' and old.personal_crews <> 'blocked' then
    delete from public.msgr_channel_members cm using public.msgr_crews c left join public.msgr_orgs o on o.id = c.org_id
     where cm.channel_id = new.id and cm.member_kind = 'crew' and cm.member_id = c.id
       and not (o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident');
  end if;
  if new.personal_crews is distinct from old.personal_crews then
    perform public.msgr_audit(new.org_id, 'channel.personal_crews', 'channel', new.id::text, jsonb_build_object('from', old.personal_crews, 'to', new.personal_crews));
  end if;
  return new;
end $$;
drop trigger if exists msgr_channel_policy_sweep on public.msgr_channels;
create trigger msgr_channel_policy_sweep after update on public.msgr_channels for each row execute function public.msgr_channel_policy_sweep();

-- ── G-1 조직 문서(부록 G): 규칙집(rules/)·용어집(glossary/)·프로젝트 맥락(projects/)의 정본은 서버. 범위 = 전사(channel_id null) | 채널.
--    편집: 전사=관리자, 채널=채널 멤버(쓰기 가능 채널). 버전은 갱신마다 +1, 변경은 감사. 로컬 미러(G-2)·규칙 주입(G-3)·제안 결재(G-4)가 이 테이블을 읽는다.
create table if not exists public.msgr_org_docs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  channel_id uuid references public.msgr_channels (id) on delete cascade,      -- null = 전사
  path text not null check (path ~ '^(rules|glossary|projects)/[a-z0-9][a-z0-9_-]{0,79}\.md$'), -- 미러 파일 경로(vault/org/<org>/<path>) — 폴더 3종 고정
  title text not null check (length(title) between 1 and 120),
  body text not null default '' check (length(body) <= 65536),
  version int not null default 1,
  created_by uuid not null references auth.users (id),
  updated_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists msgr_org_docs_path on public.msgr_org_docs (org_id, coalesce(channel_id, org_id), path);
create index if not exists msgr_org_docs_org_updated on public.msgr_org_docs (org_id, updated_at);
alter table public.msgr_org_docs enable row level security;
grant select, insert, update, delete on public.msgr_org_docs to authenticated;
grant all on public.msgr_org_docs to service_role;
-- 편집권 판정(범위별): 전사=관리자, 채널=쓰기 가능 채널(보관 채널 제외)의 열람자
create or replace function public.msgr_can_edit_doc(org uuid, ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case when ch is null then public.msgr_is_admin(org)
                else public.msgr_can_write_channel(ch) and exists (select 1 from public.msgr_channels c where c.id = ch and c.org_id = org) end
$$;
revoke all on function public.msgr_can_edit_doc(uuid, uuid) from public;
revoke execute on function public.msgr_can_edit_doc(uuid, uuid) from anon;
grant execute on function public.msgr_can_edit_doc(uuid, uuid) to authenticated;
drop policy if exists msgr_docs_select on public.msgr_org_docs;
create policy msgr_docs_select on public.msgr_org_docs for select to authenticated
  using ((channel_id is null and public.msgr_is_member(org_id)) or (channel_id is not null and public.msgr_can_read_channel(channel_id)));
drop policy if exists msgr_docs_insert on public.msgr_org_docs;
create policy msgr_docs_insert on public.msgr_org_docs for insert to authenticated
  with check (public.msgr_can_edit_doc(org_id, channel_id) and created_by = (select auth.uid()) and updated_by = (select auth.uid()));
drop policy if exists msgr_docs_update on public.msgr_org_docs;
create policy msgr_docs_update on public.msgr_org_docs for update to authenticated
  using (public.msgr_can_edit_doc(org_id, channel_id)) with check (public.msgr_can_edit_doc(org_id, channel_id));
drop policy if exists msgr_docs_delete on public.msgr_org_docs;
create policy msgr_docs_delete on public.msgr_org_docs for delete to authenticated using (public.msgr_can_edit_doc(org_id, channel_id));
drop trigger if exists msgr_lock_docs on public.msgr_org_docs;
create trigger msgr_lock_docs before update on public.msgr_org_docs for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'path', 'created_by', 'created_at');
create or replace function public.msgr_doc_before_write() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.channel_id is not null then
    select org_id into new.org_id from public.msgr_channels where id = new.channel_id; -- 채널 문서의 org는 채널의 org(위조 무력화)
    if new.org_id is null then raise exception 'msgr_doc_channel_missing'; end if;
  end if;
  if tg_op = 'UPDATE' then
    new.version := old.version + 1; new.updated_at := now(); new.updated_by := coalesce(auth.uid(), old.updated_by); -- 갱신마다 버전 +1(서비스 문맥은 이전 갱신자 유지)
  end if;
  return new;
end $$;
drop trigger if exists msgr_doc_before_write on public.msgr_org_docs;
create trigger msgr_doc_before_write before insert or update on public.msgr_org_docs for each row execute function public.msgr_doc_before_write();
create or replace function public.msgr_doc_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_org_docs;
begin
  r := coalesce(new, old);
  perform public.msgr_audit(r.org_id, 'doc.' || lower(tg_op), 'doc', r.id::text, jsonb_build_object('path', r.path, 'channel_id', r.channel_id, 'version', r.version));
  return null;
end $$;
drop trigger if exists msgr_doc_audit on public.msgr_org_docs;
create trigger msgr_doc_audit after insert or update or delete on public.msgr_org_docs for each row execute function public.msgr_doc_audit();

-- ── G-4 조직 문서 제안 결재(부록 G·H): 크루가 배운 것을 "조직 문서 제안" 결재 카드로 올리고, 범위의 관리자(전사=조직 관리자, 채널=편집권자)가 승인하면
--    서버가 문서를 만들거나 갱신한다(브리지·크루 소유자는 문서를 쓰지 않는다 — 승인자의 권한으로만 반영). 위험 등급은 항상 high(관리자 확정).
alter table public.msgr_crew_approvals add column if not exists kind text not null default 'action' check (kind in ('action', 'profile', 'hire', 'connector', 'loop', 'mcp', 'capability', 'org_doc'));
alter table public.msgr_crew_approvals add column if not exists payload jsonb;
drop trigger if exists msgr_lock_approvals on public.msgr_crew_approvals;
create trigger msgr_lock_approvals before update on public.msgr_crew_approvals for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'crew_id', 'approval_id', 'action', 'created_at', 'risk', 'kind', 'payload');
create or replace function public.msgr_apply_org_doc() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare ch uuid; pth text; ttl text; bdy text; existing uuid; who uuid;
begin
  if new.kind <> 'org_doc' or new.status <> 'approved' or old.status = 'approved' then return new; end if;
  who := coalesce(new.decided_by, auth.uid());
  ch := nullif(new.payload->>'channel_id', '')::uuid;
  pth := new.payload->>'path'; ttl := coalesce(new.payload->>'title', ''); bdy := coalesce(new.payload->>'body', '');
  if pth is null or ttl = '' then raise exception 'msgr_org_doc_payload'; end if;
  if ch is not null and not exists (select 1 from public.msgr_channels c where c.id = ch and c.org_id = new.org_id) then raise exception 'msgr_org_doc_channel'; end if;
  -- 승인자의 편집권으로만 반영(정책: 승인 = 범위의 관리자). 결재 RLS가 이미 관리자만 확정하게 하지만, 채널 범위는 편집권까지 다시 본다.
  -- NULL 주의: auth.uid()가 없는 서비스 문맥에서 msgr_is_admin은 false가 아니라 NULL이고 `if not NULL`은 조용히 통과한다(변이 배터리 실측) → coalesce로 닫는다
  if not coalesce(public.msgr_is_admin(new.org_id), false) and not coalesce(ch is not null and public.msgr_can_edit_doc(new.org_id, ch), false) then raise exception 'msgr_org_doc_forbidden'; end if;
  select id into existing from public.msgr_org_docs d where d.org_id = new.org_id and coalesce(d.channel_id, d.org_id) = coalesce(ch, new.org_id) and d.path = pth;
  if existing is null then
    insert into public.msgr_org_docs (org_id, channel_id, path, title, body, created_by, updated_by) values (new.org_id, ch, pth, ttl, bdy, who, who);
  else
    update public.msgr_org_docs set title = ttl, body = bdy where id = existing; -- before_write 트리거가 version+1·updated_by(=auth.uid()=승인자)
  end if;
  perform public.msgr_audit(new.org_id, 'doc.proposal.applied', 'approval', new.id::text, jsonb_build_object('path', pth, 'channel_id', ch, 'crew_id', new.crew_id));
  return new;
end $$;
drop trigger if exists msgr_apply_org_doc on public.msgr_crew_approvals;
create trigger msgr_apply_org_doc after update on public.msgr_crew_approvals for each row execute function public.msgr_apply_org_doc();

-- ── F2 조직 운영(부록 F): ① 본인 표시명 편집(역할·제거 표시는 못 바꿈) ② 오프보딩 자동 사슬(멤버 제거 → 그 사람의 크루 detach, 비공개 채널·DM 멤버십 제거, 크루의 채널 멤버십 제거) ③ 초대 만료·취소는 기존 정책.
drop policy if exists msgr_members_update_self on public.msgr_org_members;
create policy msgr_members_update_self on public.msgr_org_members for update to authenticated
  using (user_id = (select auth.uid()) and removed_at is null) with check (user_id = (select auth.uid()) and removed_at is null);
create or replace function public.msgr_member_self_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 본인 갱신(관리자 아님)은 표시명만 — 역할·제거 표시·소속은 관리자 정책으로만. NULL 주의: is_admin은 서비스 문맥에서 NULL.
  if auth.uid() = old.user_id and not coalesce(public.msgr_is_admin(old.org_id), false)
     and (new.role <> old.role or new.removed_at is distinct from old.removed_at) then
    raise exception 'msgr_member_self_only_name';
  end if;
  return new;
end $$;
drop trigger if exists msgr_member_self_guard on public.msgr_org_members;
create trigger msgr_member_self_guard before update on public.msgr_org_members for each row execute function public.msgr_member_self_guard();
create or replace function public.msgr_member_offboard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    update public.msgr_crews set status = 'detached' where org_id = new.org_id and owner_user_id = new.user_id and status = 'active';
    delete from public.msgr_channel_members cm using public.msgr_channels c
     where cm.channel_id = c.id and c.org_id = new.org_id
       and ((cm.member_kind = 'user' and cm.member_id = new.user_id)
         or (cm.member_kind = 'crew' and cm.member_id in (select id from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id)));
    perform public.msgr_audit(new.org_id, 'member.offboard', 'user', new.user_id::text, jsonb_build_object('crews_detached', (select count(*) from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached')));
  elsif new.removed_at is null and old.removed_at is not null then
    update public.msgr_crews set status = 'active' where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached'; -- 되살림 = 파견 복구(채널 멤버십은 다시 넣어야 한다)
  end if;
  return new;
end $$;
drop trigger if exists msgr_member_offboard on public.msgr_org_members;
create trigger msgr_member_offboard after update on public.msgr_org_members for each row execute function public.msgr_member_offboard();

-- ── J-1 역할 정식화(부록 I 권한 행렬): ① 채널 관리자(admin_user_ids) — 조직 정책 안에서 자기 채널만 관리(설정·멤버·문서 범위) ② 지정 결재권자(approver_user_ids) — 고위험 결재를 관리자 대신/함께 확정.
alter table public.msgr_channels add column if not exists admin_user_ids uuid[] not null default '{}';
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids) or (c.kind <> 'dm' and coalesce(public.msgr_is_admin(c.org_id), false)))
                     and coalesce(public.msgr_is_member(c.org_id), false))
$$;
revoke all on function public.msgr_can_manage_channel(uuid) from public;
revoke execute on function public.msgr_can_manage_channel(uuid) from anon;
grant execute on function public.msgr_can_manage_channel(uuid) to authenticated;
drop policy if exists msgr_channels_update on public.msgr_channels;
create policy msgr_channels_update on public.msgr_channels for update to authenticated
  using (public.msgr_can_manage_channel(id)) with check (public.msgr_can_manage_channel(id));
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (public.msgr_can_manage_channel(channel_id));
drop policy if exists msgr_channel_members_update on public.msgr_channel_members;
create policy msgr_channel_members_update on public.msgr_channel_members for update to authenticated
  using (public.msgr_can_manage_channel(channel_id)) with check (public.msgr_can_manage_channel(channel_id));
drop policy if exists msgr_channel_members_delete on public.msgr_channel_members;
create policy msgr_channel_members_delete on public.msgr_channel_members for delete to authenticated
  using ((member_kind = 'user' and member_id = (select auth.uid())) or public.msgr_can_manage_channel(channel_id));
-- 채널 관리자 지정은 조직 관리자 또는 생성자만(관리자가 관리자를 늘리는 자기 증식 방지) — 다른 컬럼 갱신은 관리자면 됨
create or replace function public.msgr_channel_admins_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.admin_user_ids is distinct from old.admin_user_ids then
    if auth.uid() is not null and not (old.created_by = auth.uid() or coalesce(public.msgr_is_admin(old.org_id), false)) then raise exception 'msgr_channel_admins_owner_only'; end if;
    if exists (select 1 from unnest(new.admin_user_ids) u where not exists (select 1 from public.msgr_org_members m where m.org_id = old.org_id and m.user_id = u and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))) then raise exception 'msgr_channel_admin_not_member'; end if;
    -- 비공개 채널의 관리자는 그 채널 멤버 중에서(멤버가 아니면 RLS 열람이 막혀 설정을 못 바꾼다 — 드릴 실측)
    if old.kind = 'private' and exists (select 1 from unnest(new.admin_user_ids) u where not exists (select 1 from public.msgr_channel_members cm where cm.channel_id = old.id and cm.member_kind = 'user' and cm.member_id = u)) then raise exception 'msgr_channel_admin_not_channel_member'; end if;
    perform public.msgr_audit(old.org_id, 'channel.admins', 'channel', old.id::text, jsonb_build_object('admins', new.admin_user_ids));
  end if;
  return new;
end $$;
drop trigger if exists msgr_channel_admins_guard on public.msgr_channels;
create trigger msgr_channel_admins_guard before update on public.msgr_channels for each row execute function public.msgr_channel_admins_guard();
-- 지정 결재권자
alter table public.msgr_org_policies add column if not exists approver_user_ids uuid[] not null default '{}';
alter table public.msgr_org_policies drop constraint if exists msgr_org_policies_approval_high_by_check;
alter table public.msgr_org_policies add constraint msgr_org_policies_approval_high_by_check check (approval_high_by in ('owner', 'admin', 'approvers'));
create or replace function public.msgr_can_decide(ap uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when a.risk = 'low' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'owner' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'approvers' then coalesce(public.msgr_is_admin(a.org_id), false) or auth.uid() = any (coalesce(p.approver_user_ids, '{}'::uuid[]))
      else public.msgr_is_admin(a.org_id)
    end
      from public.msgr_crew_approvals a
      join public.msgr_crews c on c.id = a.crew_id
      left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap
$$;

-- ── I-4 상주 노드 부트스트랩(부록 I·F3-1): 관리자가 "노드용 초대"(for_node)를 만들고 노드가 그 코드로 수락하면 그 계정이
--    곧 조직의 서비스 계정(service_user_id)이 된다 — 별도 지정 단계 없이 한 번에(지정 감사는 msgr_org_before_update가 남긴다).
--    노드는 자기 조직에만 하트비트(node_seen_at)를 찍을 수 있고(서비스 계정 본인만), 앱은 90초 초과를 "응답 없음"으로 그린다.
alter table public.msgr_invites add column if not exists for_node boolean not null default false;
alter table public.msgr_invites drop constraint if exists msgr_invites_node_role;
alter table public.msgr_invites add constraint msgr_invites_node_role check (not for_node or role = 'member'); -- 노드는 member로만(관리 권한 없음)
alter table public.msgr_orgs add column if not exists node_seen_at timestamptz;

create or replace function public.msgr_accept_invite(code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites i where i.code = msgr_accept_invite.code and i.accepted_at is null and i.expires_at > now() for update;
  if inv.id is null then raise exception 'msgr_invite_invalid'; end if;
  -- 노드용 코드를 소유자·관리자 계정이 수락하면 그 계정이 member로 강등되고 관리 계정이 노드가 된다 — 멤버십을 건드리기 전에 막는다(코드는 그대로 남는다)
  if inv.for_node and exists (select 1 from public.msgr_org_members where org_id = inv.org_id and user_id = auth.uid() and removed_at is null and role in ('owner', 'admin')) then
    raise exception 'msgr_node_not_admin';
  end if;
  insert into public.msgr_org_members (org_id, user_id, role, display_name)
    values (inv.org_id, auth.uid(), inv.role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()))
    on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, joined_at = now(),
      display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  update public.msgr_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  perform public.msgr_audit(inv.org_id, 'invite.accept', 'invite', inv.id::text);
  if inv.for_node then
    update public.msgr_orgs set service_user_id = auth.uid(), node_seen_at = now() where id = inv.org_id;
  end if;
  return inv.org_id;
end $$;

create or replace function public.msgr_node_heartbeat(org uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  update public.msgr_orgs set node_seen_at = now() where id = org and service_user_id = auth.uid() and deleted_at is null;
  return found;
end $$;
revoke all on function public.msgr_node_heartbeat(uuid) from public;
revoke execute on function public.msgr_node_heartbeat(uuid) from anon;
grant execute on function public.msgr_node_heartbeat(uuid) to authenticated;

-- ── I-5 채널·조직에서 회사 크루 만들기(부록 I "봇의 정문"): 요청 행(msgr_crew_requests)을 DB에 두면 회사 노드가 집어 카드를 쓰고
--    msgr_crews에 등록한다(결재와 같은 큐 패턴 — 노드에 인바운드 포트 0). 누가 만들 수 있나는 정책 crew_create(권한 행렬: 조직 전체
--    범위는 조직 관리자만, 채널 범위는 channel_admin=채널 관리자·member=멤버 전원). 노드가 없으면 서버가 거절한다(안 될 버튼의 서버 쪽).
alter table public.msgr_org_policies add column if not exists crew_create text not null default 'channel_admin' check (crew_create in ('admin', 'channel_admin', 'member'));
create table if not exists public.msgr_crew_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  channel_id uuid references public.msgr_channels (id) on delete set null,   -- null = 조직 전체 범위(어느 채널에도 자동으로 넣지 않음)
  name text not null check (length(name) between 1 and 40),
  role_text text not null default '' check (length(role_text) <= 60),
  prompt text not null check (length(prompt) between 1 and 2000),
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error text,
  crew_id uuid references public.msgr_crews (id) on delete set null,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
alter table public.msgr_crew_requests enable row level security;
grant select, insert, update, delete on public.msgr_crew_requests to authenticated;
grant all on public.msgr_crew_requests to service_role;

create or replace function public.msgr_can_create_crew(org uuid, ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when public.msgr_is_admin(org) then true
    when ch is null then false                                                                           -- 조직 전체 범위는 조직 관리자만
    when coalesce((select p.crew_create from public.msgr_org_policies p where p.org_id = org), 'channel_admin') = 'member'
      then public.msgr_role(org) in ('owner', 'admin', 'member')
    when coalesce((select p.crew_create from public.msgr_org_policies p where p.org_id = org), 'channel_admin') = 'channel_admin'
      then public.msgr_can_manage_channel(ch)
    else false end
$$;
revoke all on function public.msgr_can_create_crew(uuid, uuid) from public;
revoke execute on function public.msgr_can_create_crew(uuid, uuid) from anon;
grant execute on function public.msgr_can_create_crew(uuid, uuid) to authenticated;

drop policy if exists msgr_crew_requests_select on public.msgr_crew_requests;
create policy msgr_crew_requests_select on public.msgr_crew_requests for select to authenticated using (public.msgr_is_member(org_id));
drop policy if exists msgr_crew_requests_insert on public.msgr_crew_requests;
create policy msgr_crew_requests_insert on public.msgr_crew_requests for insert to authenticated
  with check (created_by = (select auth.uid()) and status = 'pending' and crew_id is null
    and (channel_id is null or exists (select 1 from public.msgr_channels c where c.id = channel_id and c.org_id = msgr_crew_requests.org_id and c.kind <> 'dm' and c.archived_at is null))
    and (select o.service_user_id from public.msgr_orgs o where o.id = org_id) is not null
    and public.msgr_can_create_crew(org_id, channel_id));
drop policy if exists msgr_crew_requests_update_node on public.msgr_crew_requests;
create policy msgr_crew_requests_update_node on public.msgr_crew_requests for update to authenticated
  using ((select o.service_user_id from public.msgr_orgs o where o.id = org_id) = (select auth.uid()))   -- 상태 갱신은 회사 노드(서비스 계정)만
  with check (status in ('done', 'failed'));
drop policy if exists msgr_crew_requests_delete on public.msgr_crew_requests;
create policy msgr_crew_requests_delete on public.msgr_crew_requests for delete to authenticated
  using (status = 'pending' and (created_by = (select auth.uid()) or public.msgr_is_admin(org_id)));

-- done → 채널 범위면 크루(+서비스 계정, 비공개 채널의 답글 쓰기 권한)를 채널에 넣고 감사. done_at 각인. crew_id 없는 done은 거절.
create or replace function public.msgr_crew_request_done() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare svc uuid;
begin
  if new.status = 'done' and old.status <> 'done' then
    if new.crew_id is null then raise exception 'msgr_crew_request_no_crew'; end if;
    new.done_at := now();
    if new.channel_id is not null then
      select o.service_user_id into svc from public.msgr_orgs o where o.id = new.org_id;
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (new.channel_id, 'crew', new.crew_id, new.created_by) on conflict do nothing;
      if svc is not null then
        insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (new.channel_id, 'user', svc, new.created_by) on conflict do nothing;
      end if;
    end if;
    perform public.msgr_audit(new.org_id, 'crew.create', 'crew', new.crew_id::text, jsonb_build_object('name', new.name, 'channel', new.channel_id, 'by', new.created_by));
  elsif new.status = 'failed' and old.status <> 'failed' then
    new.done_at := now();
  end if;
  return new;
end $$;
drop trigger if exists msgr_crew_request_done on public.msgr_crew_requests;
create trigger msgr_crew_request_done before update on public.msgr_crew_requests for each row execute function public.msgr_crew_request_done();

-- 방송: 노드는 이 신호로 즉시 깨어나고(정본은 pending 조회), 앱은 완료를 안다. 본문 없음.
create or replace function public.msgr_crew_request_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'status', new.status, 'crew_id', new.crew_id), 'crew_request', 'org:' || new.org_id::text, true);
  return new;
end $$;
drop trigger if exists msgr_crew_request_broadcast on public.msgr_crew_requests;
create trigger msgr_crew_request_broadcast after insert or update on public.msgr_crew_requests for each row execute function public.msgr_crew_request_broadcast();

-- ── I-5b 회사 크루 기본 러너·모델(정책 항목 — 부록 H "러너·모델"의 첫 조각): 노드가 만드는 카드의 frontmatter에 적힌다.
--    비우면 노드 회사의 기본 러너(company.json.defaultRunner)와 그 러너의 기본 모델. 실측: 기본 모델이 유료라 첫 멘션이 402로 실패 — 정책이 정해야 한다.
alter table public.msgr_org_policies add column if not exists crew_runner text check (crew_runner is null or crew_runner ~ '^[a-z0-9_-]{1,32}$');
alter table public.msgr_org_policies add column if not exists crew_model text check (crew_model is null or length(crew_model) between 1 and 120);

-- ── J-2 소유권 이전(제안→수락)·승계 관리자·결제 문제 읽기 전용(부록 I "조직의 소유·공유 조건"):
--    소유자는 관리자 한 명에게 **제안**(pending_owner_user_id)만 할 수 있고, 상대가 수락(owner_user_id를 자기로 갱신)해야 확정된다.
--    직접 이전(제안 없이 owner_user_id 변경)은 사용자 문맥에서 거절(msgr_transfer_needs_accept). 승계 관리자(successor_user_id)는 소유자가 지정하는 관리자.
--    결제 문제(ls_status past_due·unpaid)는 조직을 읽기 전용으로 — 메시지·크루 답글·크루 생성 요청이 서버에서 막힌다(삭제하지 않는다).
alter table public.msgr_orgs add column if not exists pending_owner_user_id uuid references auth.users (id) on delete set null;
alter table public.msgr_orgs add column if not exists successor_user_id uuid references auth.users (id) on delete set null;

create or replace function public.msgr_org_before_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); my_role text;
begin
  my_role := case when me is null then null else public.msgr_role(old.id) end;
  if me is not null and new.deleted_at is distinct from old.deleted_at and my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
  -- 소유권: 사용자 문맥에서는 "제안받은 사람이 자기로 수락"만 허용. 소유자라도 직접 이전은 거절(수락 없는 이전 금지).
  if new.owner_user_id is distinct from old.owner_user_id then
    if me is not null then
      if not (new.owner_user_id = me and coalesce(old.pending_owner_user_id = me, false)) then -- NULL 함정: 제안이 없으면 (= me)가 NULL이라 not NULL도 NULL → 통과해 버린다(드릴 실측)
        if my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
        raise exception 'msgr_transfer_needs_accept';
      end if;
    end if;
    if not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.owner_user_id and removed_at is null) then
      raise exception 'msgr_owner_not_member';
    end if;
    update public.msgr_org_members set role = 'admin' where org_id = old.id and user_id = old.owner_user_id;
    update public.msgr_org_members set role = 'owner' where org_id = old.id and user_id = new.owner_user_id;
    new.pending_owner_user_id := null;
    if new.successor_user_id = new.owner_user_id then new.successor_user_id := null; end if;
    perform public.msgr_audit(old.id, 'org.transfer', 'user', new.owner_user_id::text, jsonb_build_object('from', old.owner_user_id));
  end if;
  -- 이전 제안: 소유자만 제안·취소, 제안받은 사람은 거절(null)만. 대상은 활성 관리자.
  if new.pending_owner_user_id is distinct from old.pending_owner_user_id and new.owner_user_id = old.owner_user_id then
    if me is not null and my_role is distinct from 'owner' and not (new.pending_owner_user_id is null and coalesce(old.pending_owner_user_id = me, false)) then raise exception 'msgr_owner_only'; end if;
    if new.pending_owner_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.pending_owner_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_transfer_not_admin';
    end if;
    perform public.msgr_audit(old.id, case when new.pending_owner_user_id is null then (case when coalesce(me = old.pending_owner_user_id, false) then 'org.transfer.decline' else 'org.transfer.cancel' end) else 'org.transfer.offer' end,
                              'user', coalesce(new.pending_owner_user_id, old.pending_owner_user_id)::text);
  end if;
  -- 승계 관리자: 소유자만, 활성 관리자만.
  if new.successor_user_id is distinct from old.successor_user_id and new.owner_user_id = old.owner_user_id then
    if me is not null and my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
    if new.successor_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.successor_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_successor_not_admin';
    end if;
    perform public.msgr_audit(old.id, 'org.successor', 'user', coalesce(new.successor_user_id, old.successor_user_id)::text, jsonb_build_object('set', new.successor_user_id is not null));
  end if;
  if new.service_user_id is distinct from old.service_user_id then
    if new.service_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.service_user_id and removed_at is null) then
      raise exception 'msgr_service_not_member';
    end if;
    perform public.msgr_audit(old.id, 'org.service_account', 'org', old.id::text, jsonb_build_object('from', old.service_user_id, 'to', new.service_user_id));
  end if;
  return new;
end $$;

create or replace function public.msgr_org_locked(org uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce((select e.ls_status in ('past_due', 'unpaid') from public.msgr_org_entitlements e where e.org_id = org), false)
$$;
revoke all on function public.msgr_org_locked(uuid) from public;
revoke execute on function public.msgr_org_locked(uuid) from anon;
grant execute on function public.msgr_org_locked(uuid) to authenticated;

create or replace function public.msgr_can_write_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_can_read_channel(ch)
       and exists (select 1 from public.msgr_channels c where c.id = ch and c.archived_at is null and not public.msgr_org_locked(c.org_id))
$$;
drop policy if exists msgr_crew_requests_insert on public.msgr_crew_requests;
create policy msgr_crew_requests_insert on public.msgr_crew_requests for insert to authenticated
  with check (created_by = (select auth.uid()) and status = 'pending' and crew_id is null
    and (channel_id is null or exists (select 1 from public.msgr_channels c where c.id = channel_id and c.org_id = msgr_crew_requests.org_id and c.kind <> 'dm' and c.archived_at is null))
    and (select o.service_user_id from public.msgr_orgs o where o.id = org_id) is not null
    and not public.msgr_org_locked(org_id)
    and public.msgr_can_create_crew(org_id, channel_id));

-- ── J-3 도메인 자동 가입(부록 I "가입(공유) 경로 ③"): 소유자가 회사 이메일 도메인을 등록하면 같은 도메인 계정은 스스로 멤버로 들어온다.
--    인증 = 소유자 본인의 로그인 이메일이 그 도메인이어야 한다(그 메일함의 주인이 곧 소유자 — DNS TXT 인증은 후속). 공개 메일 도메인은 거절.
--    가입은 RPC로만(초대 수락과 같은 경로: 멤버 insert → 좌석 게이트 → 감사 member.join.domain). 목록은 "내 도메인과 같은 조직 중 아직 안 들어간 곳"만.
alter table public.msgr_orgs add column if not exists auto_join_domain text check (auto_join_domain is null or auto_join_domain ~ '^[a-z0-9][a-z0-9.-]{0,251}\.[a-z]{2,}$');
alter table public.msgr_orgs add column if not exists auto_join_role text not null default 'member' check (auto_join_role in ('member', 'guest'));

create or replace function public.msgr_public_email_domain(d text) returns boolean
  language sql immutable as $$
    select lower(d) = any (array['gmail.com','googlemail.com','naver.com','daum.net','hanmail.net','kakao.com','nate.com','outlook.com','hotmail.com','live.com','yahoo.com','icloud.com','me.com','proton.me','protonmail.com'])
$$;

create or replace function public.msgr_email_domain(u uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select lower(split_part(email, '@', 2)) from auth.users where id = u
$$;
revoke all on function public.msgr_email_domain(uuid) from public; -- 오라클 방지: 트리거·RPC 내부에서만

-- 도메인 등록 가드: 소유자만, 소유자 이메일 도메인과 같아야, 공개 도메인 금지, 감사.
create or replace function public.msgr_org_domain_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.auto_join_domain is distinct from old.auto_join_domain or new.auto_join_role is distinct from old.auto_join_role then
    if auth.uid() is not null and public.msgr_role(old.id) is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
    if new.auto_join_domain is not null then
      new.auto_join_domain := lower(new.auto_join_domain);
      if public.msgr_public_email_domain(new.auto_join_domain) then raise exception 'msgr_domain_public'; end if;
      if auth.uid() is not null and public.msgr_email_domain(auth.uid()) is distinct from new.auto_join_domain then raise exception 'msgr_domain_not_owners'; end if;
    end if;
    perform public.msgr_audit(old.id, 'org.domain', 'org', old.id::text, jsonb_build_object('domain', new.auto_join_domain, 'role', new.auto_join_role));
  end if;
  return new;
end $$;
drop trigger if exists msgr_org_domain_guard on public.msgr_orgs;
create trigger msgr_org_domain_guard before update on public.msgr_orgs for each row execute function public.msgr_org_domain_guard();

-- 내가 들어갈 수 있는 조직(도메인 일치 · 미가입 · 살아 있음). 이름·슬러그·역할만 노출.
create or replace function public.msgr_joinable_orgs() returns table (id uuid, name text, slug text, role text)
  language sql stable security definer set search_path = public, pg_temp as $$
    select o.id, o.name, o.slug, o.auto_join_role
      from public.msgr_orgs o
     where auth.uid() is not null and o.deleted_at is null and o.auto_join_domain is not null
       and o.auto_join_domain = public.msgr_email_domain(auth.uid())
       and not exists (select 1 from public.msgr_org_members m where m.org_id = o.id and m.user_id = auth.uid() and m.removed_at is null)
$$;
create or replace function public.msgr_join_by_domain(org uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.msgr_orgs%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into o from public.msgr_orgs where id = org and deleted_at is null;
  if o.id is null or o.auto_join_domain is null or o.auto_join_domain is distinct from public.msgr_email_domain(auth.uid()) then raise exception 'msgr_domain_mismatch'; end if;
  insert into public.msgr_org_members (org_id, user_id, role, display_name)
    values (o.id, auth.uid(), o.auto_join_role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()))
    on conflict (org_id, user_id) do update set removed_at = null, joined_at = now(), role = excluded.role,
      display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  perform public.msgr_audit(o.id, 'member.join.domain', 'user', auth.uid()::text, jsonb_build_object('domain', o.auto_join_domain));
  return o.id;
end $$;
do $$ declare f text; begin
  foreach f in array array['msgr_joinable_orgs()', 'msgr_join_by_domain(uuid)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ── J-4 게스트(부록 I "가입(공유) 경로 ④"): 채널 한정·기간 한정. 채널 관리자가 비공개 채널의 게스트 초대 링크를 만들고, 수락한 사람은
--    그 채널에만 들어오며(공개 채널은 원래 게스트에게 안 보임) expires_at이 지나면 멤버십 판정(msgr_role)이 곧바로 null이 된다(전 RLS 동시 차단).
--    좌석: 기본으로 게스트는 좌석을 차지하지 않는다(정책 guest_seats로 차지하게 가능).
alter table public.msgr_org_members add column if not exists expires_at timestamptz;
alter table public.msgr_invites add column if not exists channel_id uuid references public.msgr_channels (id) on delete cascade;
alter table public.msgr_invites add column if not exists guest_days int not null default 30 check (guest_days between 1 and 365);
alter table public.msgr_invites drop constraint if exists msgr_invites_channel_guest;
alter table public.msgr_invites add constraint msgr_invites_channel_guest check (channel_id is null or role = 'guest'); -- 채널 한정 초대 = 게스트
alter table public.msgr_org_policies add column if not exists guest_seats boolean not null default false;

create or replace function public.msgr_role(org uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select m.role from public.msgr_org_members m
      join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
     where m.org_id = org and m.user_id = auth.uid() and m.removed_at is null
       and (m.expires_at is null or m.expires_at > now())
$$;

-- 좌석 게이트: 게스트는 정책이 켜져 있을 때만 좌석을 센다.
create or replace function public.msgr_member_seat_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare lim int; n int; gseats boolean;
begin
  if new.removed_at is not null then return new; end if;
  if tg_op = 'UPDATE' and old.removed_at is null then return new; end if; -- 활성→활성(역할 변경)은 좌석 불변
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

-- 초대 정책: 채널 게스트 초대는 그 채널의 관리자도 만들고·보고·취소한다(비공개 채널만 — 공개 채널은 게스트가 못 본다).
drop policy if exists msgr_invites_select on public.msgr_invites;
create policy msgr_invites_select on public.msgr_invites for select to authenticated
  using (public.msgr_is_admin(org_id) or (channel_id is not null and public.msgr_can_manage_channel(channel_id)));
drop policy if exists msgr_invites_insert on public.msgr_invites;
create policy msgr_invites_insert on public.msgr_invites for insert to authenticated
  with check (created_by = (select auth.uid()) and accepted_at is null
    and ((channel_id is null and public.msgr_is_admin(org_id))
      or (channel_id is not null and role = 'guest' and public.msgr_can_manage_channel(channel_id)
          and exists (select 1 from public.msgr_channels c where c.id = channel_id and c.org_id = msgr_invites.org_id and c.kind = 'private' and c.archived_at is null))));
drop policy if exists msgr_invites_delete on public.msgr_invites;
create policy msgr_invites_delete on public.msgr_invites for delete to authenticated
  using (public.msgr_is_admin(org_id) or (channel_id is not null and public.msgr_can_manage_channel(channel_id)));

create or replace function public.msgr_accept_invite(code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites i where i.code = msgr_accept_invite.code and i.accepted_at is null and i.expires_at > now() for update;
  if inv.id is null then raise exception 'msgr_invite_invalid'; end if;
  if inv.for_node and exists (select 1 from public.msgr_org_members where org_id = inv.org_id and user_id = auth.uid() and removed_at is null and role in ('owner', 'admin')) then
    raise exception 'msgr_node_not_admin';
  end if;
  -- 이미 정식 멤버인 사람이 게스트 링크를 열면 강등하지 않는다(채널에만 넣는다)
  if inv.role = 'guest' and exists (select 1 from public.msgr_org_members where org_id = inv.org_id and user_id = auth.uid() and removed_at is null and role <> 'guest' and (expires_at is null or expires_at > now())) then
    null;
  else
    insert into public.msgr_org_members (org_id, user_id, role, display_name, expires_at)
      values (inv.org_id, auth.uid(), inv.role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()),
              case when inv.role = 'guest' then now() + make_interval(days => inv.guest_days) else null end)
      on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, joined_at = now(), expires_at = excluded.expires_at,
        display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  end if;
  if inv.channel_id is not null then
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (inv.channel_id, 'user', auth.uid(), inv.created_by) on conflict do nothing;
  end if;
  update public.msgr_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  perform public.msgr_audit(inv.org_id, 'invite.accept', 'invite', inv.id::text, jsonb_build_object('role', inv.role, 'channel', inv.channel_id, 'guest_days', case when inv.role = 'guest' then inv.guest_days else null end));
  if inv.for_node then
    update public.msgr_orgs set service_user_id = auth.uid(), node_seen_at = now() where id = inv.org_id;
  end if;
  return inv.org_id;
end $$;

-- ── J-5 조직 삭제 유예·복구(부록 I "조직 삭제"): 소유자만 삭제 표시(deleted_at) → 그 순간 멤버십 판정(msgr_role)이 전원 null(전 RLS 차단, 브리지도 크루 0).
--    30일 안에는 소유자가 복구(msgr_restore_org — 삭제된 조직은 role이 null이라 일반 UPDATE 정책을 못 지나므로 RPC), 지나면 msgr_purge_orgs()가 영구 삭제
--    (service_role 전용 — 운영 잡이 하루 1회 부른다; pg_cron·엣지 펑션 배선은 후속). 삭제 표시·복구는 감사.
create or replace function public.msgr_org_before_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); my_role text;
begin
  my_role := case when me is null then null else public.msgr_role(old.id) end;
  -- 삭제 표시·복구는 소유자 계정 기준(삭제된 조직은 msgr_role이 null이라 역할로는 판정 불가)
  if me is not null and new.deleted_at is distinct from old.deleted_at and old.owner_user_id <> me then raise exception 'msgr_owner_only'; end if;
  if new.deleted_at is distinct from old.deleted_at then
    perform public.msgr_audit(old.id, case when new.deleted_at is null then 'org.restore' else 'org.delete' end, 'org', old.id::text, jsonb_build_object('at', coalesce(new.deleted_at, old.deleted_at)));
    if new.deleted_at is not null then new.pending_owner_user_id := null; end if;
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    if me is not null then
      if not (new.owner_user_id = me and coalesce(old.pending_owner_user_id = me, false)) then
        if my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
        raise exception 'msgr_transfer_needs_accept';
      end if;
    end if;
    if not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.owner_user_id and removed_at is null) then
      raise exception 'msgr_owner_not_member';
    end if;
    update public.msgr_org_members set role = 'admin' where org_id = old.id and user_id = old.owner_user_id;
    update public.msgr_org_members set role = 'owner' where org_id = old.id and user_id = new.owner_user_id;
    new.pending_owner_user_id := null;
    if new.successor_user_id = new.owner_user_id then new.successor_user_id := null; end if;
    perform public.msgr_audit(old.id, 'org.transfer', 'user', new.owner_user_id::text, jsonb_build_object('from', old.owner_user_id));
  end if;
  if new.pending_owner_user_id is distinct from old.pending_owner_user_id and new.owner_user_id = old.owner_user_id and new.deleted_at is not distinct from old.deleted_at then
    if me is not null and my_role is distinct from 'owner' and not (new.pending_owner_user_id is null and coalesce(old.pending_owner_user_id = me, false)) then raise exception 'msgr_owner_only'; end if;
    if new.pending_owner_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.pending_owner_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_transfer_not_admin';
    end if;
    perform public.msgr_audit(old.id, case when new.pending_owner_user_id is null then (case when coalesce(me = old.pending_owner_user_id, false) then 'org.transfer.decline' else 'org.transfer.cancel' end) else 'org.transfer.offer' end,
                              'user', coalesce(new.pending_owner_user_id, old.pending_owner_user_id)::text);
  end if;
  if new.successor_user_id is distinct from old.successor_user_id and new.owner_user_id = old.owner_user_id then
    if me is not null and my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
    if new.successor_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.successor_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_successor_not_admin';
    end if;
    perform public.msgr_audit(old.id, 'org.successor', 'user', coalesce(new.successor_user_id, old.successor_user_id)::text, jsonb_build_object('set', new.successor_user_id is not null));
  end if;
  if new.service_user_id is distinct from old.service_user_id then
    if new.service_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.service_user_id and removed_at is null) then
      raise exception 'msgr_service_not_member';
    end if;
    perform public.msgr_audit(old.id, 'org.service_account', 'org', old.id::text, jsonb_build_object('from', old.service_user_id, 'to', new.service_user_id));
  end if;
  return new;
end $$;

-- 삭제 표시는 소유자의 일반 UPDATE(정책 admin ✓ + 위 트리거). 복구는 RPC(삭제 뒤엔 정책을 못 지난다).
create or replace function public.msgr_restore_org(org uuid) returns boolean
  language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.msgr_orgs%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into o from public.msgr_orgs where id = org for update;
  if o.id is null or o.owner_user_id <> auth.uid() then raise exception 'msgr_owner_only'; end if;
  if o.deleted_at is null then return false; end if;
  if o.deleted_at < now() - interval '30 days' then raise exception 'msgr_restore_expired'; end if;
  update public.msgr_orgs set deleted_at = null where id = o.id; -- 트리거가 org.restore 감사
  return true;
end $$;
-- 내가 소유한 삭제 예정 조직(복구 화면용) — 삭제 뒤엔 멤버십이 없어 select 정책의 owner 분기만 남지만, 남은 날짜 계산까지 한 번에 준다.
create or replace function public.msgr_my_deleted_orgs() returns table (id uuid, name text, slug text, deleted_at timestamptz, purge_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select o.id, o.name, o.slug, o.deleted_at, o.deleted_at + interval '30 days'
      from public.msgr_orgs o where o.owner_user_id = auth.uid() and o.deleted_at is not null and o.deleted_at > now() - interval '30 days'
     order by o.deleted_at desc
$$;
-- 영구 삭제: 유예가 끝난 조직을 지운다(cascade). service_role 전용 — 운영 잡이 부른다. 지운 개수를 돌려준다.
create or replace function public.msgr_purge_orgs() returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int;
begin
  if auth.uid() is not null then raise exception 'msgr_service_only'; end if;
  with gone as (delete from public.msgr_orgs where deleted_at is not null and deleted_at < now() - interval '30 days' returning id)
  select count(*) into n from gone;
  return n;
end $$;
do $$ declare f text; begin
  foreach f in array array['msgr_restore_org(uuid)', 'msgr_my_deleted_orgs()'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.msgr_purge_orgs() from public;
revoke execute on function public.msgr_purge_orgs() from anon, authenticated;
grant execute on function public.msgr_purge_orgs() to service_role;

-- 감사 함수 가드(J-5 purge 실측): 조직 행이 cascade로 지워지는 문장 안에서 자식 행 트리거가 감사를 남기려 하면 FK가 깨진다 →
-- 조직이 이미 없으면 조용히 건너뛴다(영구 삭제는 기록 자체를 지우는 행위이므로 감사 대상이 아니다).
create or replace function public.msgr_audit(org uuid, act text, tkind text, tid text, m jsonb default '{}'::jsonb) returns void
  language sql security definer set search_path = public, pg_temp as $$
    insert into public.msgr_audit_log (org_id, actor_user_id, action, target_kind, target_id, meta)
    select org, auth.uid(), act, tkind, tid, coalesce(m, '{}'::jsonb)
     where exists (select 1 from public.msgr_orgs o where o.id = org)
$$;

-- 새 조직의 소유자 멤버 행에 표시명(이메일 앞부분)을 채운다 — 없으면 멤버 목록에 uid 앞자리가 보였다(J-5 실측). 초대 수락과 같은 규칙.
create or replace function public.msgr_org_after_insert() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.msgr_org_members (org_id, user_id, role, display_name)
    values (new.id, new.owner_user_id, 'owner', (select split_part(u.email, '@', 1) from auth.users u where u.id = new.owner_user_id));
  insert into public.msgr_org_entitlements (org_id) values (new.id) on conflict do nothing;
  insert into public.msgr_org_policies (org_id) values (new.id) on conflict do nothing;
  perform public.msgr_audit(new.id, 'org.create', 'org', new.id::text);
  return new;
end $$;

-- ── 분리 검수 반영(2026-09-04 보안 검수 — I-4~J-5): 쓰기 문에서 "대상이 이 조직 것인가"를 서버가 확인하지 않던 자리들.
-- CRITICAL-1: 크루 생성 요청 행의 소속 컬럼 잠금 + done 시 crew_id는 같은 조직·서비스 계정 소유 크루만, 확정 뒤 재변경 금지.
drop trigger if exists msgr_lock_crew_requests on public.msgr_crew_requests;
create trigger msgr_lock_crew_requests before update on public.msgr_crew_requests for each row execute function public.msgr_lock_cols('org_id', 'channel_id', 'name', 'role_text', 'prompt', 'created_by', 'created_at');
create or replace function public.msgr_crew_request_done() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare svc uuid;
begin
  if old.status <> 'pending' and (new.status is distinct from old.status or new.crew_id is distinct from old.crew_id) then raise exception 'msgr_crew_request_final'; end if;
  select o.service_user_id into svc from public.msgr_orgs o where o.id = new.org_id;
  if new.status = 'done' and old.status <> 'done' then
    if new.crew_id is null then raise exception 'msgr_crew_request_no_crew'; end if;
    if not exists (select 1 from public.msgr_crews c where c.id = new.crew_id and c.org_id = new.org_id and c.hosting = 'resident' and svc is not null and c.owner_user_id = svc) then
      raise exception 'msgr_crew_request_bad_crew'; -- 다른 조직·다른 소유자의 크루를 완료 표시로 채널에 밀어 넣던 경로(검수 프로브 재현)
    end if;
    new.done_at := now();
    if new.channel_id is not null then
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (new.channel_id, 'crew', new.crew_id, new.created_by) on conflict do nothing;
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (new.channel_id, 'user', svc, new.created_by) on conflict do nothing;
    end if;
    perform public.msgr_audit(new.org_id, 'crew.create', 'crew', new.crew_id::text, jsonb_build_object('name', new.name, 'channel', new.channel_id, 'by', new.created_by));
  elsif new.status = 'failed' and old.status <> 'failed' then
    new.done_at := now();
  end if;
  return new;
end $$;

-- HIGH-1: 채널 멤버 행의 대상이 그 채널 조직의 활성 멤버(user) / 그 조직의 크루(crew)여야 한다(다른 조직 크루 주입 경로 봉합).
create or replace function public.msgr_channel_member_ok(ch uuid, kind text, mid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case kind
      when 'user' then exists (select 1 from public.msgr_org_members m join public.msgr_channels c on c.id = ch
                                where m.org_id = c.org_id and m.user_id = mid and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))
      when 'crew' then exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch where cr.id = mid and cr.org_id = c.org_id)
      else false end
$$;
revoke all on function public.msgr_channel_member_ok(uuid, text, uuid) from public;
revoke execute on function public.msgr_channel_member_ok(uuid, text, uuid) from anon;
grant execute on function public.msgr_channel_member_ok(uuid, text, uuid) to authenticated;
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (public.msgr_can_manage_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id));
drop policy if exists msgr_channel_members_update on public.msgr_channel_members;
create policy msgr_channel_members_update on public.msgr_channel_members for update to authenticated
  using (public.msgr_can_manage_channel(channel_id)) with check (public.msgr_can_manage_channel(channel_id) and public.msgr_channel_member_ok(channel_id, member_kind, member_id));

-- MEDIUM-1: 채널 한정 게스트는 전사 문서(규칙집·용어집·프로젝트)를 읽지 않는다 — 초대받은 채널 범위 문서만.
drop policy if exists msgr_docs_select on public.msgr_org_docs;
create policy msgr_docs_select on public.msgr_org_docs for select to authenticated
  using ((channel_id is null and public.msgr_role(org_id) in ('owner', 'admin', 'member')) or (channel_id is not null and public.msgr_can_read_channel(channel_id)));

-- MEDIUM-2: 공개 메일 도메인 목록 확장(완전할 수는 없다 — 화면 안내가 보조).
create or replace function public.msgr_public_email_domain(d text) returns boolean
  language sql immutable as $$
    select lower(d) = any (array['gmail.com','googlemail.com','naver.com','daum.net','hanmail.net','kakao.com','nate.com','outlook.com','outlook.kr','hotmail.com','hotmail.co.kr','live.com','live.co.kr','msn.com',
      'yahoo.com','yahoo.co.kr','yahoo.co.jp','ymail.com','icloud.com','me.com','mac.com','proton.me','protonmail.com','pm.me','tutanota.com','tuta.io','zoho.com','zohomail.com','mail.com','gmx.com','gmx.de','gmx.net',
      'yandex.com','yandex.ru','qq.com','163.com','126.com','sina.com','aol.com','fastmail.com','hey.com','duck.com','mailinator.com','tempmail.com','guerrillamail.com','lycos.com','dreamwiz.com','empas.com','korea.com','chol.com','paran.com'])
$$;

-- LOW-1: 크루 등록의 hosting은 서버가 판정 — resident는 조직 서비스 계정 소유일 때만, 등록 뒤 hosting·org 불변.
drop policy if exists msgr_crews_insert on public.msgr_crews;
create policy msgr_crews_insert on public.msgr_crews for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and public.msgr_role(org_id) in ('owner', 'admin', 'member')
    and (hosting = 'local' or owner_user_id = (select o.service_user_id from public.msgr_orgs o where o.id = org_id)));
drop trigger if exists msgr_lock_crews on public.msgr_crews;
create trigger msgr_lock_crews before update on public.msgr_crews for each row execute function public.msgr_lock_cols('org_id', 'owner_user_id', 'ws_id', 'slug', 'registered_at', 'hosting');


-- ── 분리 검수 반영 2(2026-09-04 코드 검수 — I-4~J-5): 22건 중 서버 쪽. 정책·함수는 전부 재정의로 덧붙인다(로컬 스택 제자리 적용).
create or replace function public.msgr_org_before_update() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); my_role text;
begin
  my_role := case when me is null then null else public.msgr_role(old.id) end;
  -- 삭제 표시·복구는 소유자 계정 기준(삭제된 조직은 msgr_role이 null이라 역할로는 판정 불가)
  if me is not null and new.deleted_at is distinct from old.deleted_at and old.owner_user_id <> me then raise exception 'msgr_owner_only'; end if;
  if new.deleted_at is distinct from old.deleted_at then
    perform public.msgr_audit(old.id, case when new.deleted_at is null then 'org.restore' else 'org.delete' end, 'org', old.id::text, jsonb_build_object('at', coalesce(new.deleted_at, old.deleted_at)));
    if new.deleted_at is not null then new.pending_owner_user_id := null; end if;
  end if;
  if new.owner_user_id is distinct from old.owner_user_id then
    if me is not null then
      if not (new.owner_user_id = me and coalesce(old.pending_owner_user_id = me, false)) then
        if my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
        raise exception 'msgr_transfer_needs_accept';
      end if;
    end if;
    if not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.owner_user_id and removed_at is null) then
      raise exception 'msgr_owner_not_member';
    end if;
    update public.msgr_org_members set role = 'admin' where org_id = old.id and user_id = old.owner_user_id;
    update public.msgr_org_members set role = 'owner' where org_id = old.id and user_id = new.owner_user_id;
    new.pending_owner_user_id := null;
    if new.successor_user_id = new.owner_user_id then new.successor_user_id := null; end if;
    if new.auto_join_domain is not null and new.auto_join_domain is distinct from public.msgr_email_domain(new.owner_user_id) then new.auto_join_domain := null; end if; -- 검수 L-2: 새 소유자 도메인과 다르면 자동 가입 해제
    perform public.msgr_audit(old.id, 'org.transfer', 'user', new.owner_user_id::text, jsonb_build_object('from', old.owner_user_id));
  end if;
  if new.pending_owner_user_id is distinct from old.pending_owner_user_id and new.owner_user_id = old.owner_user_id and new.deleted_at is not distinct from old.deleted_at then
    if me is not null and my_role is distinct from 'owner' and not (new.pending_owner_user_id is null and coalesce(old.pending_owner_user_id = me, false)) then raise exception 'msgr_owner_only'; end if;
    if new.pending_owner_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.pending_owner_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_transfer_not_admin';
    end if;
    perform public.msgr_audit(old.id, case when new.pending_owner_user_id is null then (case when coalesce(me = old.pending_owner_user_id, false) then 'org.transfer.decline' else 'org.transfer.cancel' end) else 'org.transfer.offer' end,
                              'user', coalesce(new.pending_owner_user_id, old.pending_owner_user_id)::text);
  end if;
  if new.successor_user_id is distinct from old.successor_user_id and new.owner_user_id = old.owner_user_id then
    if me is not null and my_role is distinct from 'owner' then raise exception 'msgr_owner_only'; end if;
    if new.successor_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.successor_user_id and removed_at is null and role = 'admin') then
      raise exception 'msgr_successor_not_admin';
    end if;
    perform public.msgr_audit(old.id, 'org.successor', 'user', coalesce(new.successor_user_id, old.successor_user_id)::text, jsonb_build_object('set', new.successor_user_id is not null));
  end if;
  if new.service_user_id is distinct from old.service_user_id then
    -- 검수 H-6: 관리자가 자기를 서비스 계정으로 지정해 개인 크루를 회사 크루로 승격하던 경로 — 소유자 또는 노드 수락 RPC(세션 플래그)만
    if me is not null and my_role is distinct from 'owner' and coalesce(current_setting('msgr.node_accept', true), '') <> '1' then raise exception 'msgr_owner_only'; end if;
    if new.service_user_id is not null and not exists (select 1 from public.msgr_org_members where org_id = old.id and user_id = new.service_user_id and removed_at is null) then
      raise exception 'msgr_service_not_member';
    end if;
    perform public.msgr_audit(old.id, 'org.service_account', 'org', old.id::text, jsonb_build_object('from', old.service_user_id, 'to', new.service_user_id));
  end if;
  return new;
end $$;
create or replace function public.msgr_accept_invite(code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites i where i.code = msgr_accept_invite.code and i.accepted_at is null and i.expires_at > now() for update;
  if inv.id is null then raise exception 'msgr_invite_invalid'; end if;
  if inv.for_node and exists (select 1 from public.msgr_org_members where org_id = inv.org_id and user_id = auth.uid() and removed_at is null and role in ('owner', 'admin')) then
    raise exception 'msgr_node_not_admin';
  end if;
  -- 이미 정식 멤버인 사람이 게스트 링크를 열면 강등하지 않는다(채널에만 넣는다)
  if inv.role = 'guest' and exists (select 1 from public.msgr_org_members where org_id = inv.org_id and user_id = auth.uid() and removed_at is null and role <> 'guest' and (expires_at is null or expires_at > now())) then
    null;
  else
    insert into public.msgr_org_members (org_id, user_id, role, display_name, expires_at)
      values (inv.org_id, auth.uid(), inv.role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()),
              case when inv.role = 'guest' then now() + make_interval(days => inv.guest_days) else null end)
      on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, joined_at = now(), expires_at = excluded.expires_at,
        display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  end if;
  if inv.channel_id is not null then
    insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (inv.channel_id, 'user', auth.uid(), inv.created_by) on conflict do nothing;
  end if;
  update public.msgr_invites set accepted_by = auth.uid(), accepted_at = now() where id = inv.id;
  perform public.msgr_audit(inv.org_id, 'invite.accept', 'invite', inv.id::text, jsonb_build_object('role', inv.role, 'channel', inv.channel_id, 'guest_days', case when inv.role = 'guest' then inv.guest_days else null end));
  if inv.for_node then
    perform set_config('msgr.node_accept', '1', true); -- 트랜잭션 한정 플래그: 서비스 계정 지정은 소유자 또는 이 경로만(검수 H-6)
    update public.msgr_orgs set service_user_id = auth.uid(), node_seen_at = now() where id = inv.org_id;
    perform set_config('msgr.node_accept', '', true);
  end if;
  return inv.org_id;
end $$;
create or replace function public.msgr_member_self_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  -- 본인 갱신(관리자 아님)은 표시명만 — 역할·제거 표시·소속은 관리자 정책으로만. NULL 주의: is_admin은 서비스 문맥에서 NULL.
  if auth.uid() = old.user_id and not coalesce(public.msgr_is_admin(old.org_id), false)
     and (new.role <> old.role or new.removed_at is distinct from old.removed_at or new.expires_at is distinct from old.expires_at) then -- 검수 C-1: 게스트가 자기 만료를 지우던 경로
    raise exception 'msgr_member_self_only_name';
  end if;
  return new;
end $$;
-- H-1: 이메일 도메인 함수는 트리거·RPC 내부 전용 — anon·authenticated 실행 권한 회수(실측: anon이 임의 uid의 도메인을 읽었다)
revoke execute on function public.msgr_email_domain(uuid) from anon, authenticated;
-- H-2: 크루 요청 이름·역할에 개행 금지(카드 frontmatter 주입 — persona.createAgentCard도 세척)
alter table public.msgr_crew_requests drop constraint if exists msgr_crew_requests_no_newline;
alter table public.msgr_crew_requests add constraint msgr_crew_requests_no_newline check (name !~ '[\r\n]' and role_text !~ '[\r\n]');
-- H-4·M-7: 도메인 자동 가입은 "이 조직에 행이 없는 사람"만 — 제거된 사람(재초대로만)·이미 멤버(강등 방지) 거절
create or replace function public.msgr_joinable_orgs() returns table (id uuid, name text, slug text, role text)
  language sql stable security definer set search_path = public, pg_temp as $$
    select o.id, o.name, o.slug, o.auto_join_role
      from public.msgr_orgs o
     where auth.uid() is not null and o.deleted_at is null and o.auto_join_domain is not null
       and o.auto_join_domain = public.msgr_email_domain(auth.uid())
       and not exists (select 1 from public.msgr_org_members m where m.org_id = o.id and m.user_id = auth.uid())
$$;
create or replace function public.msgr_join_by_domain(org uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.msgr_orgs%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into o from public.msgr_orgs where id = org and deleted_at is null;
  if o.id is null or o.auto_join_domain is null or o.auto_join_domain is distinct from public.msgr_email_domain(auth.uid()) then raise exception 'msgr_domain_mismatch'; end if;
  if exists (select 1 from public.msgr_org_members where org_id = o.id and user_id = auth.uid() and removed_at is null) then raise exception 'msgr_already_member'; end if;
  if exists (select 1 from public.msgr_org_members where org_id = o.id and user_id = auth.uid()) then raise exception 'msgr_removed_rejoin'; end if; -- 퇴사자는 관리자 재초대로만
  insert into public.msgr_org_members (org_id, user_id, role, display_name)
    values (o.id, auth.uid(), o.auto_join_role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()));
  perform public.msgr_audit(o.id, 'member.join.domain', 'user', auth.uid()::text, jsonb_build_object('domain', o.auto_join_domain));
  return o.id;
end $$;
-- L-3: 게스트는 채널 한정·기간 한정으로만 생긴다 — 채널 없는 게스트 초대·도메인 가입 역할 guest 금지
alter table public.msgr_invites drop constraint if exists msgr_invites_guest_needs_channel;
alter table public.msgr_invites add constraint msgr_invites_guest_needs_channel check (role <> 'guest' or channel_id is not null);
alter table public.msgr_orgs drop constraint if exists msgr_orgs_auto_join_role_check;
update public.msgr_orgs set auto_join_role = 'member' where auto_join_role = 'guest';
alter table public.msgr_orgs add constraint msgr_orgs_auto_join_role_check check (auto_join_role = 'member');
-- H-5: 게스트(외부 파트너)는 조직 운영 정보(요금·정책·크루 생성 요청)를 읽지 않는다 — 초대받은 채널과 그 참여자만
drop policy if exists msgr_entitlements_select on public.msgr_org_entitlements;
create policy msgr_entitlements_select on public.msgr_org_entitlements for select to authenticated using (public.msgr_role(org_id) in ('owner', 'admin', 'member'));
drop policy if exists msgr_policies_select on public.msgr_org_policies;
create policy msgr_policies_select on public.msgr_org_policies for select to authenticated using (public.msgr_role(org_id) in ('owner', 'admin', 'member'));
drop policy if exists msgr_crew_requests_select on public.msgr_crew_requests;
create policy msgr_crew_requests_select on public.msgr_crew_requests for select to authenticated using (public.msgr_role(org_id) in ('owner', 'admin', 'member'));
-- M-1: 정책 member면 "자기가 쓸 수 있는 채널"에만(못 보는 비공개 채널에 크루 심기 차단)
create or replace function public.msgr_can_create_crew(org uuid, ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when public.msgr_is_admin(org) then true
    when ch is null then false
    when coalesce((select p.crew_create from public.msgr_org_policies p where p.org_id = org), 'channel_admin') = 'member'
      then public.msgr_role(org) in ('owner', 'admin', 'member') and public.msgr_can_write_channel(ch)
    when coalesce((select p.crew_create from public.msgr_org_policies p where p.org_id = org), 'channel_admin') = 'channel_admin'
      then public.msgr_can_manage_channel(ch)
    else false end
$$;
-- M-6: 결제 문제 읽기 전용을 쓰기 경로 전부에 — 채널 생성·크루 파견·초대·전사 문서 편집
create or replace function public.msgr_can_edit_doc(org uuid, ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select not public.msgr_org_locked(org) and case when ch is null then public.msgr_is_admin(org)
                else public.msgr_can_write_channel(ch) and exists (select 1 from public.msgr_channels c where c.id = ch and c.org_id = org) end
$$;
drop policy if exists msgr_channels_insert on public.msgr_channels;
create policy msgr_channels_insert on public.msgr_channels for insert to authenticated
  with check (created_by = (select auth.uid()) and public.msgr_role(org_id) in ('owner', 'admin', 'member') and not public.msgr_org_locked(org_id));
drop policy if exists msgr_crews_insert on public.msgr_crews;
create policy msgr_crews_insert on public.msgr_crews for insert to authenticated
  with check (owner_user_id = (select auth.uid()) and public.msgr_role(org_id) in ('owner', 'admin', 'member') and not public.msgr_org_locked(org_id)
    and (hosting = 'local' or owner_user_id = (select o.service_user_id from public.msgr_orgs o where o.id = org_id)));
drop policy if exists msgr_invites_insert on public.msgr_invites;
create policy msgr_invites_insert on public.msgr_invites for insert to authenticated
  with check (created_by = (select auth.uid()) and accepted_at is null and not public.msgr_org_locked(org_id)
    and ((channel_id is null and public.msgr_is_admin(org_id))
      or (channel_id is not null and role = 'guest' and public.msgr_can_manage_channel(channel_id)
          and exists (select 1 from public.msgr_channels c where c.id = channel_id and c.org_id = msgr_invites.org_id and c.kind = 'private' and c.archived_at is null))));
-- M-2: purge가 첨부 실파일도 지운다(Storage 스키마가 있는 환경에서만 — 로컬 드릴에는 없다)
create or replace function public.msgr_purge_orgs() returns int
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n int; ids uuid[];
begin
  if auth.uid() is not null then raise exception 'msgr_service_only'; end if;
  select array_agg(id) into ids from public.msgr_orgs where deleted_at is not null and deleted_at < now() - interval '30 days';
  if ids is null then return 0; end if;
  if to_regclass('storage.objects') is not null then
    execute 'delete from storage.objects where bucket_id = ''msgr'' and (storage.foldername(name))[1] = any ($1)' using (select array_agg(x::text) from unnest(ids) x);
  end if;
  delete from public.msgr_orgs where id = any (ids);
  get diagnostics n = row_count;
  return n;
end $$;
