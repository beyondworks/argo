-- 게이트웨이 깨우기 — 에이전트가 새로 일하게 되거나 주인이 조직에 들어오면 주인의 u:<uid> 토픽으로 'crew_sync' 방송(#943, 유건 10/11 "어떤 경우에도 지금보다 답이 늦으면 안 된다").
-- 이유: 게이트웨이(src/gateway/msgr.mjs startMsgrBridge)는 Realtime 구독이 모두 붙어 있으면 15초 조회 대신 방송으로만 깨어난다. 새 글·결재·크루 요청은 이미 방송이 있지만,
--   ① 에이전트가 active가 되는 일(새 파견 insert, 재개 paused → active(#941 _msgr_crew_plan_resume), 메신저에서 다시 파견 available → active, 되살림 detached → active)과
--   ② 주인이 조직에 들어오는 일(초대 수락 insert, 다시 들어옴 removed_at → null)은 방송이 없어, 게이트웨이가 그 조직 토픽을 구독하거나 새 조직에 파견하는 일이 예비 조회(2분)까지 늦었다(종전 15초).
-- 게이트웨이는 crew_sync를 받으면 바로 전체 조회(관리 작업 = 미러 파견 + 에이전트 목록 + 구독 갱신)를 한다. 옛 게이트웨이는 모르는 이벤트라 무시한다(무해).
-- 게이트웨이는 msgr_gateway_wake_protocol()이 있을 때만 쉬는 주기를 쓴다 — 이 마이그레이션 적용 전 서버에서는 종전 15초 조회 그대로(배포 순서와 무관하게 늦어지지 않게).
-- 부하: 이벤트는 위 상태 변화 때만(심박·이름 바꾸기 등 다른 update는 트리거 조건에서 빠진다 — status 열·WHEN). 방송 1건 = realtime.messages 1행(Realtime이 보존 기간으로 지운다).
-- 페이로드는 id만(이름·직무 같은 내용은 싣지 않는다).

create or replace function public.msgr_crew_wake_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.owner_user_id is not null then
    perform realtime.send(jsonb_build_object('crew_id', new.id, 'org_id', new.org_id), 'crew_sync', 'u:' || new.owner_user_id::text, true);
  end if;
  return null;
end $$;
revoke all on function public.msgr_crew_wake_broadcast() from public, anon, authenticated;

drop trigger if exists msgr_crews_wake_ins on public.msgr_crews;
create trigger msgr_crews_wake_ins after insert on public.msgr_crews
  for each row when (new.status = 'active') execute function public.msgr_crew_wake_broadcast();
drop trigger if exists msgr_crews_wake_upd on public.msgr_crews;
create trigger msgr_crews_wake_upd after update of status on public.msgr_crews
  for each row when (new.status = 'active' and old.status is distinct from new.status) execute function public.msgr_crew_wake_broadcast();

create or replace function public.msgr_member_wake_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform realtime.send(jsonb_build_object('org_id', new.org_id), 'crew_sync', 'u:' || new.user_id::text, true);
  return null;
end $$;
revoke all on function public.msgr_member_wake_broadcast() from public, anon, authenticated;

drop trigger if exists msgr_members_wake_ins on public.msgr_org_members;
create trigger msgr_members_wake_ins after insert on public.msgr_org_members
  for each row when (new.removed_at is null) execute function public.msgr_member_wake_broadcast();
drop trigger if exists msgr_members_wake_upd on public.msgr_org_members;
create trigger msgr_members_wake_upd after update of removed_at on public.msgr_org_members
  for each row when (old.removed_at is not null and new.removed_at is null) execute function public.msgr_member_wake_broadcast();

-- 게이트웨이가 쉬는 주기를 써도 되는지(위 방송이 있는 서버인지) 묻는 표지. 기기 프로세스마다 10분에 한 번 부른다.
create or replace function public.msgr_gateway_wake_protocol() returns int
  language sql immutable set search_path = public, pg_temp as $$ select 1 $$;
revoke all on function public.msgr_gateway_wake_protocol() from public, anon;
grant execute on function public.msgr_gateway_wake_protocol() to authenticated;
