-- 오피스 좌측 크루 목록(유건 9/30): 누구의 크루인지, 내가 일을 시킬 수 있는지, 내 고정·순서를 한 번에.
-- · 쓸 수 있는지는 메신저와 같은 판정(msgr_instruct_check — 주인이 정한 허용 범위·조직 정책·크루 상태)을 그대로 쓴다. 오피스만의 규칙은 없다.
-- · 고정·순서는 메신저 '내 에이전트' 레일과 같은 행(msgr_target_prefs: pinned·pin_pos·sort_pos) — 한쪽에서 바꾸면 다른 쪽도 같다.
-- · 읽기만(쓰기 0). 부하: 기록판을 불러올 때 1회(탭 복귀는 1분에 한 번까지) — 조직 수와 상관없이 호출 1번.
create or replace function public.office_crew_list(p_orgs uuid[]) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'org_id', c.org_id, 'owner_user_id', c.owner_user_id, 'display_name', c.display_name,
      'department', c.department, 'role_text', c.role_text, 'face', c.face,
      'owner_name', coalesce(nullif(om.display_name, ''), nullif(pr.display_name, '')),
      'company', public.msgr_crew_is_company(c.id),
      'access', public.msgr_instruct_check(c.id, auth.uid(), null),
      'pinned', coalesce(tp.pinned, false), 'pin_pos', tp.pin_pos, 'sort_pos', tp.sort_pos
    ) order by c.display_name, c.id), '[]'::jsonb)
  from public.msgr_crews c
  left join public.msgr_org_members om on om.org_id = c.org_id and om.user_id = c.owner_user_id
  left join public.msgr_profiles pr on pr.user_id = c.owner_user_id
  left join public.msgr_target_prefs tp on tp.user_id = auth.uid() and tp.org_id = c.org_id and tp.target_kind = 'crew' and tp.target_id = c.id
  where c.org_id = any (coalesce(p_orgs, '{}'::uuid[])) and public.msgr_is_member(c.org_id) -- 크루 표 읽기 규칙(msgr_crews_select)과 같다
$$;
revoke all on function public.office_crew_list(uuid[]) from public, anon;
grant execute on function public.office_crew_list(uuid[]) to authenticated;

-- 고정·순서 쓰기(9/30 분리 검수 반영): 바꾸려는 칸만 쓴다 — 오피스의 오래된 화면 상태가 메신저에서 바꾼 고정을 덮지 않게.
-- 본인 행 RLS(msgr_target_prefs)를 그대로 받도록 security invoker. 쓰기는 사람이 고정을 누르거나 끌어 놓을 때만, 값이 같으면 다시 쓰지 않는다.
--   sort      : 내 크루 직접 배치 — p_ids 순서대로 0..n(메신저 '내 에이전트' 레일과 같은 번호). 새 행은 pinned=false(표 기본값 true 함정)
--   pin_order : 고정 순서 — 이 크루들이 쓰던 번호 칸을 새 순서로 다시 나눈다(채널 즐겨찾기와 섞인 번호는 그대로). 다른 곳에서 고정이 바뀌었으면 crew_prefs_stale
--   pin       : 고정 켜기/끄기 — 켜면 내 즐겨찾기(채널·사람·크루) 맨 뒤 번호
create or replace function public.office_crew_prefs(p_org uuid, p_action text, p_ids uuid[], p_on boolean default null) returns void
language plpgsql security invoker set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); slots int[];
begin
  if me is null or p_org is null or coalesce(cardinality(p_ids), 0) = 0 or cardinality(p_ids) > 500 then raise exception 'crew_prefs_input'; end if;
  if p_action = 'sort' then
    insert into public.msgr_target_prefs as t (user_id, org_id, target_kind, target_id, pinned, sort_pos)
      select me, p_org, 'crew', x.id, false, (x.ord - 1)::int from unnest(p_ids) with ordinality x(id, ord)
      on conflict (user_id, org_id, target_kind, target_id) do update set sort_pos = excluded.sort_pos where t.sort_pos is distinct from excluded.sort_pos;
  elsif p_action = 'pin_order' then
    select array_agg(t.pin_pos order by t.pin_pos) into slots from public.msgr_target_prefs t
      where t.user_id = me and t.org_id = p_org and t.target_kind = 'crew' and t.target_id = any (p_ids) and t.pinned and t.pin_pos is not null;
    if coalesce(cardinality(slots), 0) <> cardinality(p_ids) then raise exception 'crew_prefs_stale'; end if;
    update public.msgr_target_prefs t set pin_pos = s.slot
      from (select x.id, slots[x.ord] slot from unnest(p_ids) with ordinality x(id, ord)) s
      where t.user_id = me and t.org_id = p_org and t.target_kind = 'crew' and t.target_id = s.id and t.pin_pos is distinct from s.slot;
  elsif p_action = 'pin' and p_on is not null and cardinality(p_ids) = 1 then
    insert into public.msgr_target_prefs as t (user_id, org_id, target_kind, target_id, pinned, pin_pos)
      values (me, p_org, 'crew', p_ids[1], p_on, case when p_on then (select coalesce(max(v), -1) + 1 from (
        select pin_pos v from public.msgr_target_prefs where user_id = me and org_id = p_org and pinned
        union all select pin_pos from public.msgr_channel_prefs where user_id = me and pinned) z) end)
      on conflict (user_id, org_id, target_kind, target_id) do update set pinned = excluded.pinned, pin_pos = excluded.pin_pos
        where t.pinned is distinct from excluded.pinned;
  else
    raise exception 'crew_prefs_input';
  end if;
end $$;
revoke all on function public.office_crew_prefs(uuid, text, uuid[], boolean) from public, anon;
grant execute on function public.office_crew_prefs(uuid, text, uuid[], boolean) to authenticated;
notify pgrst, 'reload schema';
