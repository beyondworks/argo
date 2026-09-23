-- 채널·조직 기억 경계(유건 결정 2026-09-24): 채널 기억은 채널·조직에서 나간 사람이 다시 볼 수 없고, 예외는 조직장(1:1 대화 제외)과 채널장이다.
-- 표 권한(msgr_docs_select)은 넓히지 않는다: 구버전 앱의 미러(syncOrgDocs)가 사용자 권한으로 이 표를 읽어 PC의 vault/org/로 내려받고,
-- 그 사본이 다른 채널 에이전트의 프롬프트로 들어간다(설계 검수 H2). 장의 열람은 이 RPC로만 — 메신저 기억 화면이 부른다.

-- 장 판정: 1:1 대화가 아닌 조직 채널에서 조직장(owner·admin)이거나, member 이상 역할의 채널장(admin_user_ids — 게스트 제외, 검수 H1).
create or replace function public.msgr_is_chief(ch uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_channels c
                    where c.id = ch and c.kind in ('public', 'private') and c.org_id is not null
                      and (public.msgr_role(c.org_id) in ('owner', 'admin')
                           or (auth.uid() = any (c.admin_user_ids) and public.msgr_role(c.org_id) = 'member')))
$$;
revoke all on function public.msgr_is_chief(uuid) from public, anon;
grant execute on function public.msgr_is_chief(uuid) to authenticated;

-- 장만 볼 수 있는 채널 문서 — 일반 권한(msgr_can_read_channel)으로 이미 읽히는 채널은 빼고, 채널 이름·종류를 같이 준다(표 권한으로는 그 채널 행이 안 보여
-- 기억 화면이 '삭제된 채널'로 그리던 것 — 검수 M2). journal=true면 일지만 최신순, false면 일지 외 문서를 경로순. 상한 lim(최대 400).
create or replace function public.msgr_chief_docs(org uuid, journal boolean default false, lim int default 400) returns setof jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
    select to_jsonb(d) || jsonb_build_object('channel_name', c.name, 'channel_kind', c.kind)
      from public.msgr_org_docs d join public.msgr_channels c on c.id = d.channel_id
     where d.org_id = org and c.org_id = org and public.msgr_is_chief(c.id) and not public.msgr_can_read_channel(c.id)
       and (case when journal then d.path like 'journal/%' else d.path not like 'journal/%' end)
     order by case when journal then d.updated_at end desc, d.path
     limit least(greatest(coalesce(lim, 400), 1), 400)
$$;
revoke all on function public.msgr_chief_docs(uuid, boolean, int) from public, anon;
grant execute on function public.msgr_chief_docs(uuid, boolean, int) to authenticated;

-- 오프보딩이 채널장 표시도 지운다 — 남겨 두면 조직에 다시 들어오는 순간 옛 채널 기억이 장 예외로 열린다(검수 M1).
-- 본문은 20260907120000_msgr_crew_inventory.sql 그대로 + 채널장 표시 제거 한 줄.
create or replace function public.msgr_member_offboard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.removed_at is not null and old.removed_at is null then
    update public.msgr_crews set status = 'detached' where org_id = new.org_id and owner_user_id = new.user_id and status in ('active', 'available');
    delete from public.msgr_channel_members cm using public.msgr_channels c
     where cm.channel_id = c.id and c.org_id = new.org_id
       and ((cm.member_kind = 'user' and cm.member_id = new.user_id)
         or (cm.member_kind = 'crew' and cm.member_id in (select id from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id)));
    -- 본인 계정 삭제(msgr_delete_me)도 이 사슬을 탄다 — 채널장 검사의 '만든 사람·관리자만' 판정은 떠난 사람만 빼는 이 제거에 걸지 않는다(아래 가드의 데이터 조건)
    update public.msgr_channels set admin_user_ids = array_remove(admin_user_ids, new.user_id) where org_id = new.org_id and new.user_id = any (admin_user_ids);
    perform public.msgr_audit(new.org_id, 'member.offboard', 'user', new.user_id::text, jsonb_build_object('crews_detached', (select count(*) from public.msgr_crews where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached')));
  elsif new.removed_at is null and old.removed_at is not null then
    update public.msgr_crews set status = 'active' where org_id = new.org_id and owner_user_id = new.user_id and status = 'detached';
  end if;
  return new;
end $$;

-- 채널장 검사는 **새로 추가된** 채널장만 본다 — 남는 채널장 전원을 다시 검사하면, 채널을 나간 채널장(장 예외)이나 만료된 채널장이 남은 채널에서
-- 다른 사람을 조직에서 내보내는 오프보딩(위 array_remove)이 실패했다(검수 #691 HIGH-1). 본문은 20260903120000_msgr.sql 그대로 + 두 검사에 u <> all(old) 조건.
create or replace function public.msgr_channel_admins_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.admin_user_ids is distinct from old.admin_user_ids then
    -- 떠난 사람을 빼기만 하는 변경(오프보딩의 array_remove — AFTER 트리거라 removed_at이 이미 찍혀 있다)은 사용자 판정을 건너뛴다.
    -- GUC 표지·pg_trigger_depth는 SQL을 직접 쓰는 사용자가 위조할 수 있어(임시 표 트리거로 depth 2 — 재검 #691 실증) 데이터 조건으로만 연다.
    if auth.uid() is not null
       and not (new.admin_user_ids <@ old.admin_user_ids
                and not exists (select 1 from unnest(old.admin_user_ids) u where u <> all (new.admin_user_ids)
                                  and exists (select 1 from public.msgr_org_members m where m.org_id = old.org_id and m.user_id = u and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))))
       and not (old.created_by = auth.uid() or coalesce(public.msgr_is_admin(old.org_id), false)) then raise exception 'msgr_channel_admins_owner_only'; end if;
    if exists (select 1 from unnest(new.admin_user_ids) u where u <> all (old.admin_user_ids) and not exists (select 1 from public.msgr_org_members m where m.org_id = old.org_id and m.user_id = u and m.removed_at is null and (m.expires_at is null or m.expires_at > now()))) then raise exception 'msgr_channel_admin_not_member'; end if;
    if old.kind = 'private' and exists (select 1 from unnest(new.admin_user_ids) u where u <> all (old.admin_user_ids) and not exists (select 1 from public.msgr_channel_members cm where cm.channel_id = old.id and cm.member_kind = 'user' and cm.member_id = u)) then raise exception 'msgr_channel_admin_not_channel_member'; end if;
    perform public.msgr_audit(old.org_id, 'channel.admins', 'channel', old.id::text, jsonb_build_object('admins', new.admin_user_ids));
  end if;
  return new;
end $$;

notify pgrst, 'reload schema';
