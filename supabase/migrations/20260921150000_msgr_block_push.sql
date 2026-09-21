-- 차단한 사람의 글은 푸시하지 않는다(2026-09-21, App Store 1.2 후속). 앱은 대화·인용·알림함·검색에서 가리고, 서버는 알림을 막는다.
-- 종전 정의(20260916190000_msgr_channel_join.sql)에 차단 조건 한 줄만 더했다. 호출은 security definer(트리거·msgr_push_recipients_of)뿐이라 msgr_user_blocks를 읽을 수 있다.
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    -- 공개 채널도 채널 멤버 기준(종전에는 조직원 전원이었다 — 안 들어간 채널의 알림까지 갔다)
    select cm.member_id as u from public.msgr_channel_members cm
      where cm.channel_id = m.channel_id and cm.member_kind = 'user'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = m.channel_id and p.user_id = s.u and p.muted)
    and not public.msgr_on_desktop(s.u) -- PC 앞이면 그 화면의 배너로 이미 안다
    and not (m.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = s.u and b.blocked = m.author_user_id))
$$;
