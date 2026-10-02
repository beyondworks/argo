-- 앱 아이콘 배지 한 가지 셈법(유건 제보 2026-10-01: "메시지를 다 읽어도 모바일 앱 아이콘 '1'이 안 사라진다").
-- 원인: 폰 아이콘 숫자를 두 곳이 서로 다른 셈법으로 썼다.
--   · 서버 푸시(aps.badge) = msgr_push_unread_total — DM 안읽음 + 나를 향한 글(멘션·내 글 답글·내 스레드 크루 후속).
--   · 앱(App.jsx setBadge) = 모든 채널 안읽음 합계(공개 채널 잡담 포함, 음소거 제외).
--   iOS는 앱이 앞에 있을 때 받은 푸시의 배지를 적용하지 않는다(푸시 플러그인 willPresent → [] — 시뮬레이터 실측 2026-10-01).
--   그래서 폰에서 읽을 때 서버가 보낸 배지 0은 버려지고, 앱이 마지막으로 쓴 다른 셈법의 숫자가 뒤로 보낸 뒤에도 남았다.
-- 고침: ① 셈법을 채널별 함수 하나(msgr_push_unread_by_channel)로 모으고 합계 함수는 그 합으로 — 푸시와 앱이 같은 정의를 쓴다.
--       ② 앱이 자기 숫자를 읽는 msgr_my_badge()(읽기 전용, 쓰기·pg_net 없음). 채널 id도 돌려줘 Android가 읽은 채널의 트레이 알림을 지운다.
--       ③ 음소거 채널은 뺀다 — 푸시 수신자(msgr_push_recipients)와 앱 안 배지가 이미 빼고 있었고, 배지만 세고 있었다.
-- 본문은 최신 정의(20260927120000_msgr_mute_crew_notify.sql)를 그대로 옮기고 음소거 조건 한 줄만 더했다.
create or replace function public.msgr_push_unread_by_channel(uid uuid)
returns table (channel_id uuid, n int)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, least(99, count(m.id))::int
  from public.msgr_channels c
  left join public.msgr_reads r on r.channel_id = c.id and r.user_id = uid
  join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null and m.kind = 'text'
       and (m.author_user_id is null or m.author_user_id <> uid)
       and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = uid and b.blocked = m.author_user_id))
       and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = uid and b.blocked_crew = m.crew_id))
       and (c.kind = 'dm'
            or m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', uid::text))
            or exists (select 1 from public.msgr_messages p where p.id = m.reply_to and p.author_user_id = uid)
            or (m.author_kind = 'crew' and exists (select 1 from public.msgr_messages p2 where p2.id = m.thread_root and p2.author_user_id = uid)))
  where c.archived_at is null and (
    (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
    or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = c.id and p.user_id = uid and p.muted)
  group by c.id
$$;
revoke all on function public.msgr_push_unread_by_channel(uuid) from public, anon, authenticated;

create or replace function public.msgr_push_unread_total(uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(n), 0)::int from public.msgr_push_unread_by_channel(uid);
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;

-- 내 배지(채널별). 남의 uid는 받지 않는다 — auth.uid()만.
-- n = 아이콘 숫자(위 배지 셈법), unread = 그 채널의 안 읽은 글 수(msgr_unread와 같은 셈법 — 멘션 없는 채널 잡담 포함).
-- Android 트레이는 unread > 0인 채널의 알림만 남긴다. n으로 정하면 멘션 없는 채널 글 알림이 앱을 열기만 해도 지워졌다(분리 검수 MEDIUM 2026-10-02).
-- 행 = 안 읽은 글이 있는 채널(배지 0이어도). 범위는 내가 참여한 방 + 내 조직의 공개 채널, 그중 지금 읽을 수 있는 것(msgr_can_read_channel).
drop function if exists public.msgr_my_badge();
create function public.msgr_my_badge()
returns table (channel_id uuid, n int, unread int)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (select auth.uid() as uid),
  u as (
    select c.id, least(99, count(m.id))::int as unread
      from me
      join public.msgr_channels c on c.archived_at is null
       and ((c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = me.uid and om.removed_at is null))
            or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = me.uid))
      left join public.msgr_reads r on r.channel_id = c.id and r.user_id = me.uid
      join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null
           and (m.author_user_id is null or m.author_user_id <> me.uid)
           and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = me.uid and b.blocked = m.author_user_id))
           and not (m.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = me.uid and b.blocked_crew = m.crew_id))
     where me.uid is not null and public.msgr_can_read_channel(c.id)
     group by c.id
  )
  select coalesce(u.id, b.channel_id), coalesce(b.n, 0), coalesce(u.unread, b.n)
    from u full join public.msgr_push_unread_by_channel((select auth.uid())) b on b.channel_id = u.id
   where (select auth.uid()) is not null
$$;
revoke all on function public.msgr_my_badge() from public, anon;
grant execute on function public.msgr_my_badge() to authenticated;
