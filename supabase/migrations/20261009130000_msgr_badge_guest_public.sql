-- 앱 아이콘 배지 숫자의 채널 범위를 푸시 수신자 판정과 맞춘다(H43, 2026-10-08 점검 — #846 후속, LOW).
-- 원인: msgr_push_unread_by_channel(배지 셈법 한 곳, msgr_push_unread_total·msgr_my_badge가 이 함수를 쓴다)의 채널 범위가
--   ① 공개 채널 갈래 — 조직 멤버 행에 removed_at만 봤다. 역할(게스트)·만료(expires_at)·조직 삭제·제외 목록(excluded_user_ids)을 보지 않았다.
--   ② 참여 행 갈래 — 참여 행만 봤다. 조직에서 나갔거나 만료된 사람, 공개 채널 참여 행만 남은 게스트도 셌다.
--   그래서 공개 채널을 못 읽는 게스트·만료 멤버·제외된 사람에게 그 채널 멘션이 아이콘 숫자로 잡혔다(본문은 나가지 않는다).
--   그 채널은 열 수 없으니 읽음 처리로도 숫자가 줄지 않는다.
-- 처방: 범위 조건만 msgr_push_recipients(20261006160000 4절)의 수신자 판정 = msgr_can_read_channel을 uid 기준으로 옮긴 것과 같게 바꾼다.
--   조직 삭제 안 됨, removed_at 없음, expires_at 지나지 않음 / 공개 채널은 역할 owner·admin·member이고 excluded_user_ids에 없음 /
--   참여 행 갈래는 조직 없는 방(개인 1:1)이면 그대로, 조직 방이면 그 조직의 살아 있는 멤버, 공개 채널이면 게스트 제외.
--   읽을 수 있는 사람의 셈(멘션·내 글 답글·내 스레드 크루 후속·DM 전체·음소거·차단·보관 채널 제외)은 한 글자도 바꾸지 않는다.
-- 정의 출처: 20261001150000_msgr_my_badge.sql(이 함수의 마지막 정의). 시그니처·반환 모양·security definer·search_path·권한은 그대로다.
--   msgr_push_unread_total(합계)·msgr_my_badge(앱 읽기)는 이 함수를 부르기만 하므로 다시 정의하지 않는다.
-- 시험: test/msgr-badge-guest-public-pg.test.mjs (이 파일 적용 전 빨강 → 적용 뒤 초록, 배지 범위 = 그 사람으로 msgr_can_read_channel 표)
-- 부하: 주기 작업·새 표·새 쓰기·새 호출 없음. 채널 범위 판정에서 조직 멤버 기본 키 + 조직 기본 키 조회가 채널마다 최대 1~2회 늘어난다.
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
    -- 공개 채널: 그 조직의 살아 있는 owner·admin·member이고 제외 목록에 없는 사람(msgr_can_read_channel 공개 갈래)
    (c.kind = 'public' and c.org_id is not null and not (uid = any (c.excluded_user_ids))
     and exists (select 1 from public.msgr_org_members om join public.msgr_orgs o on o.id = om.org_id and o.deleted_at is null
                  where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null
                    and (om.expires_at is null or om.expires_at > now()) and om.role in ('owner', 'admin', 'member')))
    -- 참여 행: 조직 없는 방은 그대로, 조직 방은 그 조직의 살아 있는 멤버, 공개 채널 참여 행만 남은 게스트는 제외(msgr_can_read_channel 참여 갈래)
    or (exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid)
        and (c.org_id is null
             or exists (select 1 from public.msgr_org_members om join public.msgr_orgs o on o.id = om.org_id and o.deleted_at is null
                         where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null
                           and (om.expires_at is null or om.expires_at > now())
                           and (c.kind <> 'public' or om.role in ('owner', 'admin', 'member'))))))
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = c.id and p.user_id = uid and p.muted)
  group by c.id
$$;
revoke all on function public.msgr_push_unread_by_channel(uuid) from public, anon, authenticated;
