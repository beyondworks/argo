-- 폰 채널 탭 줄(유건 확정 2026-10-01 — 카톡 오픈채팅 모양: 인원 수·마지막 글·시각) 재료.
-- 고른 조직에서 **내가 참여한** 채널(공개·비공개, 1:1·그룹 대화 제외 — 그건 msgr_dm_latest)마다 한 행:
-- 마지막 글 id·시각(삭제 글 제외, 글이 없으면 null)과 참여한 사람 수.
-- security invoker — 행도 인원 수도 RLS(msgr_can_read_channel)를 그대로 지난다. 읽기만 한다(쓰기 0).
-- 부르는 때: 폰에서 조직 목록을 불러올 때 한 번(조직 전환·재연결 포함). 주기 호출 없음 — 새 글은 방송으로 줄만 갱신한다.
-- 비용: 참여 채널 수 N개 × (마지막 글 id 역순 1행 + 참여 행 수 세기). msgr_dm_latest와 같은 lateral 모양.
create or replace function public.msgr_channel_latest(org uuid)
returns table (channel_id uuid, last_id bigint, last_at timestamptz, members int)
language sql stable security invoker set search_path = public as $$
  select c.id, m.id, m.created_at,
         (select count(*)::int from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user')
  from public.msgr_channels c
  left join lateral (select x.id, x.created_at from public.msgr_messages x
                      where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1) m on true
  where c.org_id = org and c.kind <> 'dm' and c.archived_at is null
    and exists (select 1 from public.msgr_channel_members me
                 where me.channel_id = c.id and me.member_kind = 'user' and me.member_id = auth.uid());
$$;
revoke all on function public.msgr_channel_latest(uuid) from public, anon;
grant execute on function public.msgr_channel_latest(uuid) to authenticated;
notify pgrst, 'reload schema';
