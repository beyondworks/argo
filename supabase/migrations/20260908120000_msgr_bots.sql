-- 부록 N v3 N-1 — 외부 에이전트(헤르메스·오픈클로)가 아르고 메신저에 **봇**으로 접속한다(메신저 = 플랫폼, 텔레그램·슬랙과 같은 자리).
--  · 봇 = msgr_crews 행(hosting='bot', 회사 크루 등급 — 결재는 만든 관리자·결재권자, 민감 채널 허용) + msgr_bots 행(토큰 해시·책임자 created_by).
--    Supabase 계정도, service role도 없다: 봇 쪽 RPC(msgr_bot_me/updates/send)가 토큰을 검증하고 security definer로 같은 정책 게이트
--    (msgr_can_instruct·채널 정책·답글 게이트 트리거)를 태운다. 텔레그램 Bot API 모양(getMe/getUpdates/sendMessage)은 라우트(N-2)가 이 RPC를 번역한다.
--  · Buzz 대조(부록 N-벤치): 봇은 멤버처럼 채널에 넣는다(기존 msgr_channel_members member_kind='crew' 그대로) / 봇 신원은 사람이 못 받는 종류(hosting='bot',
--    RPC만 생성) / 가용성은 마지막 getUpdates(last_seen_at)만 / 종료·재시작 없음 — 폐기는 토큰 회수 / 책임자(created_by) 상시 표시.
--  · 좌석 미소모(조직 멤버가 아니다). 토큰 원문은 생성·회전 시 1회만 반환, 저장은 sha256.

-- 1) hosting에 'bot'
alter table public.msgr_crews drop constraint if exists msgr_crews_hosting_check;
alter table public.msgr_crews add constraint msgr_crews_hosting_check check (hosting in ('local', 'resident', 'bot'));

-- 2) 봇 크루는 RPC만 만든다 — 직접 insert/승격 차단(트랜잭션 플래그, msgr.node_accept 선례)
create or replace function public.msgr_crews_bot_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.hosting = 'bot' and coalesce(current_setting('msgr.bot_create', true), '') <> '1' then
    raise exception 'msgr_bot_rpc_only' using detail = 'bot crews are created by msgr_bot_create() only';
  end if;
  return new;
end $$;
drop trigger if exists msgr_crews_bot_guard on public.msgr_crews;
create trigger msgr_crews_bot_guard before insert or update of hosting on public.msgr_crews for each row execute function public.msgr_crews_bot_guard();

-- 3) 등급·지시 판정: 봇 = 회사 크루(회사 지급 기기 등급, 부록 K)
create or replace function public.msgr_crew_tier(crew uuid) returns text
  language sql stable security invoker set search_path = public, pg_temp as $$
    select case when c.hosting = 'bot' or (o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident') then 'company' else 'personal' end
      from public.msgr_crews c join public.msgr_orgs o on o.id = c.org_id where c.id = crew
$$;
create or replace function public.msgr_instruct_check(crew uuid, author uuid, channel uuid default null) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      when channel is not null and ch.personal_crews <> 'allowed'
           and not (c.hosting = 'bot' or (o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident')) then 'channel_policy'
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

-- 회사 등급 판정 소비자 4곳 중 나머지 둘(채널 멤버 게이트·정책 sweep)도 등급 함수로 모은다 — 봇을 blocked 채널에 넣을 수 있고, 정책 전환 sweep이 봇을 지우지 않는다.
create or replace function public.msgr_channel_personal_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.member_kind = 'crew' and exists (select 1 from public.msgr_channels ch where ch.id = new.channel_id and ch.personal_crews = 'blocked')
     and public.msgr_crew_tier(new.member_id) is distinct from 'company' then
    raise exception 'msgr_channel_personal_blocked';
  end if;
  return new;
end $$;
create or replace function public.msgr_channel_policy_sweep() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.personal_crews = 'blocked' and old.personal_crews <> 'blocked' then
    delete from public.msgr_channel_members cm where cm.channel_id = new.id and cm.member_kind = 'crew' and public.msgr_crew_tier(cm.member_id) is distinct from 'company';
  end if;
  if new.personal_crews is distinct from old.personal_crews then
    perform public.msgr_audit(new.org_id, 'channel.personal_crews', 'channel', new.id::text, jsonb_build_object('from', old.personal_crews, 'to', new.personal_crews));
  end if;
  return new;
end $$;

-- 4) 봇 표
create table if not exists public.msgr_bots (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.msgr_orgs (id) on delete cascade,
  crew_id uuid not null unique references public.msgr_crews (id) on delete cascade,
  kind text not null check (kind in ('hermes', 'openclaw', 'custom')),
  name text not null check (length(name) between 1 and 80),
  token_hash text not null unique,           -- sha256(hex). 원문은 생성·회전 시 1회 반환
  token_hint text not null,                  -- 원문 앞 12자 — 표시·구분용
  created_by uuid not null references auth.users (id) on delete cascade, -- 책임자(부록 K: 봇 = 회사 지급 기기 직원, 만든 관리자가 직속 관리자)
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_seen_at timestamptz                   -- 마지막 getUpdates — 가용성은 이것뿐(Buzz agent-availability 규칙)
);
create index if not exists msgr_bots_org on public.msgr_bots (org_id);
alter table public.msgr_bots enable row level security;
drop policy if exists msgr_bots_select on public.msgr_bots;
create policy msgr_bots_select on public.msgr_bots for select to authenticated using (public.msgr_is_admin(org_id)); -- 쓰기 정책 없음: RPC만
grant select on public.msgr_bots to authenticated;

create or replace function public.msgr_bot_hash(t text) returns text
  language sql immutable as $$ select encode(sha256(convert_to(t, 'utf8')), 'hex') $$;
revoke all on function public.msgr_bot_hash(text) from public;

-- 5) 관리자 RPC — 만들기·회전·폐기
create or replace function public.msgr_bot_create(org uuid, kind text, name text, role_text text default null) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare me uuid := auth.uid(); token text; crew uuid; bid uuid; nm text := btrim(coalesce(name, ''));
begin
  if me is null or public.msgr_is_admin(org) is not true then raise exception 'msgr_admin_only' using detail = 'only org owner/admin can add an agent bot'; end if;
  if public.msgr_org_locked(org) then raise exception 'msgr_org_locked'; end if;
  if nm = '' or nm ~ '[\n\r]' then raise exception 'msgr_bot_name' using detail = 'bot name is required (single line)'; end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  perform set_config('msgr.bot_create', '1', true);
  insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow)
    values (org, me, 'bot', 'bot-' || left(replace(gen_random_uuid()::text, '-', ''), 12), nm, coalesce(nullif(btrim(role_text), ''), kind || ' agent'), 'bot', 'active', 'all')
    returning id into crew;
  perform set_config('msgr.bot_create', '', true);
  insert into public.msgr_bots (org_id, crew_id, kind, name, token_hash, token_hint, created_by)
    values (org, crew, kind, nm, public.msgr_bot_hash(token), left(token, 12), me) returning id into bid;
  perform public.msgr_audit(org, 'bot.create', 'bot', bid::text, jsonb_build_object('kind', kind, 'name', nm, 'crew', crew));
  return jsonb_build_object('bot_id', bid, 'crew_id', crew, 'token', token); -- 토큰은 여기서만 보인다
end $$;
create or replace function public.msgr_bot_rotate(bot uuid) returns text
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare b public.msgr_bots; token text;
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  if b.revoked_at is not null then raise exception 'msgr_bot_revoked'; end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  update public.msgr_bots set token_hash = public.msgr_bot_hash(token), token_hint = left(token, 12), rotated_at = now() where id = bot;
  perform public.msgr_audit(b.org_id, 'bot.rotate', 'bot', bot::text, '{}'::jsonb);
  return token;
end $$;
create or replace function public.msgr_bot_revoke(bot uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  select * into b from public.msgr_bots where id = bot;
  if b.id is null or auth.uid() is null or public.msgr_is_admin(b.org_id) is not true then raise exception 'msgr_admin_only'; end if;
  update public.msgr_bots set revoked_at = coalesce(revoked_at, now()) where id = bot;
  update public.msgr_crews set status = 'detached' where id = b.crew_id; -- 기존 게이트 전부 status='active'를 보므로 지시·답글·멤버 자동 차단
  delete from public.msgr_channel_members where member_kind = 'crew' and member_id = b.crew_id;
  perform public.msgr_audit(b.org_id, 'bot.revoke', 'bot', bot::text, '{}'::jsonb);
end $$;
revoke all on function public.msgr_bot_create(uuid, text, text, text) from public;
revoke all on function public.msgr_bot_rotate(uuid) from public;
revoke all on function public.msgr_bot_revoke(uuid) from public;
grant execute on function public.msgr_bot_create(uuid, text, text, text) to authenticated;
grant execute on function public.msgr_bot_rotate(uuid) to authenticated;
grant execute on function public.msgr_bot_revoke(uuid) to authenticated;

-- 6) 봇 쪽 RPC — 토큰이 자격(anon 호출 가능). 텔레그램 getMe/getUpdates/sendMessage의 서버측 정본
create or replace function public.msgr_bot_auth(token text) returns public.msgr_bots
  language sql stable security definer set search_path = public, pg_temp as $$
    select * from public.msgr_bots where token_hash = public.msgr_bot_hash(coalesce(token, '')) and revoked_at is null
$$;
revoke all on function public.msgr_bot_auth(text) from public; -- 내부 전용

create or replace function public.msgr_bot_me(token text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; c public.msgr_crews; o public.msgr_orgs;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  update public.msgr_bots set last_seen_at = now() where id = b.id;
  select * into c from public.msgr_crews where id = b.crew_id; select * into o from public.msgr_orgs where id = b.org_id;
  return jsonb_build_object('bot_id', b.id, 'crew_id', b.crew_id, 'org_id', b.org_id, 'org_name', o.name, 'org_slug', o.slug, 'name', b.name, 'kind', b.kind, 'status', c.status);
end $$;

-- 인바운드 대상 규칙 = 브리지와 동일(자동 라우팅 금지): 멘션 / 봇이 참가한 DM / 봇 글에 대한 답글. 읽을 수 있는 채널 = 공개 채널 또는 멤버로 들어간 채널.
create or replace function public.msgr_bot_updates(token text, after_id bigint default 0, lim int default 50) returns setof jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  update public.msgr_bots set last_seen_at = now() where id = b.id;
  update public.msgr_crews set last_seen_at = now(), cursor_msg_id = greatest(cursor_msg_id, coalesce(after_id, 0)) where id = b.crew_id; -- offset = ack(텔레그램 규율)
  return query
    select jsonb_build_object(
      'update_id', m.id,
      'message', jsonb_build_object(
        'message_id', m.id,
        'chat', jsonb_build_object('id', ch.id, 'kind', ch.kind, 'name', ch.name),
        'from', jsonb_build_object('id', m.author_user_id, 'name', coalesce(mem.display_name, '')),
        'date', extract(epoch from m.created_at)::bigint,
        'text', m.body,
        'reply_to', m.reply_to,
        'mentioned', m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', b.crew_id::text))))
    from public.msgr_messages m
    join public.msgr_channels ch on ch.id = m.channel_id and ch.archived_at is null
    left join public.msgr_org_members mem on mem.org_id = m.org_id and mem.user_id = m.author_user_id and mem.removed_at is null
    where m.org_id = b.org_id and m.id > coalesce(after_id, 0) and m.deleted_at is null and m.author_kind = 'user' and m.kind = 'text'
      and (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'crew' and cm.member_id = b.crew_id))
      and (m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'crew', 'id', b.crew_id::text))
           or ch.kind = 'dm'
           or exists (select 1 from public.msgr_messages p where p.id = m.reply_to and p.crew_id = b.crew_id))
    order by m.id
    limit greatest(1, least(coalesce(lim, 50), 100));
end $$;

-- 보내기: 답글이면 client_msg_id 'reply:<crew>:<src>' → 기존 msgr_crew_reply_gate 트리거가 msgr_can_instruct(허용 범위·채널 정책)를 재판정한다(발행마다 재판정 — Buzz 대조).
-- 답글이 아니면 봇이 그 채널을 읽을 수 있어야 한다(공개 또는 멤버). 멱등: 같은 (crew, src)에 두 번 답하면 기존 id 반환(중복 0).
create or replace function public.msgr_bot_send(token text, channel uuid, body text, src_id bigint default null) returns bigint
  language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; ch public.msgr_channels; mid bigint; cmid text;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  select * into ch from public.msgr_channels where id = channel and org_id = b.org_id and archived_at is null;
  if ch.id is null then raise exception 'msgr_bot_no_channel' using detail = 'channel not in this org'; end if;
  if not (ch.kind = 'public' or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'crew' and cm.member_id = b.crew_id)) then
    raise exception 'msgr_bot_not_member' using detail = 'add the bot to this channel first';
  end if;
  if src_id is not null then
    if not exists (select 1 from public.msgr_messages s where s.id = src_id and s.channel_id = ch.id and s.deleted_at is null) then raise exception 'msgr_bot_bad_reply' using detail = 'reply target not in channel'; end if;
    cmid := 'reply:' || b.crew_id::text || ':' || src_id::text;
    select id into mid from public.msgr_messages where channel_id = ch.id and author_kind = 'crew' and crew_id = b.crew_id and client_msg_id = cmid;
    if mid is not null then return mid; end if; -- 멱등
  else
    cmid := 'bot:' || b.crew_id::text || ':' || replace(gen_random_uuid()::text, '-', '');
  end if;
  update public.msgr_bots set last_seen_at = now() where id = b.id;
  update public.msgr_crews set last_seen_at = now() where id = b.crew_id;
  insert into public.msgr_messages (org_id, channel_id, author_kind, crew_id, kind, body, mentions, reply_to, client_msg_id)
    values (b.org_id, ch.id, 'crew', b.crew_id, 'text', left(coalesce(body, ''), 20000), '[]'::jsonb, src_id, cmid)
    returning id into mid;
  return mid;
end $$;
revoke all on function public.msgr_bot_me(text) from public;
revoke all on function public.msgr_bot_updates(text, bigint, int) from public;
revoke all on function public.msgr_bot_send(text, uuid, text, bigint) from public;
grant execute on function public.msgr_bot_me(text) to anon, authenticated;
grant execute on function public.msgr_bot_updates(text, bigint, int) to anon, authenticated;
grant execute on function public.msgr_bot_send(text, uuid, text, bigint) to anon, authenticated;
