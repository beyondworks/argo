-- 되돌림: supabase/migrations/20261018060000_msgr2_work_signal.sql(U6c-1a — 일 표지 방송·접속 표시 받기 범위)을 걷어 낸다. 표는 만들지 않았다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U6c-1a → U6b → U2b → U2 → U3 → U1.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261018060000_msgr2_work_signal.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop trigger if exists msgr2_on_work_insert_broadcast on public.msgr2_works;
drop trigger if exists msgr2_on_work_state_broadcast on public.msgr2_works;
drop function if exists public.msgr2_on_work_broadcast();
-- 접속 표시 받기: U6b 정의(20261018020000)로 되돌린다(같은 팀 길에 역할 조건 없음)
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
  -- 같은 팀 공간의 활동 멤버(둘 다)
  if exists (select 1 from public.msgr2_space_members a join public.msgr2_space_members b on b.space_id = a.space_id
               join public.msgr2_spaces s on s.id = a.space_id and s.kind = 'team' and s.deleted_at is null
              where a.user_id = uid and b.user_id = owner
                and a.removed_at is null and (a.expires_at is null or a.expires_at > now())
                and b.removed_at is null and (b.expires_at is null or b.expires_at > now())) then
    return true;
  end if;
  -- 그 주인의 에이전트가 있는 방을 읽을 수 있다(개인 공간의 친구 방 등)
  return exists (select 1 from public.msgr2_room_members m join public.msgr2_agents ag on ag.id = m.member_id
                  where m.member_kind = 'agent' and m.removed_at is null and ag.owner_user_id = owner
                    and coalesce((public.msgr2_access(m.room_id)).read, false));
end $$;
revoke all on function public._msgr2_rt_presence_ok(text, text) from public, anon;
grant execute on function public._msgr2_rt_presence_ok(text, text) to authenticated;
notify pgrst, 'reload schema';
commit;
