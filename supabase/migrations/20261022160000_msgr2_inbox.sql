-- 메신저 단순화 1단계(2026-10-22 유건 승인 "여기까지 진행했는데, 일단 승인할게 진행해봐") — 대화 목록을 한 번에 읽는 함수 msgr2_inbox.
-- 설계: 볼트 2026-10-22-1500-msgr-simple-structure-design.md "1단계(서버) 작업 기준". 화면은 아직 이 함수를 쓰지 않는다(2단계).
-- 지금 v2 셸은 공간마다 spaces·space_members·rooms·room_members·agents·msgr2_unread를 따로 읽는다(공간 수 × 5~6 요청). 이 함수는 요청 1번으로
-- 내가 들어 있는 모든 방(개인 1:1·여러 명 방·조직 채널)을 한 목록으로 준다. 방마다 주인 표시(조직이면 조직 이름)·마지막 글·안 읽음·고정·음소거.
--
-- 누가 무엇을 받나(판정은 msgr2_access와 같은 결과 — 시험이 방마다 대조한다)
--   · 유효한 기기(_msgr2_need_device — 없으면 msgr2_device_invalid) + Pro(_msgr2_pro_ok — 무료면 msgr2_pro_required 42501, 관문 스위치 msgr2_pro_gate=off면 통과).
--   · 내가 활동 사람 멤버인 방(removed_at null) 중: 보관 안 됨, 공간이 지워지지 않음, 팀 공간이면 그 공간의 활동 멤버(removed_at null·만료 전).
--     → 조직을 나가면(공간 멤버 removed_at) 그 조직 방은 바로 빠진다. 남의 방은 멤버 행이 없어 나오지 않는다.
--   · v2 중단(msgr2_paused) 중이면 빈 결과(msgr2_unread와 같다).
-- 순서·쪽: 고정 먼저, 그다음 마지막 활동(마지막 글 시각, 글이 없으면 방 만든 시각) 최신순, 같으면 방 id 역순. 한 번에 p_limit(1~200, 기본 200)개.
--   다음 쪽은 마지막 행의 (pinned, last_at, room_id)를 p_before_*로 넘긴다. 돌려준 행 수 = p_limit이면 더 있을 수 있다.
-- 안 읽음: msgr2_unread와 같은 규칙(내 읽음 뒤, 지우지 않음, 시스템 글 아님, 내 글 아님, 차단한 사람 글 아님, 99에서 멈춤) — 이 쪽의 행만 센다.
-- 상대(peer): 1:1이면 상대 하나. direct 방, 또는 나 말고 활동 멤버(removed_at null)가 정확히 1명(사람·에이전트)인 private 방 — 에이전트 1:1은
--   msgr2_agent_dm_open이 이름 없는 private 방으로 만든다(20261020200600). 여러 명 방·상대가 나간 방은 null. 값은 그 방의 room_members에서만 온다.
-- 마지막 글 미리보기: 지우지 않고 차단한 사람 글이 아닌 마지막 글의 앞 140자(시스템 글은 본문 대신 kind로 화면이 문구를 고른다).
-- 쓰기 0(stable). 주기 호출을 만들지 않는다 — 화면은 목록을 열 때·앱 시작·복귀 때 1번, 그 뒤는 기존 방송(v2:u:)으로 고친다.
-- 되돌림: scripts/rollback/20261022160000_msgr2_inbox.down.sql · 시험: test/msgr2-inbox-pg.test.mjs

create or replace function public.msgr2_inbox(
    p_limit int default 200,
    p_before_pinned boolean default null,
    p_before_at timestamptz default null,
    p_before_room uuid default null)
  returns table (
    room_id uuid, room_kind text, room_name text,
    space_id uuid, space_kind text, space_name text,
    peer_kind text, peer_id uuid,
    users int, agents int,
    last_id bigint, last_at timestamptz, last_kind text, last_author_kind text, last_author_id uuid, last_preview text,
    unread int, last_read_id bigint, pinned boolean, muted boolean)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._msgr2_need_device();
  blocked uuid[] := public._msgr2_my_blocked(auth.uid());
  lim int := least(greatest(coalesce(p_limit, 200), 1), 200);
begin
  if not public._msgr2_pro_ok(uid) then raise exception 'msgr2_pro_required' using errcode = '42501'; end if;
  if public._msgr2_paused() then return; end if;
  if (p_before_at is null) <> (p_before_room is null) or (p_before_room is not null and p_before_pinned is null) then
    raise exception 'msgr2_inbox_cursor' using errcode = '22023';
  end if;
  return query
    with mine as (
      select r.id, r.kind, r.name, r.created_at, s.id as sid, s.kind as skind, case when s.kind = 'team' then s.name end as sname,
             coalesce(p.pinned, false) as pin, coalesce(p.muted, false) as mute
        from public.msgr2_room_members m
        join public.msgr2_rooms r on r.id = m.room_id and r.archived_at is null
        join public.msgr2_spaces s on s.id = r.space_id and s.deleted_at is null
        left join public.msgr2_prefs p on p.room_id = r.id and p.user_id = uid
       where m.member_kind = 'user' and m.member_id = uid and m.removed_at is null
         and (s.kind = 'personal' or exists (
               select 1 from public.msgr2_space_members sm
                where sm.space_id = s.id and sm.user_id = uid and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())))),
    lastmsg as (
      select mi.*, lm.id as lid, lm.created_at as lat, lm.kind as lkind, lm.author_kind as lak,
             coalesce(lm.author_user_id, lm.author_agent_id) as laid, lm.body as lbody,
             coalesce(lm.created_at, mi.created_at) as act
        from mine mi
        left join lateral (
          select x.id, x.created_at, x.kind, x.author_kind, x.author_user_id, x.author_agent_id, x.body
            from public.msgr2_messages x
           where x.room_id = mi.id and x.deleted_at is null and not coalesce(x.author_user_id = any (blocked), false)
           order by x.id desc limit 1) lm on true),
    page as (
      select * from lastmsg l
       where p_before_room is null
          or (l.pin::int, l.act, l.id) < (p_before_pinned::int, p_before_at, p_before_room)
       order by l.pin desc, l.act desc, l.id desc
       limit lim)
    select pg.id, pg.kind, pg.name,
           pg.sid, pg.skind, pg.sname,
           peer.k, peer.i,
           (select count(*)::int from public.msgr2_room_members c where c.room_id = pg.id and c.member_kind = 'user' and c.removed_at is null),
           (select count(*)::int from public.msgr2_room_members c where c.room_id = pg.id and c.member_kind = 'agent' and c.removed_at is null),
           pg.lid, pg.act, pg.lkind, pg.lak, pg.laid,
           case when pg.lkind = 'system' then null else left(pg.lbody, 140) end,
           (select count(*)::int from (select 1 from public.msgr2_messages x
              where x.room_id = pg.id and x.id > coalesce(rd.last_read_id, 0) and x.deleted_at is null and x.kind <> 'system'
                and x.author_user_id is distinct from uid and not coalesce(x.author_user_id = any (blocked), false)
              order by x.id desc limit 99) z),
           coalesce(rd.last_read_id, 0),
           pg.pin, pg.mute
      from page pg
      left join public.msgr2_reads rd on rd.room_id = pg.id and rd.user_id = uid
      left join lateral (
        select o.k, o.i from (
          select o.member_kind as k, o.member_id as i, count(*) over () as n from public.msgr2_room_members o
           where pg.kind in ('direct', 'private') and o.room_id = pg.id and o.removed_at is null and not (o.member_kind = 'user' and o.member_id = uid)) o
         where pg.kind = 'direct' or o.n = 1
         order by (o.k = 'user') desc, o.i limit 1) peer on true
     order by pg.pin desc, pg.act desc, pg.id desc;
end $$;
revoke all on function public.msgr2_inbox(int, boolean, timestamptz, uuid) from public, anon;
grant execute on function public.msgr2_inbox(int, boolean, timestamptz, uuid) to authenticated;
