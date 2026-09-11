-- 채널 범위 강제(유건 지시 2026-09-11): 채널에 초대된 에이전트만 답한다. 비공개·DM = 구성원 행이 있어야, 공개 = 제외 목록에 없어야.
-- 앱의 멘션 후보만 고치면 반쪽이다 — 옛 클라이언트·노드·봇 어느 경로로 오든 서버 트리거가 크루 글의 삽입 자체를 거부한다.
create or replace function public.msgr_crew_in_channel(ch uuid, crew uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (
      select 1 from public.msgr_channels c join public.msgr_crews cr on cr.id = crew and cr.org_id = c.org_id
       where c.id = ch and (
         (c.kind = 'public' and not (crew = any (c.excluded_crew_ids)))
         or (c.kind <> 'public' and exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'crew' and m.member_id = crew))
       )
    )
$$;
revoke all on function public.msgr_crew_in_channel(uuid, uuid) from public;
grant execute on function public.msgr_crew_in_channel(uuid, uuid) to authenticated;

create or replace function public.msgr_messages_crew_scope_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.author_kind = 'crew' and new.crew_id is not null and not public.msgr_crew_in_channel(new.channel_id, new.crew_id) then
    raise exception 'msgr_crew_not_in_channel' using errcode = '42501', hint = '이 채널에 초대되지 않았거나 내보낸 에이전트입니다';
  end if;
  return new;
end $$;
drop trigger if exists msgr_messages_crew_scope on public.msgr_messages;
create trigger msgr_messages_crew_scope before insert on public.msgr_messages for each row execute function public.msgr_messages_crew_scope_guard();
