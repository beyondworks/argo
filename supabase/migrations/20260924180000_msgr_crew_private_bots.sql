-- 남의 에이전트는 소유자가 채널에 초대했을 때만 쓴다 — 외부(VPS) 봇도 Argo 로컬 에이전트와 같은 규칙(유건 2026-09-24:
-- "VPS 에이전트들이 다른 사람 계정에도 뜨고 다른 사람이 내 에이전트를 마구 사용", "전부 잠궈 나만 봐야 하고 내가 채널에서 초대할 때에만
-- 다른 사람에게 보여야해. 아르고 에이전트처럼", 다른 계정 봇도 "마찬가지").
-- 실사고(라이브 2026-09-24 08:44·08:47 UTC): 조직 멤버가 자기 DM에서 남의 봇을 멘션 → msgr_dm_relay가 msgr_dm_for_crew로 허용 범위 확인 없이
-- "멤버+소유자+봇" 방을 만들었고, 방 안의 크루는 방 멤버 누구나 지시 가능(msgr_instruct_check)이라 봇이 모든 지시에 답했다.
-- 로컬 에이전트도 같은 전달 경로로 열려 있었다. 봇은 만들 때 allow='all' 고정·회사 등급이라 남의 레일에도 보였다.

-- ── 1. 전달 방은 그 크루를 부를 수 있는 사람에게만 — 소유자 본인이거나 크루 허용 범위(allow) 안의 사람 ─────────────
-- 채널을 지정하지 않은 판정이라 "방 안의 크루" 예외를 타지 않고 allow만 본다. 거절은 예외로 — msgr_dm_relay의 예외 처리가
-- 원래 방에 "전달 실패"로 남기고 원래 글은 되돌리지 않는다(20260920123000).
create or replace function public.msgr_dm_for_crew(p_org uuid, p_user uuid, p_crew uuid) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare c msgr_crews; want uuid[]; ch uuid; u uuid;
begin
  select * into c from msgr_crews where id=p_crew and org_id=p_org and status='active';
  if c.id is null then return null; end if;
  if public.msgr_instruct_check(p_crew, p_user, null) <> 'ok' then raise exception 'msgr_crew_not_allowed' using errcode = '42501'; end if;
  want:=array(select distinct x from unnest(array[p_user,c.owner_user_id]) x order by x);
  -- 락을 조회보다 먼저 잡는다(검수 HIGH-1: 뒤에 잡으면 두 트랜잭션이 각자 "없음"을 보고 같은 방을 두 개 만든다).
  perform pg_advisory_xact_lock(hashtext('msgr_dm_for_crew:'||p_user::text||':'||p_crew::text));
  select d.id into ch from msgr_channels d
   where d.org_id=p_org and d.kind='dm' and d.archived_at is null
     and (select array_agg(m.member_id order by m.member_id) from msgr_channel_members m where m.channel_id=d.id and m.member_kind='user')=want
     and (select array_agg(m.member_id) from msgr_channel_members m where m.channel_id=d.id and m.member_kind='crew')=array[p_crew]
   order by d.created_at,d.id limit 1;
  if ch is not null then return ch; end if;
  insert into msgr_channels(org_id,kind,name,created_by) values(p_org,'dm',c.display_name,p_user) returning id into ch;
  foreach u in array want loop insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values(ch,'user',u,p_user); end loop;
  insert into msgr_channel_members(channel_id,member_kind,member_id,added_by) values(ch,'crew',p_crew,p_user);
  return ch;
end $$;
revoke all on function public.msgr_dm_for_crew(uuid,uuid,uuid) from public,anon,authenticated;

-- ── 2. 봇 = 개인 등급 — 회사 등급은 조직 서비스 계정 소유의 상주 크루뿐(msgr_crew_is_company와 같은 기준) ─────────────
create or replace function public.msgr_crew_tier(crew uuid) returns text
  language sql stable security invoker set search_path = public, pg_temp as $$
    select case when o.service_user_id is not null and c.owner_user_id = o.service_user_id and c.hosting = 'resident' then 'company' else 'personal' end
      from public.msgr_crews c join public.msgr_orgs o on o.id = c.org_id where c.id = crew
$$;

-- 읽기 전용 채널 정책의 봇 예외도 없앤다(나머지는 20260918150000 정의 그대로).
create or replace function public.msgr_instruct_check(crew uuid, author uuid, channel uuid default null) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select case
      when c.id is null or c.status <> 'active' or author is null then 'inactive'
      when channel is not null and ch.personal_crews = 'read_only'
           and not public.msgr_crew_is_company(c.id) then 'channel_policy'
      when channel is not null and public.msgr_crew_in_channel(channel, c.id)
           and m.user_id is not null and (m.expires_at is null or m.expires_at > now())
           and ((ch.kind = 'public' and m.role in ('owner', 'admin', 'member') and not (author = any (ch.excluded_user_ids)))
                or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = ch.id and cm.member_kind = 'user' and cm.member_id = author)) then 'ok'
      when c.owner_user_id = author then 'ok'
      when c.allow = 'owner' then 'crew_allow'
      when c.allow = 'list' then case when author = any (c.allow_users) and m.user_id is not null then 'ok' else 'crew_allow' end
      else case when m.user_id is not null then 'ok' else 'crew_allow' end
    end
      from (select 1) x
      left join public.msgr_crews c on c.id = crew
      left join public.msgr_channels ch on ch.id = channel
      left join public.msgr_org_members m on m.org_id = c.org_id and m.user_id = author and m.removed_at is null
$$;

-- ── 3. 새 봇의 허용 범위 = 조직 정책 기본값(정책 행이 없으면 소유자만) — 로컬 에이전트 기본 파견과 같은 규칙(msgr.mjs allowDefaults) ──
create or replace function public.msgr_bot_create(org uuid, kind text, name text, role_text text default null, external_id text default null) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare me uuid := auth.uid(); token text; crew uuid; bid uuid; nm text := btrim(coalesce(name, '')); ext text := nullif(btrim(coalesce(external_id, '')), '');
  dflt text := coalesce((select p.allow_default from public.msgr_org_policies p where p.org_id = org), 'owner');
begin
  if me is null or public.msgr_is_admin(org) is not true then raise exception 'msgr_admin_only' using detail = 'only org owner/admin can add an agent bot'; end if;
  if public.msgr_org_locked(org) then raise exception 'msgr_org_locked'; end if;
  if nm = '' or nm ~ '[\n\r]' then raise exception 'msgr_bot_name' using detail = 'bot name is required (single line)'; end if;
  if ext is not null and exists (select 1 from public.msgr_bots b where b.org_id = org and b.external_id = ext and b.revoked_at is null) then
    raise exception 'msgr_bot_exists' using detail = 'a bot for this agent already exists — rotate it instead';
  end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  perform set_config('msgr.bot_create', '1', true);
  insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow)
    values (org, me, 'bot', 'bot-' || left(replace(gen_random_uuid()::text, '-', ''), 12), nm, coalesce(nullif(btrim(role_text), ''), kind || ' agent'), 'bot', 'active', dflt)
    returning id into crew;
  perform set_config('msgr.bot_create', '', true);
  insert into public.msgr_bots (org_id, crew_id, kind, name, token_hash, token_hint, created_by, external_id)
    values (org, crew, kind, nm, public.msgr_bot_hash(token), left(token, 12), me, ext) returning id into bid;
  perform public.msgr_audit(org, 'bot.create', 'bot', bid::text, jsonb_build_object('kind', kind, 'name', nm, 'crew', crew, 'external_id', ext));
  return jsonb_build_object('bot_id', bid, 'crew_id', crew, 'token', token);
end $$;
revoke all on function public.msgr_bot_create(uuid, text, text, text, text) from public;
grant execute on function public.msgr_bot_create(uuid, text, text, text, text) to authenticated;

-- ── 4. 기존 데이터 정리(한 번) ────────────────────────────────────────────────────────────────
-- 4-a. 전달로 생긴 남의 방에서 크루만 뺀다 — 방을 만든 사람(created_by)이 크루 소유자가 아니고, 크루를 넣은 사람도 소유자가 아닌 DM.
--      소유자가 직접 연 방(msgr_create_channel·msgr_crew_join은 소유자만 넣는다)은 대상이 아니다. 방·대화 기록은 지우지 않는다(기억 데이터 보존).
delete from public.msgr_channel_members cm
 using public.msgr_channels ch, public.msgr_crews c
 where cm.channel_id = ch.id and cm.member_kind = 'crew' and c.id = cm.member_id
   and ch.kind = 'dm' and ch.created_by is distinct from c.owner_user_id and cm.added_by is distinct from c.owner_user_id
   and not public.msgr_crew_is_company(c.id);
-- 4-b. 모든 봇은 소유자만 — 조직 정책이 잠겨 있으면 그 정책값(잠금 트리거 msgr_crew_policy_gate가 다른 값을 거절한다).
update public.msgr_crews c
   set allow = coalesce(case when p.allow_locked then p.allow_default end, 'owner'),
       allow_users = case when coalesce(case when p.allow_locked then p.allow_default end, 'owner') = 'list' then c.allow_users else '{}'::uuid[] end
  from public.msgr_crews c2 left join public.msgr_org_policies p on p.org_id = c2.org_id
 where c.id = c2.id and c.hosting = 'bot'
   and c.allow is distinct from coalesce(case when p.allow_locked then p.allow_default end, 'owner');

notify pgrst, 'reload schema';
