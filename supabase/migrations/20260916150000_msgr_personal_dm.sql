-- 개인 공간 1단계(슬랙식) — 조직에 속하지 않는 친구 1:1 대화. 유건 결정 2026-09-16.
--   · 전환기에서 "개인"과 조직을 오간다. 조직 대화·채널·크루는 종전 그대로다.
--   · 친구와의 1:1은 org_id가 null인 dm 채널 한 개로 열린다(친구 관계가 곧 입장권 — 초대 링크 불필요).
-- 이 파일은 org 없는 채널을 **허용**만 하고, 조직 경로의 판정은 바꾸지 않는다(조직 동작 회귀 0이 목표).

-- ── 1. 조직 밖 채널 허용 ──────────────────────────────────────────────────────
alter table public.msgr_channels alter column org_id drop not null;
alter table public.msgr_channels drop constraint if exists msgr_channels_orgless_dm_only;
alter table public.msgr_channels add constraint msgr_channels_orgless_dm_only
  check (org_id is not null or kind = 'dm'); -- 조직 밖은 1:1만. 공개·비공개 채널은 조직의 것이다.
-- 메시지도 같은 전제를 풀어야 한다(채움 트리거가 채널의 org를 그대로 옮긴다 — 조직 글은 종전대로 org가 박힌다).
alter table public.msgr_messages alter column org_id drop not null;
-- 첨부·결재·크루 요청·조직 문서는 조직 전용으로 남긴다(개인 공간의 파일·크루는 다음 단계). 화면에서 그 버튼을 감춘다.

-- ── 2. 권한 — 조직 밖 채널은 "채널 멤버"만으로 판정한다 ───────────────────────
-- 종전: 멤버십 + msgr_is_member(org). org가 null이면 msgr_is_member(null) = false라 아무도 못 읽는다.
create or replace function public.msgr_can_read_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels c
       where c.id = ch and (
         (c.kind = 'public' and c.org_id is not null and public.msgr_role(c.org_id) in ('owner', 'admin', 'member') and not (auth.uid() = any (c.excluded_user_ids)))
         or exists (select 1 from public.msgr_channel_members m
                     where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid()
                       and (c.org_id is null or public.msgr_is_member(c.org_id)))
       )
    )
$$;
-- 조직 잠금(결제 연체)은 조직 채널에만 해당한다 — 개인 1:1은 조직 결제와 무관하다.
create or replace function public.msgr_can_write_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select public.msgr_can_read_channel(ch)
       and exists (select 1 from public.msgr_channels c
                    where c.id = ch and c.archived_at is null
                      and (c.org_id is null or not public.msgr_org_locked(c.org_id)))
$$;

-- ── 3. 메시지 채움 — "org 없는 채널"과 "없는 채널"을 가른다 ───────────────────
-- 종전 가드는 org_id가 null이면 채널이 없는 것으로 보고 던졌다(개인 1:1이 그대로 막힌다).
create or replace function public.msgr_message_fill() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare found boolean;
begin
  select true, c.org_id into found, new.org_id from public.msgr_channels c where c.id = new.channel_id;
  if not coalesce(found, false) then raise exception 'msgr_channel_missing'; end if;
  if new.reply_to is not null and not exists (select 1 from public.msgr_messages where id = new.reply_to and channel_id = new.channel_id) then
    raise exception 'msgr_reply_cross_channel';
  end if;
  if new.thread_root is null then new.thread_root := new.reply_to; end if;
  return new;
end $$;

-- ── 4. 실시간 — 조직 밖 대화는 채널 토픽(dm:<채널>)으로 방송한다 ──────────────
create or replace function public.msgr_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id, 'crew_id', new.crew_id,
                       'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to),
    'message',
    case when new.org_id is null then 'dm:' || new.channel_id::text else 'org:' || new.org_id::text end,
    true);
  return new;
end $$;
-- 토픽 인가 — org:<조직>은 멤버, dm:<채널>은 그 채널을 읽을 수 있는 사람만.
drop policy if exists msgr_realtime_recv on realtime.messages;
create policy msgr_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))));
drop policy if exists msgr_realtime_send on realtime.messages;
create policy msgr_realtime_send on realtime.messages for insert to authenticated
  with check (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))));

-- ── 5. 친구와의 1:1 열기 — 있으면 그 방, 없으면 만든다(멱등) ─────────────────
-- 한 쌍 = 한 방을 **구조로** 보장한다(멤버 구성으로 찾으면 나갔다 들어올 때 방이 갈라진다).
alter table public.msgr_channels add column if not exists personal_pair text;
create unique index if not exists msgr_channels_personal_pair on public.msgr_channels (personal_pair) where personal_pair is not null;
create or replace function public.msgr_pair_key(x uuid, y uuid) returns text
  language sql immutable as $$ select least(x::text, y::text) || ':' || greatest(x::text, y::text) $$;
-- 친구(accepted)만 연다. 초대·조직 멤버십은 필요 없다. 같은 두 사람에게는 **한 방만** 존재한다.
create or replace function public.msgr_dm_personal(target uuid) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); ch uuid; pr uuid[];
begin
  if me is null then raise exception 'msgr_auth_required'; end if;
  if target is null or target = me then raise exception 'msgr_bad_target'; end if;
  pr := public.msgr_friend_pair(me, target);
  if not exists (select 1 from public.msgr_friends f where f.a = pr[1] and f.b = pr[2] and f.status = 'accepted') then
    raise exception 'msgr_not_friend'; -- 친구 수락 전에는 열리지 않는다(요청은 msgr_friend_request)
  end if;
  -- 짝으로 찾는다 — 멤버 구성으로 찾으면 한쪽이 나갔다 다시 열 때 방이 갈라진다(두 사람이 서로 다른 방에서 말하게 된다).
  select c.id into ch from public.msgr_channels c
   where c.personal_pair = public.msgr_pair_key(me, target) for update;
  if ch is null then
    insert into public.msgr_channels (org_id, kind, name, created_by, personal_pair)
      values (null, 'dm', 'dm', me, public.msgr_pair_key(me, target)) returning id into ch;
  end if;
  -- 나갔던 사람만 다시 넣는다(친구인 동안에는 같은 방으로 돌아온다).
  -- on conflict로 뭉뚱그리면 안 된다: DM 정원 트리거(msgr_dm_shape)는 충돌 처리 **전에** 돌아 이미 있는 멤버도 "정원 초과"로 센다.
  insert into public.msgr_channel_members (channel_id, member_kind, member_id)
    select ch, 'user', v.u from (values (me), (target)) v(u)
     where not exists (select 1 from public.msgr_channel_members m
                        where m.channel_id = ch and m.member_kind = 'user' and m.member_id = v.u);
  return ch;
end $$;
revoke all on function public.msgr_dm_personal(uuid) from public;
grant execute on function public.msgr_dm_personal(uuid) to authenticated;

-- ── 6. 내 개인 1:1 목록 — 채널당 마지막 메시지 1행(조직판 msgr_dm_latest와 같은 모양) ──
create or replace function public.msgr_dm_personal_list() returns table (channel_id uuid, other_user_id uuid, last_at timestamptz, last_body text)
  language sql stable security definer set search_path = public, pg_temp as $$
    select c.id,
           (select m.member_id from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid() limit 1),
           (select max(x.created_at) from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null),
           (select x.body from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1)
      from public.msgr_channels c
     where c.org_id is null and c.kind = 'dm' and c.archived_at is null
       and exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by 3 desc nulls last
$$;
revoke all on function public.msgr_dm_personal_list() from public;
grant execute on function public.msgr_dm_personal_list() to authenticated;

-- ── 7. 목록·나가기·안 읽음·계정 삭제 — 조직 밖 채널이 조용히 빠지던 자리(전수 수색 결과 반영) ──
-- 채널 select 정책은 can_read와 별개 경로다. 이걸 안 열면 방이 목록에 아예 안 나온다(P0-3).
drop policy if exists msgr_channels_select on public.msgr_channels;
create policy msgr_channels_select on public.msgr_channels for select to authenticated
  using ((kind = 'public' and org_id is not null and public.msgr_role(org_id) in ('owner', 'admin', 'member') and not ((select auth.uid()) = any (excluded_user_ids)))
      or (public.msgr_is_channel_user(id) and (org_id is null or public.msgr_is_member(org_id))));

-- 안 읽음 — org를 null로 부르면 개인 공간의 안 읽음을 준다(조직 호출은 종전과 동일).
create or replace function public.msgr_unread(org uuid)
returns table (channel_id uuid, n int, mention int)
language sql stable security invoker set search_path = public as $fn$
  select c.id,
         least(99, count(m.id))::int,
         least(99, count(m.id) filter (where m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', (select auth.uid())::text))))::int
  from public.msgr_channels c
  left join public.msgr_reads r on r.channel_id = c.id and r.user_id = (select auth.uid())
  join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
       and (m.author_user_id is null or m.author_user_id <> (select auth.uid()))
  where (c.org_id = org or (org is null and c.org_id is null)) and c.archived_at is null and public.msgr_can_read_channel(c.id)
  group by c.id
$fn$;
grant execute on function public.msgr_unread(uuid) to authenticated;

-- 1:1 나가기 — 조직 밖 방은 조직 멤버십을 묻지 않는다(종전 게이트는 42501로 막았다).
create or replace function public.msgr_leave_dm(ch uuid) returns boolean
  language plpgsql security invoker set search_path = public, pg_temp as $fn$
declare me uuid := auth.uid(); channel public.msgr_channels; removed integer;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || ch::text));
  select * into channel from public.msgr_channels where id = ch for update;
  if channel.id is null then return false; end if;
  if channel.kind <> 'dm' then raise exception 'msgr_dm_required' using errcode = '22023'; end if;
  if channel.org_id is not null and not coalesce(public.msgr_is_member(channel.org_id), false) then
    raise exception 'msgr_forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.msgr_channel_members
      where channel_id = ch and member_kind = 'user' and member_id = me) then return false; end if;
  delete from public.msgr_channel_members m using public.msgr_crews c
    where m.channel_id = ch and m.member_kind = 'crew' and m.member_id = c.id
      and c.org_id = channel.org_id and c.owner_user_id = me;
  delete from public.msgr_channel_members where channel_id = ch and member_kind = 'user' and member_id = me;
  get diagnostics removed = row_count;
  if removed <> 1 then raise exception 'msgr_leave_failed' using errcode = '42501'; end if;
  return true;
end $fn$;
revoke all on function public.msgr_leave_dm(uuid) from public, anon;
grant execute on function public.msgr_leave_dm(uuid) to authenticated;

-- 계정 삭제 — 조직 밖 채널의 작성자를 남은 상대에게 넘긴다. 안 넘기면 FK가 auth.users 삭제를 막아 계정 삭제가 통째로 실패한다.
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare
  me uuid := auth.uid();
  blocked text;
  owned uuid[];
  n_orgs int := 0;
begin
  if me is null then raise exception 'msgr_unauthenticated'; end if;

  -- 다른 활성 멤버(서비스 계정·만료 게스트 제외)가 있는 소유 조직 — 보관 중이어도 남의 기록이므로 이전이 먼저(2R H-1·M-1)
  select string_agg(o.name, ', ' order by o.name) into blocked
    from public.msgr_orgs o
   where o.owner_user_id = me
     and (o.deleted_at is null or o.deleted_at > now() - interval '30 days') -- 유예가 끝난 보관 조직은 어차피 purge 대상 — 이전을 요구하면 복구도 목록도 없는 막다른 길(3R M2R-3)
     and exists (select 1 from public.msgr_org_members m
                  where m.org_id = o.id and m.user_id <> me and m.removed_at is null
                    and (m.expires_at is null or m.expires_at > now())
                    and (o.service_user_id is null or m.user_id <> o.service_user_id));
  if blocked is not null then
    raise exception 'msgr_owner_transfer_required: %', blocked;
  end if;

  perform set_config('argo.msgr_account_delete', '1', true); -- 이 함수 안에서만 가드 통과. 끝·예외에서 되돌린다(2R H-2)

  -- 다른 조직에 남는 내 흔적 중 FK가 사용자 삭제를 막는 것(created_by/updated_by NOT NULL·규칙 없음)은 조직 소유자에게 넘긴다
  update public.msgr_channels c set created_by = o.owner_user_id from public.msgr_orgs o where o.id = c.org_id and c.created_by = me and o.owner_user_id <> me;
  -- 개인 공간(조직 밖) 1:1 — 조직 소유자가 없으니 남은 상대에게 넘기고, 혼자 남은 방은 지운다.
  -- 이걸 빠뜨리면 msgr_channels.created_by FK가 auth.users 삭제를 막아 **계정 삭제 전체가 실패**한다(전수 수색 P3-16).
  update public.msgr_channels c set created_by = (
      select m.member_id from public.msgr_channel_members m
       where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> me limit 1)
    where c.org_id is null and c.created_by = me
      and exists (select 1 from public.msgr_channel_members m
                   where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> me);
  delete from public.msgr_channels c where c.org_id is null and c.created_by = me;
  update public.msgr_org_docs d set created_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.created_by = me and o.owner_user_id <> me;
  update public.msgr_org_docs d set updated_by = o.owner_user_id from public.msgr_orgs o where o.id = d.org_id and d.updated_by = me and o.owner_user_id <> me;
  update public.msgr_work_runs w set created_by = o.owner_user_id from public.msgr_orgs o where o.id = w.org_id and w.created_by = me and o.owner_user_id <> me;
  update public.msgr_channel_members set added_by = null where added_by = me;
  update public.msgr_crew_approvals set decided_by = null where decided_by = me;
  -- 회사 노드 서비스 계정·후계자·이전 제안은 auth.users FK(on delete set null)가 비운다 — 캐스케이드 UPDATE는 msgr_org_before_update의 캐스케이드 분기가 감사(org.service_account·org.successor)를 직접 남긴다(2R C-2·C-3, 3R H2R-1·M2R-5). 명시 해제 3줄은 변이로 죽은 코드임이 실증돼 지웠다.

  -- 내 채널 멤버십(폴리모픽 — FK 없음)과 조직 멤버십 종료(오프보딩 사슬: 크루 분리·채널 회수)
  delete from public.msgr_channel_members where member_kind = 'user' and member_id = me;
  update public.msgr_org_members set removed_at = now() where user_id = me and removed_at is null;

  -- 나만 남은 소유 조직: 첨부 파일 → 조직(자식 cascade) 순으로 하드 삭제. 위 검사로 다른 활성 멤버가 있는 조직은 여기 없다
  select coalesce(array_agg(id), '{}'::uuid[]) into owned from public.msgr_orgs where owner_user_id = me;
  perform set_config('storage.allow_delete_query', 'true', true); -- storage-api의 직접 삭제 가드(protect_objects_delete) 통과 — 트랜잭션 지역. 행이 사라지면 공개 URL은 400(본문 not_found), 서명 URL도 만들 수 없다(로컬 스택 실측). 백엔드 바이트는 msgr_purge_orgs와 같이 남는다(알려진 한계, 로컬 스택 E2E 실측)
  if array_length(owned, 1) > 0 then
    delete from storage.objects where bucket_id = 'msgr' and (storage.foldername(name))[1] = any (owned::text[]);
    delete from public.msgr_orgs where id = any (owned);
    get diagnostics n_orgs = row_count;
  end if;
  -- 공개 아바타(msgr-avatars/avatars/<uid>/…)는 계정과 함께(2R M-2)
  delete from storage.objects where bucket_id = 'msgr-avatars' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = me::text;
  if to_regclass('public.device_keys') is not null then
    update public.device_keys set revoked_at = now() where user_id = me and revoked_at is null;
  end if;

  -- 프로필·친구·푸시 토큰·읽음·반응·핀·알림 경로·멤버십·크루·초대는 auth.users FK cascade
  delete from auth.users where id = me;
  perform set_config('argo.msgr_account_delete', '', true); perform set_config('storage.allow_delete_query', '', true); -- 두 GUC 모두 복원(3R L2R-1)
  return jsonb_build_object('deleted_orgs', n_orgs);
exception when others then
  perform set_config('argo.msgr_account_delete', '', true); perform set_config('storage.allow_delete_query', '', true); -- 두 GUC 모두 복원(3R L2R-1)
  raise;
end $$;

revoke all on function public.msgr_delete_me() from public, anon;
grant execute on function public.msgr_delete_me() to authenticated;

-- 채널 관리 판정 — 조직 밖 1:1은 "그 방의 두 사람"이 곧 관리자다(조직 멤버십을 물으면 나가기·보관이 막힌다).
-- 실측: msgr_leave_dm의 `select … for update`가 update 정책(이 함수)까지 통과해야 해서, 안 열면 나가기가 조용히 false를 돌려준다.
create or replace function public.msgr_can_manage_channel(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c where c.id = ch
                     and (c.created_by = auth.uid() or auth.uid() = any (c.admin_user_ids)
                          or (c.kind <> 'dm' and c.org_id is not null and coalesce(public.msgr_is_admin(c.org_id), false))
                          or (c.kind = 'dm' and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())))
                     and (c.org_id is null or coalesce(public.msgr_is_member(c.org_id), false)))
$$;
