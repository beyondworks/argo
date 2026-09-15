-- DM 채널별 마지막 메시지(폰 DM 탭 "최근 메시지순" 재료, 유건 요청 2026-09-15). 채널당 1행이라 500건 상한(활발한 DM 하나가 목록을 삼키던 문제,
-- 검수 #541 MEDIUM-3)과 created_at 정렬(인덱스 없음, HIGH-2)이 사라진다. security invoker — RLS(msgr_can_read_channel)로 내가 읽는 DM만.
-- (channel_id, id) 인덱스로 채널당 max(id) 한 번, 시각은 서버 created_at(기기 시계와 섞이지 않게 — LOW-7 완화).
create or replace function public.msgr_dm_latest(org uuid)
returns table (channel_id uuid, last_id bigint, last_at timestamptz)
language sql stable security invoker set search_path = public as $$
  select c.id, m.id, m.created_at
  from public.msgr_channels c
  join lateral (select id, created_at from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1) m on true
  where c.org_id = org and c.kind = 'dm' and c.archived_at is null;
$$;
revoke all on function public.msgr_dm_latest(uuid) from public, anon;
grant execute on function public.msgr_dm_latest(uuid) to authenticated;
notify pgrst, 'reload schema';
