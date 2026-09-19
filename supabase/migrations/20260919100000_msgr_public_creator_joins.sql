-- 공개 채널도 만든 사람을 참여시킨다(D41, 검수 발견 2026-09-19 — #626 반려 원인).
-- 20260916190000(참여제)부터 공개 채널은 참여 행이 있어야 목록·알림에 뜬다. 그런데 msgr_create_channel은
-- `if kind <> 'public'`일 때만 만든 사람을 넣어, 공개 채널을 만든 사람은 만든 직후 "0명"이고 새로고침하면 목록에서 사라졌다
-- (로컬 실측: "d41 공개 점검" 참여 행 0, 라이브·로컬 함수 md5 0a1dfdd0c237b8d032d1fb686d4de8e0 동일).
-- 처방: 종류와 무관하게 만든 사람을 넣는다. others는 종전처럼 비공개·DM에서만 쓴다(공개는 찾아보기로 스스로 들어온다).
create or replace function public.msgr_create_channel(org uuid, kind text, name text, others jsonb default '[]'::jsonb) returns uuid
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); ch uuid; r jsonb;
begin
  if me is null then raise exception 'msgr_auth_required'; end if;
  if kind not in ('public', 'private', 'dm') then raise exception 'msgr_bad_kind'; end if;
  if not coalesce(public.msgr_role(org) in ('owner', 'admin', 'member'), false) or coalesce(public.msgr_org_locked(org), false) then raise exception 'msgr_forbidden'; end if; -- 역할 NULL(비멤버)은 not(null)=null이라 IF를 통과한다 — coalesce 필수(드릴이 적발)
  insert into public.msgr_channels (org_id, kind, name, created_by) values (org, kind, name, me) returning id into ch; -- 한도·정책 트리거는 그대로 돈다
  insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, 'user', me, me); -- 공개 채널도 만든 사람은 참여(D41)
  if kind <> 'public' then
    for r in select value from jsonb_array_elements(coalesce(others, '[]'::jsonb)) loop
      if (r->>'kind') not in ('user', 'crew') or (r->>'id') is null or not public.msgr_channel_member_ok(ch, r->>'kind', (r->>'id')::uuid) then raise exception 'msgr_bad_member'; end if;
      insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by) values (ch, r->>'kind', (r->>'id')::uuid, me) on conflict do nothing;
    end loop;
  end if;
  return ch;
end $$;
revoke all on function public.msgr_create_channel(uuid, text, text, jsonb) from public;
revoke execute on function public.msgr_create_channel(uuid, text, text, jsonb) from anon;
grant execute on function public.msgr_create_channel(uuid, text, text, jsonb) to authenticated;

-- 이미 이 결함으로 만든 사람이 빠진 공개 채널 복구 — 참여제(2026-09-16) 이후 만든 것만, 만든 사람이 지금 조직 멤버이고 제외되지 않은 경우.
-- 그 전 채널의 참여 여부는 20260916190000 백필 규칙(글쓴이·관리자)이 정한 것이라 건드리지 않는다.
insert into public.msgr_channel_members (channel_id, member_kind, member_id, added_by)
select c.id, 'user', c.created_by, c.created_by
  from public.msgr_channels c
 where c.kind = 'public' and c.archived_at is null and c.org_id is not null and c.created_by is not null
   and c.created_at >= timestamptz '2026-09-16 00:00:00+09'
   and not (c.created_by = any (c.excluded_user_ids))
   and exists (select 1 from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = c.created_by and om.removed_at is null and (om.expires_at is null or om.expires_at > now()))
   and not exists (select 1 from public.msgr_channel_members m where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = c.created_by)
on conflict do nothing;
