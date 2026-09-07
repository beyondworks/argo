-- 크루 인벤토리(유건 지시 2026-09-07 "슬랙처럼 로그인하면 내 에이전트 목록이 보이고, 채널 만들 때 골라서 초대"):
--  파견 전 크루도 메신저에 보이게 msgr_crews에 세 번째 상태 'available'을 둔다. 아르고 브리지가 하트비트마다 회사의
--  전체 크루(이름·역할·slug만 — 키·모델·기억 없음)를 available로 미러하고, 메신저 "+ 추가 → 내 크루"가 available→active로
--  올리며 채널 멤버로 넣는다(그 자리 파견). 아르고 앱 설정 카드는 세부 조정·해제용으로 남는다.
--  불변식: available 크루는 지시·답글·결재·채널 멤버 어느 것도 못 한다 — 기존 게이트가 전부 status='active'를 보므로 자동.
--  미러 없는 옛 브리지(v0.1.64)는 available 행을 만들지 않을 뿐 다른 동작은 같다.

alter table public.msgr_crews drop constraint if exists msgr_crews_status_check;
alter table public.msgr_crews add constraint msgr_crews_status_check check (status in ('active', 'detached', 'available'));

-- 채널 멤버는 파견(active)된 크루만 — available은 "+ 추가"가 먼저 active로 올린 뒤 넣는다(순서가 어긋나면 서버가 거절).
create or replace function public.msgr_channel_member_ok(ch uuid, kind text, mid uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select case kind
      when 'user' then exists (select 1 from public.msgr_org_members m join public.msgr_channels c on c.id = ch
                                where m.org_id = c.org_id and m.user_id = mid and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))
      when 'crew' then exists (select 1 from public.msgr_crews cr join public.msgr_channels c on c.id = ch where cr.id = mid and cr.org_id = c.org_id and cr.status = 'active')
      else false end
$$;

-- 오프보딩: available도 함께 detached(되살림은 active로만 — 미러가 다음 하트비트에 available을 다시 채운다).
create or replace function public.msgr_member_offboard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    update public.msgr_crews set status = 'detached' where org_id = new.org_id and owner_user_id = new.user_id and status in ('active', 'available');
    delete from public.msgr_channel_members cm using public.msgr_channels c
     where cm.channel_id = c.id and c.org_id = new.org_id
       and ((cm.member_kind = 'user' and cm.member_id = new.user_id)
         or (cm.member_kind = 'crew' and cm.member_id in (select id from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id)));
    perform public.msgr_audit(new.org_id, 'member.offboard', 'user', new.user_id::text, jsonb_build_object('crews_detached', (select count(*) from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached')));
  elsif new.removed_at is null and old.removed_at is not null then
    update public.msgr_crews set status = 'active' where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached';
  end if;
  return new;
end $$;

-- 파견 감사: available → active 전이는 "crew.dispatch", active → available(회수)은 "crew.recall". 소유자 행위(RLS가 소유자만 update).
create or replace function public.msgr_crew_status_audit() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'available' and new.status = 'active' then perform public.msgr_audit(new.org_id, 'crew.dispatch', 'crew', new.id::text, jsonb_build_object('slug', new.slug, 'allow', new.allow));
  elsif old.status = 'active' and new.status = 'available' then perform public.msgr_audit(new.org_id, 'crew.recall', 'crew', new.id::text, jsonb_build_object('slug', new.slug));
  end if;
  return new;
end $$;
drop trigger if exists msgr_crew_status_audit on public.msgr_crews;
create trigger msgr_crew_status_audit after update of status on public.msgr_crews for each row execute function public.msgr_crew_status_audit();
