-- 폰 아이콘 배지(유건 제보 2026-09-12 "모바일에서는 붉은 뱃지로 메시지 수가 안 쌓여") — 푸시마다 수신자의 안읽음 총계를 aps.badge 로 싣는다.
-- msgr_unread(org)는 security invoker(auth.uid) + 조직 단위라 엣지(서비스 롤)가 못 쓴다 → 사용자 id를 받는 정의자 함수. 규칙은 msgr_unread 와 같다
-- (내 글·삭제 글 제외, 채널당 99 상한), 읽을 수 있는 채널 = 공개(조직 구성원) 또는 사람 멤버인 비공개·DM. 모든 조직 합산.
create or replace function public.msgr_push_unread_total(uid uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(sum(n), 0)::int from (
    select least(99, count(m.id)) as n
    from public.msgr_channels c
    left join public.msgr_reads r on r.channel_id = c.id and r.user_id = uid
    join public.msgr_messages m on m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0) and m.deleted_at is null and m.kind = 'text'
         and (m.author_user_id is null or m.author_user_id <> uid)
    where c.archived_at is null and (
      (c.kind = 'public' and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = uid and om.removed_at is null))
      or exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = uid))
    group by c.id
  ) s;
$$;
revoke all on function public.msgr_push_unread_total(uuid) from public, anon, authenticated;
