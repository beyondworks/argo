-- 친구·에이전트 넣기 요청의 실시간 방송(기능 점검 D5·D6, 2026-10-02). 앱이 15초마다 친구 목록·결재를 다시 읽던 주기 호출을 없애며(D2),
-- 그 자리를 이 방송으로 채운다 — 받은 쪽만 그때 다시 읽는다(유휴 0).
-- 방송 내용은 종류와 id만(이름·상태·본문 없음). 받는 토픽은 본인만 읽는 u:<uid>(20260918184500 수신 정책).

-- ── D5 친구 표(msgr_friends: a<b 정규화) — 요청·수락·거절·삭제·차단 모두. 두 사람 각자에게 '상대 id'만 보낸다.
-- 차단도 같은 방송이다: 상태를 싣지 않으므로 차단당한 쪽이 아는 것은 "그 사람과의 관계가 바뀌었다"뿐이고, 다시 읽은 목록(차단 행은 빠진다)은 새로고침했을 때와 같다.
-- 같은 상태로의 갱신은 보내지 않는다(update 트리거의 WHEN).
create or replace function public.msgr_friend_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr_friends;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  perform realtime.send(jsonb_build_object('other', r.b), 'friend', 'u:' || r.a::text, true);
  perform realtime.send(jsonb_build_object('other', r.a), 'friend', 'u:' || r.b::text, true);
  return null;
end $$;
revoke all on function public.msgr_friend_broadcast() from public, anon, authenticated;
drop trigger if exists msgr_friends_broadcast_ins_del on public.msgr_friends;
create trigger msgr_friends_broadcast_ins_del after insert or delete on public.msgr_friends
  for each row execute function public.msgr_friend_broadcast();
drop trigger if exists msgr_friends_broadcast_upd on public.msgr_friends;
create trigger msgr_friends_broadcast_upd after update on public.msgr_friends
  for each row when (old.status is distinct from new.status) execute function public.msgr_friend_broadcast();

-- ── D6 에이전트 넣기 요청(msgr_channel_crew_requests) — 생성·처리를 요청한 사람과 결정할 사람에게.
-- 결정할 사람 = msgr_can_decide_crew_join과 같은 규칙의 집합: 대화방은 결재자(msgr_dm_approver), 채널은 방장
-- (조직의 현재 멤버인 만든 사람·채널 관리자, 조직 관리자 — msgr_is_channel_host). 트리거 안에서는 auth.uid()가 요청자라 함수를 그대로 못 쓴다.
create or replace function public.msgr_crew_join_recipients(ch uuid, requester uuid) returns setof uuid
  language sql stable security definer set search_path = public, pg_temp as $$
    select requester
    union select public.msgr_dm_approver(ch)
    union select h.uid
      from public.msgr_channels c
      cross join lateral (select c.created_by as uid union select unnest(coalesce(c.admin_user_ids, '{}'::uuid[]))) h
      join public.msgr_org_members om on om.org_id = c.org_id and om.user_id = h.uid and om.removed_at is null and (om.expires_at is null or om.expires_at > now())
     where c.id = ch and c.kind <> 'dm'
    union select om.user_id
      from public.msgr_channels c
      join public.msgr_org_members om on om.org_id = c.org_id and om.role in ('owner', 'admin') and om.removed_at is null and (om.expires_at is null or om.expires_at > now())
     where c.id = ch and c.kind <> 'dm'
$$;
revoke all on function public.msgr_crew_join_recipients(uuid, uuid) from public, anon, authenticated;

-- 지울 때(대기 요청을 주인이 방을 나가며 거둠 — 규칙 14 트리거·msgr_crew_leave_channel)도 같은 사람들에게 status 'removed'로 보낸다
-- (분리 검수 LOW 2026-10-02: 방송이 없어 방장 화면의 결재 카드가 남았다). 채널 삭제 연쇄라 채널이 없으면 받는 사람은 요청자뿐이다.
create or replace function public.msgr_crew_join_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare org uuid; r public.msgr_channel_crew_requests; st text;
begin
  if tg_op = 'DELETE' then r := old; st := 'removed'; else r := new; st := new.status; end if;
  select c.org_id into org from public.msgr_channels c where c.id = r.channel_id;
  perform realtime.send(jsonb_build_object('id', r.id, 'channel_id', r.channel_id, 'crew_id', r.crew_id, 'status', st, 'org_id', org), 'crew_join', 'u:' || x::text, true)
    from public.msgr_crew_join_recipients(r.channel_id, r.requested_by) x where x is not null;
  return null;
end $$;
revoke all on function public.msgr_crew_join_broadcast() from public, anon, authenticated;
drop trigger if exists msgr_channel_crew_requests_broadcast_ins on public.msgr_channel_crew_requests;
drop trigger if exists msgr_channel_crew_requests_broadcast_ins_del on public.msgr_channel_crew_requests;
create trigger msgr_channel_crew_requests_broadcast_ins_del after insert or delete on public.msgr_channel_crew_requests
  for each row execute function public.msgr_crew_join_broadcast();
drop trigger if exists msgr_channel_crew_requests_broadcast_upd on public.msgr_channel_crew_requests;
create trigger msgr_channel_crew_requests_broadcast_upd after update on public.msgr_channel_crew_requests
  for each row when (old.status is distinct from new.status) execute function public.msgr_crew_join_broadcast();
