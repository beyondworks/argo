-- 비공개 방의 실시간 방송을 조직 토픽(org:)이 아니라 받을 사람의 사용자 토픽(u:<uid>)으로 보낸다.
-- 실측(2026-09-18, 로컬 스택): org:<조직>은 조직 멤버 전원이 받는데, 내가 없는 B↔C DM의 message 방송
-- (id·kind·crew_id·mentions·reply_to·channel_id·author_kind·author_user_id — 본문은 없음)이 그대로 닿았고,
-- 0.1.28 앱은 그걸로 "사진·파일을 보냈습니다" OS 알림까지 띄웠다. 비공개 방의 존재·작성자·시각·멘션 대상이 조직 전원에게 샌다.
-- 규칙: 공개 채널 글만 org:<조직>. 조직 DM·비공개 채널·개인 공간은 그 방의 사람 멤버 + 그 방에 있는 크루의 소유자
--   (크루 브리지·상주 노드가 방송을 깨우기 신호로 쓴다 — 위임 DM처럼 소유자가 방 멤버가 아니어도 깨어나게. 방 밖 소유자에게는 깨우기 필드만) 각각의 u:<uid>.
--   결재는 여기에 "그 결재를 확정할 수 있는 사람"(msgr_can_decide와 같은 규칙)을 더한다.
-- u: payload에는 org_id를 싣는다 — 앱이 어느 공간의 글인지 안다(org: 토픽은 토픽 이름이 곧 조직).
-- 개인 공간은 옛 dm:<채널> 방송도 유지한다(0.1.28 앱이 열린 개인 방에서 그 토픽을 듣는다).
-- 호환: 새 앱은 org:·u:를 모두 구독 — 이 마이그레이션 전후 모두 동작. 옛 앱(0.1.28)은 적용 뒤 조직 DM·비공개 글 방송을 못 받아 10초 재조회로만 뜬다.

-- 방 방송을 받을 사람 — 사람 멤버(in_room) + 방에 있는 크루의 소유자(in_room=false — 깨우기 신호만 받는다). 조직 멤버 조건은 msgr_room_send가 건다.
create or replace function public.msgr_room_recipients(ch uuid) returns table (uid uuid, in_room boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
    select m.member_id, true from public.msgr_channel_members m where m.channel_id = ch and m.member_kind = 'user'
    union all
    select k.owner_user_id, false from public.msgr_channel_members m join public.msgr_crews k on k.id = m.member_id
     where m.channel_id = ch and m.member_kind = 'crew' and k.owner_user_id is not null
$$;
revoke all on function public.msgr_room_recipients(uuid) from public, anon, authenticated;

-- 결재를 확정할 수 있는 사람 — msgr_can_decide(ap)와 같은 규칙을 집합으로(트리거 안에서는 auth.uid()가 발신자라 함수를 그대로 못 쓴다)
create or replace function public.msgr_approval_deciders(ap uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select k.owner_user_id
      from public.msgr_crew_approvals a join public.msgr_crews k on k.id = a.crew_id left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap and (a.risk = 'low' or coalesce(p.approval_high_by, 'admin') = 'owner')
    union
    select om.user_id
      from public.msgr_crew_approvals a
      join public.msgr_orgs o on o.id = a.org_id and o.deleted_at is null
      join public.msgr_org_members om on om.org_id = a.org_id and om.role in ('owner', 'admin') and om.removed_at is null and (om.expires_at is null or om.expires_at > now())
      left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap and a.risk <> 'low' and coalesce(p.approval_high_by, 'admin') <> 'owner'
    union
    select u
      from public.msgr_crew_approvals a join public.msgr_org_policies p on p.org_id = a.org_id, unnest(coalesce(p.approver_user_ids, '{}'::uuid[])) u
     where a.id = ap and a.risk <> 'low' and p.approval_high_by = 'approvers'
$$;
revoke all on function public.msgr_approval_deciders(uuid) from public, anon, authenticated;

-- 방 단위 방송 — 공개 채널(또는 방 없는 조직 이벤트)은 org:, 그 밖은 받을 사람 각각의 u:.
-- 받을 사람 = 방 수신자 + extra(결재 확정권자). 조직 방이면 **모두** 지금 유효한 조직 멤버여야 한다(검수 #605: 확정권자 목록의 조직 밖 사용자·
-- 조직에서 빠진 크루 소유자에게 결재가 가던 결함). 방 멤버도 확정권자도 아닌 크루 소유자는 깨우기 필드({id, channel_id, crew_id, org_id})만 받는다.
create or replace function public.msgr_room_send(payload jsonb, event text, org uuid, ch uuid, extra uuid[] default '{}')
  returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare k text;
begin
  if ch is not null then select c.kind into k from public.msgr_channels c where c.id = ch; end if;
  if org is not null and (ch is null or k = 'public') then
    perform realtime.send(payload, event, 'org:' || org::text, true);
    return;
  end if;
  perform realtime.send(case when t.whole then payload || jsonb_build_object('org_id', org)
                             else jsonb_build_object('id', payload->'id', 'channel_id', payload->'channel_id', 'crew_id', payload->'crew_id', 'org_id', org) end,
                        event, 'u:' || t.uid::text, true)
    from (select x.uid, bool_or(x.whole) as whole
            from (select r.uid, r.in_room as whole from public.msgr_room_recipients(ch) r
                  union all select e, true from unnest(extra) e) x
           where x.uid is not null
             and (org is null or exists (select 1 from public.msgr_org_members om join public.msgr_orgs o on o.id = om.org_id and o.deleted_at is null
                                          where om.org_id = org and om.user_id = x.uid and om.removed_at is null and (om.expires_at is null or om.expires_at > now())))
           group by x.uid) t;
end $$;
revoke all on function public.msgr_room_send(jsonb, text, uuid, uuid, uuid[]) from public, anon, authenticated;

create or replace function public.msgr_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare p jsonb := jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'author_kind', new.author_kind, 'author_user_id', new.author_user_id, 'crew_id', new.crew_id,
                                      'kind', new.kind, 'mentions', new.mentions, 'reply_to', new.reply_to); -- 본문은 싣지 않는다(수신자는 RLS를 지난 조회로 읽는다)
begin
  if new.org_id is null then perform realtime.send(p, 'message', 'dm:' || new.channel_id::text, true); end if; -- 옛 앱(열린 개인 방) 호환
  perform public.msgr_room_send(p, 'message', new.org_id, new.channel_id);
  return new;
end $$;

create or replace function public.msgr_approval_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.msgr_room_send(
    jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'crew_id', new.crew_id, 'approval_id', new.approval_id, 'status', new.status),
    'approval', new.org_id, new.channel_id, array(select public.msgr_approval_deciders(new.id)));
  if tg_op = 'UPDATE' and new.status <> old.status then
    perform public.msgr_audit(new.org_id, 'approval.' || new.status, 'approval', new.approval_id, jsonb_build_object('crew_id', new.crew_id));
  end if;
  return new;
end $$;

create or replace function public.msgr_crew_request_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.msgr_room_send(jsonb_build_object('id', new.id, 'channel_id', new.channel_id, 'status', new.status, 'crew_id', new.crew_id), 'crew_request', new.org_id, new.channel_id);
  return new;
end $$;

-- 토픽 인가 — org:<조직>은 멤버, dm:<채널>은 그 채널을 읽을 수 있는 사람, u:<uid>는 **본인만**(수신 전용 — 발신 정책에는 넣지 않는다: 클라이언트가 남의 u:로 쓰지 못한다)
drop policy if exists msgr_realtime_recv on realtime.messages;
create policy msgr_realtime_recv on realtime.messages for select to authenticated
  using (realtime.messages.extension = 'broadcast' and (
    ((select realtime.topic()) like 'org:%' and public.msgr_is_member(public.msgr_uuid_or_null(substr((select realtime.topic()), 5))))
    or ((select realtime.topic()) like 'dm:%' and public.msgr_can_read_channel(public.msgr_uuid_or_null(substr((select realtime.topic()), 4))))
    or ((select realtime.topic()) = 'u:' || (select auth.uid())::text)));

-- 공간별 안 읽음 합계 — 조직 전환기·개인 공간 입구·독 배지가 쓴다(org_id null = 개인 공간). 채널별 셈은 msgr_unread와 같은 규칙
-- (채널당 99 상한, 내 글 제외, 보관 채널 제외, 읽을 수 있는 채널만)이고, 독 배지와 같게 음소거 채널을 뺀다.
create or replace function public.msgr_unread_totals()
returns table (org_id uuid, n int, mention int)
language sql stable security invoker set search_path = public as $fn$
  with per as (
    select c.id, c.org_id,
           least(99, count(m.id))::int as n,
           least(99, count(m.id) filter (where m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', (select auth.uid())::text))))::int as mention
      from public.msgr_channels c
      left join public.msgr_reads r on r.channel_id = c.id and r.user_id = (select auth.uid())
      join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
           and (m.author_user_id is null or m.author_user_id <> (select auth.uid()))
     where c.archived_at is null and public.msgr_can_read_channel(c.id)
       and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = c.id and p.user_id = (select auth.uid()) and p.muted)
     group by c.id, c.org_id
  )
  select per.org_id, sum(per.n)::int, sum(per.mention)::int from per group by per.org_id
$fn$;
revoke all on function public.msgr_unread_totals() from public, anon;
grant execute on function public.msgr_unread_totals() to authenticated;
