-- 메신저 v2 U6c-1a — 새 일·일 상태 표지('work' 방송)와 접속 표시 받기 범위 좁히기. 총괄 결정 2026-10-18(#1079 검수 후속).
-- 의존: U2(msgr2_works), U2b(_msgr2_send_u·_msgr2_send_s·_msgr2_room_humans), U6b(_msgr2_fanout·_msgr2_rt_presence_ok). 병합된 앞 파일은 고치지 않는다.
-- 원칙
--   · 글 방송(msg)에는 멘션도 일도 없다. 그래서 @멘션으로 만든 일은 에이전트·시스템 글이 오기 전까지 화면이 몰랐다(카드·v2:wk: 구독·취소 단추 없음).
--     일 행이 생길 때와 state가 바뀔 때만 방의 사람에게 'work' {work}를 보낸다(받는 사람·큰 open 방 규칙 = 글 방송, _msgr2_fanout).
--     리스 연장·결과 표시 같은 다른 열만 바뀐 갱신은 보내지 않는다(유휴 0). 이전 백필은 보내지 않는다(글 방송과 같다).
--     실어 보내는 열 = 사람이 읽을 수 있는 열(U2 열 권한 + U6b 3열)뿐. 지시문(text)·리스 기기·세대는 싣지 않는다.
--   · 접속 표시(v2:pr:<주인>) 받기의 "같은 팀 공간" 길은 둘 다 owner·admin·member일 때만 연다. 손님은 그 주인의 에이전트가 있는 방을 읽을 수 있을 때만 받는다.

-- ── 1. 일 표지 ─────────────────────────────────────────────────────────────────
create or replace function public.msgr2_on_work_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if; -- 이전 백필은 방송하지 않는다
  if tg_op = 'UPDATE' and new.state is not distinct from old.state then return null; end if;              -- 상태가 그대로면 보내지 않는다(트리거 조건과 같은 판정)
  perform public._msgr2_fanout(new.room_id, 'work', jsonb_build_object('work', jsonb_build_object(
    'id', new.id, 'room_id', new.room_id, 'topic_id', new.topic_id, 'agent_id', new.agent_id, 'owner_user_id', new.owner_user_id,
    'from_kind', new.from_kind, 'from_id', new.from_id, 'root_user_id', new.root_user_id, 'source_message_id', new.source_message_id,
    'parent_work_id', new.parent_work_id, 'state', new.state, 'expires_at', new.expires_at, 'lease_until', new.lease_until,
    'has_result', new.has_result, 'late', new.late, 'error_code', new.error_code, 'created_at', new.created_at, 'updated_at', new.updated_at)));
  return null;
end $$;
drop trigger if exists msgr2_on_work_insert_broadcast on public.msgr2_works;
create trigger msgr2_on_work_insert_broadcast after insert on public.msgr2_works for each row execute function public.msgr2_on_work_broadcast();
drop trigger if exists msgr2_on_work_state_broadcast on public.msgr2_works;
create trigger msgr2_on_work_state_broadcast after update of state on public.msgr2_works for each row
  when (new.state is distinct from old.state) execute function public.msgr2_on_work_broadcast();
revoke all on function public.msgr2_on_work_broadcast() from public, anon, authenticated;

-- ── 2. 접속 표시 받기 범위 ─────────────────────────────────────────────────────
create or replace function public._msgr2_rt_presence_ok(p_topic text, p_op text) returns boolean
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); owner uuid;
begin
  if uid is null or p_topic is null or p_topic !~* '^v2:pr:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  owner := split_part(p_topic, ':', 3)::uuid;
  if p_op = 'track' then
    return owner = uid and coalesce(public._msgr2_device_kind() in ('runner', 'resident'), false);
  end if;
  if not public._msgr2_device_ok() then return false; end if;
  if owner = uid then return true; end if;
  -- 같은 팀 공간의 활동 멤버(둘 다 owner·admin·member — 손님 자리는 이 길을 쓰지 않는다)
  if exists (select 1 from public.msgr2_space_members a join public.msgr2_space_members b on b.space_id = a.space_id
               join public.msgr2_spaces s on s.id = a.space_id and s.kind = 'team' and s.deleted_at is null
              where a.user_id = uid and b.user_id = owner
                and a.role in ('owner', 'admin', 'member') and b.role in ('owner', 'admin', 'member')
                and a.removed_at is null and (a.expires_at is null or a.expires_at > now())
                and b.removed_at is null and (b.expires_at is null or b.expires_at > now())) then
    return true;
  end if;
  -- 그 주인의 에이전트가 있는 방을 읽을 수 있다(손님·개인 공간의 친구 방 등)
  return exists (select 1 from public.msgr2_room_members m join public.msgr2_agents ag on ag.id = m.member_id
                  where m.member_kind = 'agent' and m.removed_at is null and ag.owner_user_id = owner
                    and coalesce((public.msgr2_access(m.room_id)).read, false));
end $$;
revoke all on function public._msgr2_rt_presence_ok(text, text) from public, anon;
grant execute on function public._msgr2_rt_presence_ok(text, text) to authenticated;

notify pgrst, 'reload schema';
