-- 초대에 들어갈 채널·사용 한도·취소 + 미리보기 + 채널까지 넣는 수락(0.1.30 초대 흐름 개편 1장, 유건 승인).
-- 발단(유건 실사례): 조직 초대로 들어왔는데 조직 채널이 비공개 하나뿐이라 빈 화면이었다 — 초대가 "조직"만 가리키고 "어느 방"은 몰랐다.
--
-- 호환(옛 앱 0.1.28·0.1.29·상주 노드):
--   * msgr_accept_invite(code) returns uuid 그대로 — 옛 앱은 반환값을 조직 id로 setOrgId, 노드는 그 id로 하트비트한다.
--     반환형을 바꾸려면 drop이 필요해 적용 순간 옛 앱 수락이 끊긴다. 오류도 지금처럼 msgr_invite_invalid 하나(옛 앱은 모르는 코드를 원문 표시).
--   * 새 앱은 msgr_accept_invite_v2(code) returns jsonb, msgr_invite_preview(code) returns jsonb를 쓴다(없으면 옛 흐름으로 물러난다).
--   * max_uses 기본값 1 — 옛 앱이 만드는 초대는 지금처럼 1회용. 새 앱이 명시적으로 null(제한 없음)·n을 넘긴다.
--   * expires_at = 링크 만료(null = 만료 없음). guest_days = 들어온 뒤 게스트로 머무는 기간 — 둘은 다른 값이다.
--   * channel_id(단수, 게스트 초대)는 유지하고 channel_ids와 트리거로 맞춘다. 옛 앱의 delete 취소도 계속 허용(revoked_at은 새 앱).
-- 권한(총괄 결정): 조직 초대(member·admin)는 지금처럼 관리자만 만든다. 게스트 초대는 채널 관리자도, 채널 정확히 1개.
--   넣을 수 있는 채널: 같은 조직·보관 안 됨·공개/비공개(DM·개인 공간 불가). 비공개 채널은 만든 사람이 그 채널의 방장일 때만.

-- ── 1. 열 ────────────────────────────────────────────────────────────────
alter table public.msgr_invites add column if not exists channel_ids uuid[] not null default '{}';
alter table public.msgr_invites add column if not exists max_uses int default 1;
alter table public.msgr_invites add column if not exists use_count int not null default 0;
alter table public.msgr_invites add column if not exists revoked_at timestamptz;
alter table public.msgr_invites alter column expires_at drop not null;
-- 이미 쓰인 옛 초대는 사용 1회로 센다(1회용 규칙이 새 수락 경로에서도 유지된다). 옛 게스트 초대는 채널 목록을 채운다.
update public.msgr_invites set use_count = 1 where accepted_at is not null and use_count = 0;
update public.msgr_invites set channel_ids = array[channel_id] where channel_id is not null and channel_ids = '{}';
alter table public.msgr_invites drop constraint if exists msgr_invites_uses;
alter table public.msgr_invites add constraint msgr_invites_uses
  check (use_count >= 0 and (max_uses is null or (max_uses >= 1 and use_count <= max_uses)) and cardinality(channel_ids) <= 50);

-- 다회용 링크의 사용 기록(누가 언제). accepted_by/at은 첫 사용자 기록으로 남긴다(옛 앱 목록 호환).
create table if not exists public.msgr_invite_uses (
  invite_id uuid not null references public.msgr_invites (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  used_at timestamptz not null default now(),
  primary key (invite_id, user_id)
);
alter table public.msgr_invite_uses enable row level security;
drop policy if exists msgr_invite_uses_select on public.msgr_invite_uses;
create policy msgr_invite_uses_select on public.msgr_invite_uses for select to authenticated
  using (exists (select 1 from public.msgr_invites i where i.id = invite_id)); -- 그 초대를 볼 수 있는 사람(관리자·채널 관리자)만 — 초대 표 RLS를 그대로 탄다
grant select on public.msgr_invite_uses to authenticated;
grant all on public.msgr_invite_uses to service_role;

-- ── 2. 만들 때 검사(서버 강제) ─────────────────────────────────────────────
-- BEFORE INSERT: channel_id ↔ channel_ids 맞춤 → 채널마다 조건 검사. RLS WITH CHECK는 이 트리거 뒤의 행으로 판정된다.
create or replace function public.msgr_invite_prepare() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare ch uuid; c record;
begin
  if new.channel_id is not null and cardinality(new.channel_ids) = 0 then new.channel_ids := array[new.channel_id]; end if; -- 옛 앱 게스트 초대
  new.channel_ids := coalesce((select array_agg(x order by o) from (select distinct on (x) x, o from unnest(new.channel_ids) with ordinality u(x, o) where x is not null order by x, o) d), '{}');
  if new.role = 'guest' then
    if cardinality(new.channel_ids) <> 1 then raise exception 'msgr_invite_guest_one_channel' using errcode = '22023'; end if;
    new.channel_id := new.channel_ids[1];
  elsif new.channel_id is not null then
    raise exception 'msgr_invite_channel_invalid' using errcode = '22023'; -- 단수 열은 게스트 전용(msgr_invites_channel_guest와 같은 뜻)
  end if;
  foreach ch in array new.channel_ids loop
    select k.id, k.kind, k.org_id, k.archived_at into c from public.msgr_channels k where k.id = ch;
    if c.id is null or c.org_id is distinct from new.org_id or c.archived_at is not null or c.kind not in ('public', 'private') then
      raise exception 'msgr_invite_channel_invalid' using errcode = '22023'; -- DM·개인 공간·다른 조직·보관·없는 채널
    end if;
    if c.kind = 'private' and not public.msgr_is_channel_host(ch) then
      raise exception 'msgr_invite_channel_forbidden' using errcode = '42501'; -- 비공개 채널은 그 채널의 방장만 초대에 넣는다
    end if;
  end loop;
  new.use_count := 0; new.revoked_at := null; -- 만들 때 사용 횟수·취소를 위조하지 못한다
  return new;
end $$;
revoke all on function public.msgr_invite_prepare() from public, anon, authenticated;
drop trigger if exists msgr_invite_prepare on public.msgr_invites;
create trigger msgr_invite_prepare before insert on public.msgr_invites for each row execute function public.msgr_invite_prepare();

-- 삽입 정책: 조직 초대는 관리자만(지금과 같다), 게스트 초대는 채널 관리자도(비공개 채널 1개 — 지금과 같다).
drop policy if exists msgr_invites_insert on public.msgr_invites;
create policy msgr_invites_insert on public.msgr_invites for insert to authenticated
  with check (created_by = (select auth.uid()) and accepted_at is null and not public.msgr_org_locked(org_id)
    and ((role <> 'guest' and channel_id is null and public.msgr_is_admin(org_id))
      or (channel_id is not null and role = 'guest' and public.msgr_can_manage_channel(channel_id)
          and exists (select 1 from public.msgr_channels c where c.id = channel_id and c.org_id = msgr_invites.org_id and c.kind = 'private' and c.archived_at is null))));

-- ── 3. 취소(소프트) ──────────────────────────────────────────────────────
create or replace function public.msgr_invite_revoke(invite uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites where id = invite for update;
  if inv.id is null or not (coalesce(public.msgr_is_admin(inv.org_id), false) or (inv.channel_id is not null and public.msgr_can_manage_channel(inv.channel_id))) then
    raise exception 'msgr_invite_not_found'; -- 볼 권한이 없는 초대는 없는 것과 같다(delete 정책과 같은 사람)
  end if;
  if inv.revoked_at is null then
    update public.msgr_invites set revoked_at = now() where id = inv.id;
    perform public.msgr_audit(inv.org_id, 'invite.revoke', 'invite', inv.id::text);
  end if;
end $$;
revoke all on function public.msgr_invite_revoke(uuid) from public, anon;
grant execute on function public.msgr_invite_revoke(uuid) to authenticated;

-- ── 4. 수락(공유 본체) ───────────────────────────────────────────────────
-- 지금 넣을 수 있는 채널인가 — 만들 때 검사와 같은 조건을 "초대 만든 사람" 기준으로 다시 본다(그사이 보관·방장 해제 → 건너뜀).
create or replace function public.msgr_invite_channel_ok(inv public.msgr_invites, ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch and c.org_id = inv.org_id and c.archived_at is null and c.kind in ('public', 'private')
                     and (c.kind = 'public'
                          or c.created_by = inv.created_by or inv.created_by = any (c.admin_user_ids)
                          or exists (select 1 from public.msgr_org_members m join public.msgr_orgs o on o.id = m.org_id and o.deleted_at is null
                                      where m.org_id = inv.org_id and m.user_id = inv.created_by and m.removed_at is null and m.role in ('owner', 'admin')
                                        and (m.expires_at is null or m.expires_at > now()))))
$$;
revoke all on function public.msgr_invite_channel_ok(public.msgr_invites, uuid) from public, anon, authenticated;

create or replace function public.msgr_invite_redeem(p_code text) returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype; cur public.msgr_org_members%rowtype; ch uuid; joined uuid[] := '{}'; skipped uuid[] := '{}'; active boolean; prior boolean;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  -- 행 잠금으로 동시 수락을 줄 세운다 — 뒤 트랜잭션은 앞의 증가를 본 뒤 다시 판정한다(READ COMMITTED 재평가).
  select * into inv from public.msgr_invites i where i.code = p_code for update;
  if inv.id is null or not exists (select 1 from public.msgr_orgs o where o.id = inv.org_id and o.deleted_at is null) then raise exception 'msgr_invite_not_found'; end if;
  if inv.revoked_at is not null then raise exception 'msgr_invite_revoked'; end if;
  if inv.expires_at is not null and inv.expires_at <= now() then raise exception 'msgr_invite_expired'; end if;
  select * into cur from public.msgr_org_members m where m.org_id = inv.org_id and m.user_id = auth.uid();
  active := cur.user_id is not null and cur.removed_at is null and (cur.expires_at is null or cur.expires_at > now());
  prior := exists (select 1 from public.msgr_invite_uses u where u.invite_id = inv.id and u.user_id = auth.uid());
  -- 사용 횟수는 "새로 들어오는 사람"만 센다 — 지금 유효한 멤버가 링크로 채널에 들어오면 세지 않고 기록만 남긴다
  -- (새 사람용 1회 링크를 기존 멤버가 먼저 써 버리지 않게). 소진된 링크는 이미 쓴 유효 멤버의 재수락만 통과한다.
  if inv.max_uses is not null and inv.use_count >= inv.max_uses and not (active and prior) then raise exception 'msgr_invite_exhausted'; end if;
  if inv.for_node and active and cur.role in ('owner', 'admin') then
    raise exception 'msgr_node_not_admin';
  end if;
  -- 조직 멤버: 지금 유효한 멤버는 초대 역할이 더 높을 때만 올린다(guest < member < admin < owner) — owner·admin이 멤버 링크를 열어도
  -- 강등되지 않는다(검토 #610 MEDIUM: 옛 정의의 on conflict … role = excluded.role이 강등했다). 게스트가 올라가면 게스트 기한을 지운다.
  -- 제거·만료된 사람·처음 오는 사람은 지금처럼 초대 역할로 넣는다.
  -- 본인 행의 역할·제거·기한을 바꾸는 것은 msgr_member_self_guard가 막는다 — 이 수락 경로만 초대 id를 트랜잭션 지역 플래그로 알려 통과시킨다
  -- (가드는 그 초대가 실제로 유효하고 같은 조직·같은 역할일 때만 통과 — 플래그만으로 역할을 올리지 못한다).
  insert into public.msgr_invite_uses (invite_id, user_id) values (inv.id, auth.uid()) on conflict (invite_id, user_id) do update set used_at = now(); -- 가드가 이 기록을 본다(사용자는 이 표에 쓸 수 없다)
  perform set_config('msgr.invite_accept', inv.id::text, true);
  if active then
    if array_position(array['guest', 'member', 'admin', 'owner'], inv.role) > array_position(array['guest', 'member', 'admin', 'owner'], cur.role) then
      update public.msgr_org_members set role = inv.role, expires_at = null where org_id = inv.org_id and user_id = auth.uid();
    end if;
  else
    insert into public.msgr_org_members (org_id, user_id, role, display_name, expires_at)
      values (inv.org_id, auth.uid(), inv.role, (select split_part(u.email, '@', 1) from auth.users u where u.id = auth.uid()),
              case when inv.role = 'guest' then now() + make_interval(days => inv.guest_days) else null end)
      on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, joined_at = now(), expires_at = excluded.expires_at,
        display_name = coalesce(public.msgr_org_members.display_name, excluded.display_name);
  end if;
  perform set_config('msgr.invite_accept', '', true);
  foreach ch in array inv.channel_ids loop
    if public.msgr_invite_channel_ok(inv, ch) then
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'user', auth.uid(), inv.created_by) on conflict do nothing;
      joined := joined || ch;
    else
      skipped := skipped || ch;
    end if;
  end loop;
  if not active then
    update public.msgr_invites set use_count = use_count + 1, accepted_by = coalesce(accepted_by, auth.uid()), accepted_at = coalesce(accepted_at, now()) where id = inv.id;
  end if;
  if not prior then
    perform public.msgr_audit(inv.org_id, 'invite.accept', 'invite', inv.id::text, jsonb_build_object('role', inv.role, 'channels', joined, 'skipped', skipped,
      'guest_days', case when inv.role = 'guest' then inv.guest_days else null end));
  end if;
  if inv.for_node then
    perform set_config('msgr.node_accept', '1', true); -- 트랜잭션 한정 플래그: 서비스 계정 지정은 소유자 또는 이 경로만(검수 H-6)
    update public.msgr_orgs set service_user_id = auth.uid(), node_seen_at = now() where id = inv.org_id;
    perform set_config('msgr.node_accept', '', true);
  end if;
  return jsonb_build_object('org_id', inv.org_id, 'channel_id', joined[1], 'joined_channel_ids', to_jsonb(joined), 'skipped_channel_ids', to_jsonb(skipped));
end $$;
revoke all on function public.msgr_invite_redeem(text) from public, anon, authenticated;

-- 본인 멤버 행 가드 — 초대 수락 경로 예외를 더한다. 기존 결함(main·라이브 실측 2026-09-18): 제거된 멤버·기한 지난 게스트가 관리자의 새 초대로
-- 다시 들어오면 수락 본체의 on conflict … removed_at = null이 이 가드에 막혀 msgr_member_self_only_name이 났다. 기존 owner·admin 강등 방지 뒤
-- 게스트 승격(guest → member)도 같은 자리를 지난다. 예외는 좁다: 플래그의 초대가 지금 유효하고, 같은 조직·새 역할 = 초대 역할·제거 해제·
-- 게스트면 기한 있음/아니면 없음·그 초대의 사용 기록이 있을 때만(수락 본체가 먼저 쓴다). 역할 상승을 막는 계정 삭제 예외(검수 #529 H2R-1)는 그대로다.
create or replace function public.msgr_member_self_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if current_setting('argo.msgr_account_delete', true) = '1' and new.removed_at is not null and old.removed_at is null and old.user_id = auth.uid() then return new; end if; -- msgr_delete_me 전용(트랜잭션 지역): 본인 멤버십 종료 전이만 — 역할 상승은 플래그가 있어도 막힌다(검수 #529 H2R-1)
  if nullif(current_setting('msgr.invite_accept', true), '') is not null and old.user_id = auth.uid() and new.removed_at is null
     and (new.role = 'guest') = (new.expires_at is not null)
     and exists (select 1 from public.msgr_invites i where i.id::text = current_setting('msgr.invite_accept', true) and i.org_id = new.org_id and i.role = new.role
                   and i.revoked_at is null and (i.expires_at is null or i.expires_at > now()))
     and exists (select 1 from public.msgr_invite_uses u where u.invite_id::text = current_setting('msgr.invite_accept', true) and u.user_id = new.user_id)
     then return new; end if; -- msgr_invite_redeem 전용(트랜잭션 지역). 사용 기록은 수락 본체만 쓴다 — 플래그를 위조해도 이 행이 없으면 통과하지 못한다
  -- 본인 갱신(관리자 아님)은 표시명만 — 역할·제거 표시·소속은 관리자 정책으로만. NULL 주의: is_admin은 서비스 문맥에서 NULL.
  if auth.uid() = old.user_id and not coalesce(public.msgr_is_admin(old.org_id), false)
     and (new.role <> old.role or new.removed_at is distinct from old.removed_at or new.expires_at is distinct from old.expires_at) then
    raise exception 'msgr_member_self_only_name';
  end if;
  return new;
end $$;

-- v1 — 옛 앱·노드 호환: 반환은 조직 id, 오류는 msgr_invite_invalid 하나(만료·소진·취소·없음을 가리지 않는다)
create or replace function public.msgr_accept_invite(code text) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb;
begin
  begin
    r := public.msgr_invite_redeem(code);
  exception when raise_exception then
    if sqlerrm in ('msgr_invite_not_found', 'msgr_invite_revoked', 'msgr_invite_expired', 'msgr_invite_exhausted') then raise exception 'msgr_invite_invalid'; end if;
    raise;
  end;
  return (r->>'org_id')::uuid;
end $$;

-- v2 — 새 앱: {org_id, channel_id(첫 채널|null), joined_channel_ids, skipped_channel_ids}, 오류는 상태별
create or replace function public.msgr_accept_invite_v2(code text) returns jsonb
  language sql security definer set search_path = public, pg_temp as $$ select public.msgr_invite_redeem(code) $$;
revoke all on function public.msgr_accept_invite_v2(text) from public, anon;
grant execute on function public.msgr_accept_invite_v2(text) to authenticated;

-- ── 5. 미리보기 ─────────────────────────────────────────────────────────
-- 코드 보유자에게 "어디로 초대됐는지"를 보여 준다. 비공개 채널 이름은 의도(초대장에 행선지가 있어야 한다 — 설계서 4장).
-- 이름 외(주제·멤버·글·사용 횟수)는 없다. 틀린 코드는 msgr_invite_not_found 하나. 쓸 수 없는 초대는 {state, org_name}만.
create or replace function public.msgr_invite_preview(code text) returns jsonb
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype; org_name text; member boolean; used boolean; chans jsonb; ok uuid[]; st text; inviter text;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites i where i.code = msgr_invite_preview.code;
  select o.name into org_name from public.msgr_orgs o where o.id = inv.org_id and o.deleted_at is null;
  if inv.id is null or org_name is null then raise exception 'msgr_invite_not_found'; end if;
  member := exists (select 1 from public.msgr_org_members m where m.org_id = inv.org_id and m.user_id = auth.uid() and m.removed_at is null and (m.expires_at is null or m.expires_at > now()));
  used := member and exists (select 1 from public.msgr_invite_uses u where u.invite_id = inv.id and u.user_id = auth.uid());
  select coalesce(array_agg(x order by o), '{}') into ok from unnest(inv.channel_ids) with ordinality u(x, o) where public.msgr_invite_channel_ok(inv, x);
  st := case
    when inv.revoked_at is not null then 'revoked'
    when inv.expires_at is not null and inv.expires_at <= now() then 'expired'
    when member and not exists (select 1 from unnest(ok) x where not exists (select 1 from public.msgr_channel_members cm where cm.channel_id = x and cm.member_kind = 'user' and cm.member_id = auth.uid())) then 'already_member'
    when not used and inv.max_uses is not null and inv.use_count >= inv.max_uses then 'exhausted'
    else 'valid' end;
  if st not in ('valid', 'already_member') then return jsonb_build_object('state', st, 'org_name', org_name); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kind', c.kind) order by u.o), '[]') into chans
    from unnest(ok) with ordinality u(x, o) join public.msgr_channels c on c.id = u.x;
  inviter := coalesce((select m.display_name from public.msgr_org_members m where m.org_id = inv.org_id and m.user_id = inv.created_by),
                      (select p.display_name from public.msgr_profiles p where p.user_id = inv.created_by));
  return jsonb_build_object('state', st, 'org_id', inv.org_id, 'org_name', org_name, 'channels', chans, 'inviter_name', inviter, 'role', inv.role,
    'expires_at', inv.expires_at);
end $$;
revoke all on function public.msgr_invite_preview(text) from public, anon;
grant execute on function public.msgr_invite_preview(text) to authenticated;
