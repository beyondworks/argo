-- 결재 확정권은 현재 멤버에게만 — 방어를 두 겹으로(검수 #605 지적, 워커 재현 2026-09-18).
-- 재현: 조직에서 제거된 지정 결재권자·만료 게스트·제거된 크루 소유자에게 msgr_can_decide가 true였다. 확정 UPDATE는 SELECT 정책
-- (msgr_can_read_channel → msgr_role이 removed_at·expires_at을 본다)이 행을 가려 0행으로 끝났지만, 막는 곳이 그 한 겹뿐이었다.
-- 라이브(2026-09-18 읽기): approvers 모드 조직 0, approver 목록이 있는 조직 0, pending 결재 0 — 데이터 영향 없음.

-- ① 판정 자체가 현재 멤버를 본다. approvers 갈래는 역할 owner·admin·member만(게스트는 확정권 없음 — 총괄 결정).
create or replace function public.msgr_can_decide(ap uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(public.msgr_is_member(a.org_id) and case
      when a.risk = 'low' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'owner' then c.owner_user_id = auth.uid()
      when coalesce(p.approval_high_by, 'admin') = 'approvers' then coalesce(public.msgr_is_admin(a.org_id), false)
        or (public.msgr_role(a.org_id) in ('owner', 'admin', 'member') and auth.uid() = any (coalesce(p.approver_user_ids, '{}'::uuid[])))
      else public.msgr_is_admin(a.org_id)
    end, false)
      from public.msgr_crew_approvals a
      join public.msgr_crews c on c.id = a.crew_id
      left join public.msgr_org_policies p on p.org_id = a.org_id
     where a.id = ap
$$;

-- ② 확정 정책의 크루 소유자 갈래(pending 유지 갱신 — 브리지의 카드 링크)도 현재 멤버만. 나머지는 20260903120000 정의 그대로.
drop policy if exists msgr_approvals_decide on public.msgr_crew_approvals;
create policy msgr_approvals_decide on public.msgr_crew_approvals for update to authenticated
  using (status = 'pending' and (public.msgr_can_decide(id)
         or (public.msgr_is_member(org_id) and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))))
  with check ((status = 'pending' and decided_by is null
                and public.msgr_is_member(org_id)
                and exists (select 1 from public.msgr_crews c where c.id = msgr_crew_approvals.crew_id and c.owner_user_id = (select auth.uid())))
           or (status in ('approved', 'rejected', 'expired') and decided_by = (select auth.uid()) and public.msgr_can_decide(id)));

-- ③ 떠나면 목록에서도 빠진다 — 제거(removed_at)·게스트 강등·행 삭제. 감사를 남긴다. 만료는 게스트에게만 있고 게스트는 ④가 목록에 못 넣는다.
create or replace function public.msgr_approvers_prune() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare o uuid; u uuid; why text;
begin
  if tg_op = 'DELETE' then o := old.org_id; u := old.user_id; why := 'deleted';
  elsif new.removed_at is not null and old.removed_at is null then o := new.org_id; u := new.user_id; why := 'removed';
  elsif new.role = 'guest' and old.role is distinct from 'guest' then o := new.org_id; u := new.user_id; why := 'guest';
  else return coalesce(new, old); end if;
  update public.msgr_org_policies set approver_user_ids = array_remove(approver_user_ids, u)
   where org_id = o and u = any (approver_user_ids);
  if found then perform public.msgr_audit(o, 'policy.approver.pruned', 'user', u::text, jsonb_build_object('reason', why)); end if;
  return coalesce(new, old);
end $$;
drop trigger if exists msgr_approvers_prune on public.msgr_org_members;
create trigger msgr_approvers_prune after update or delete on public.msgr_org_members for each row execute function public.msgr_approvers_prune();

-- ④ 새로 넣는 결재권자는 현재 멤버(owner·admin·member)여야 한다. 이미 있던 항목은 다시 검사하지 않는다 — 남은 항목 하나 때문에 저장이 막히지 않게.
--    오류 코드 msgr_approver_not_member → 앱 friendlyErr가 set.policy.approverNotMember로 옮긴다.
create or replace function public.msgr_approvers_check() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare added uuid[];
begin
  added := array(select x from unnest(coalesce(new.approver_user_ids, '{}'::uuid[])) x
                  except select y from unnest(case when tg_op = 'UPDATE' then coalesce(old.approver_user_ids, '{}'::uuid[]) else '{}'::uuid[] end) y);
  if exists (select 1 from unnest(added) x where not exists (
       select 1 from public.msgr_org_members m where m.org_id = new.org_id and m.user_id = x and m.removed_at is null
          and (m.expires_at is null or m.expires_at > now()) and m.role in ('owner', 'admin', 'member'))) then
    raise exception 'msgr_approver_not_member' using errcode = '23514';
  end if;
  return new;
end $$;
drop trigger if exists msgr_approvers_check on public.msgr_org_policies;
create trigger msgr_approvers_check before insert or update of approver_user_ids on public.msgr_org_policies for each row execute function public.msgr_approvers_check();
