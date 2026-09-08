-- P0 세 가지(2026-09-09 슬랙·텔레그램 대조 뒤 유건 지시 "UI 대폭 업그레이드"):
--   읽음 커서(채널별 안 읽음 배지·새 메시지 구분선) · 반응(이모지) · 채널 음소거 + 조용한 시간(알림 억제).
-- 편집·삭제는 기존 update 정책(작성자 본인)과 edited_at/deleted_at 열로 충분 — 스키마 변경 없음.

-- ── 읽음 커서 ─────────────────────────────────────────────────────────────
create table if not exists public.msgr_reads (
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  last_read_id bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
alter table public.msgr_reads enable row level security;
drop policy if exists msgr_reads_self on public.msgr_reads;
create policy msgr_reads_self on public.msgr_reads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.msgr_can_read_channel(channel_id));
grant select, insert, update on public.msgr_reads to authenticated;

-- 채널별 안 읽음 수(99 상한)·그중 나를 멘션한 수. 내 글·삭제 글은 세지 않는다. RLS 통과(security invoker).
-- ponytail: 채널×메시지 카운트 — (channel_id, id) 인덱스로 버티고, 채널당 수만 건이 넘으면 last_read 이후만 세는 부분 인덱스로.
create or replace function public.msgr_unread(org uuid)
returns table (channel_id uuid, n int, mention int)
language sql stable security invoker set search_path = public as $$
  select c.id,
         least(99, count(m.id))::int,
         least(99, count(m.id) filter (where m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', (select auth.uid())::text))))::int
  from public.msgr_channels c
  left join public.msgr_reads r on r.channel_id = c.id and r.user_id = (select auth.uid())
  join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
       and (m.author_user_id is null or m.author_user_id <> (select auth.uid()))
  where c.org_id = org and c.archived_at is null and public.msgr_can_read_channel(c.id)
  group by c.id
$$;
grant execute on function public.msgr_unread(uuid) to authenticated;

-- ── 반응 ─────────────────────────────────────────────────────────────────
create table if not exists public.msgr_reactions (
  message_id bigint not null references public.msgr_messages (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  emoji text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
alter table public.msgr_reactions enable row level security;
drop policy if exists msgr_reactions_select on public.msgr_reactions;
create policy msgr_reactions_select on public.msgr_reactions for select to authenticated
  using (exists (select 1 from public.msgr_messages m where m.id = message_id and public.msgr_can_read_channel(m.channel_id)));
drop policy if exists msgr_reactions_write on public.msgr_reactions;
create policy msgr_reactions_write on public.msgr_reactions for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.msgr_messages m where m.id = message_id and m.deleted_at is null and public.msgr_can_read_channel(m.channel_id)));
drop policy if exists msgr_reactions_delete on public.msgr_reactions;
create policy msgr_reactions_delete on public.msgr_reactions for delete to authenticated using (user_id = (select auth.uid()));
grant select, insert, delete on public.msgr_reactions to authenticated;

-- ── 채널 음소거 + 조용한 시간 ─────────────────────────────────────────────
create table if not exists public.msgr_channel_prefs (
  channel_id uuid not null references public.msgr_channels (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  muted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
alter table public.msgr_channel_prefs enable row level security;
drop policy if exists msgr_channel_prefs_self on public.msgr_channel_prefs;
create policy msgr_channel_prefs_self on public.msgr_channel_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update, delete on public.msgr_channel_prefs to authenticated;
-- 조용한 시간(사용자 단위, 시 단위 0~23, null = 끔). from>to면 자정을 넘는 구간(예: 22~7).
alter table public.msgr_profiles add column if not exists quiet_from smallint check (quiet_from is null or quiet_from between 0 and 23);
alter table public.msgr_profiles add column if not exists quiet_to smallint check (quiet_to is null or quiet_to between 0 and 23);
