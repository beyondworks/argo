-- 푸시 수신자 = 그 채널의 모든 사람(작성자 제외) — 유건 지시 2026-09-12 "모바일이든 데스크탑이든 메시지가 오면 둘 다 알림(다른 메신저처럼)".
-- 이전(DM 상대·답글 원문·스레드 시작자·멘션)은 슬랙의 '멘션만' 기본값이었고, 유건은 모든 메시지 알림을 원한다. 데스크톱(App.jsx)도 같은 규칙으로 맞춘다.
-- 공개 채널 = 조직 구성원 전원(공개 채널엔 사람 멤버 행이 없다), 비공개·DM = msgr_channel_members 의 사람. 음소거는 앱 쪽 설정(다음 단계에서 서버로).
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    select om.user_id as u from public.msgr_channels ch join public.msgr_org_members om on om.org_id = ch.org_id and om.removed_at is null
      where ch.id = m.channel_id and ch.kind = 'public'
    union all
    select cm.member_id from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id
      where ch.id = m.channel_id and ch.kind <> 'public' and cm.member_kind = 'user'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
$$;
