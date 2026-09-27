-- App Store 심사 대응(2026-09-26, 1.2 UGC): 사람만 차단할 수 있었다 — 크루(AI 에이전트)·봇도 사용자 쪽에서 숨길(뮤트) 수 있어야 한다.
-- 저장 위치는 기존 사람 차단 구조(msgr_user_blocks)를 재사용한다 — 새 표를 만들지 않고 blocked_crew 열을 더해 대상이
-- 사람(blocked) 또는 크루(blocked_crew) 둘 중 하나이게 한다(xor). 뮤트는 그 사용자 화면에서만 걸러지고(다른 멤버는 그대로 본다),
-- 설정에서 목록을 보고 되돌릴 수 있다.
alter table public.msgr_user_blocks drop constraint if exists msgr_user_blocks_pkey;
alter table public.msgr_user_blocks alter column blocked drop not null;
alter table public.msgr_user_blocks add column if not exists blocked_crew uuid references public.msgr_crews(id) on delete cascade;
alter table public.msgr_user_blocks add constraint msgr_user_blocks_target_xor check ((blocked is not null) <> (blocked_crew is not null));
create unique index if not exists msgr_user_blocks_user_uniq on public.msgr_user_blocks (blocker, blocked) where blocked is not null;
create unique index if not exists msgr_user_blocks_crew_uniq on public.msgr_user_blocks (blocker, blocked_crew) where blocked_crew is not null;

-- 검수 L4(2026-09-27): 내가 속한 조직이나(활성 멤버) 내가 읽을 수 있는 대화에 보이는 크루만 숨길 수 있다 — 임의 uuid로
-- 아무 크루나 숨겼다는 흔적을 남기지 못하게. 검수 L5: 내 크루는 숨길 수 없다(내 크루 답을 내가 못 보면 오작동으로 보인다).
create or replace function public.msgr_mute_crew(crew uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); c public.msgr_crews;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into c from public.msgr_crews where id = crew;
  if c.id is null then raise exception 'msgr_crew_not_found' using errcode = '22023'; end if;
  if c.owner_user_id = me then raise exception 'msgr_crew_mute_own' using errcode = '42501'; end if;
  if not (
    exists (select 1 from public.msgr_org_members m where m.org_id = c.org_id and m.user_id = me and m.removed_at is null)
    or exists (select 1 from public.msgr_channel_members cm where cm.member_kind = 'crew' and cm.member_id = crew and public.msgr_can_read_channel(cm.channel_id))
  ) then raise exception 'msgr_crew_not_visible' using errcode = '42501'; end if;
  insert into public.msgr_user_blocks (blocker, blocked_crew) values (me, crew) on conflict do nothing;
end $$;

create or replace function public.msgr_unmute_crew(crew uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  delete from public.msgr_user_blocks where blocker = me and blocked_crew = crew;
end $$;

create or replace function public.msgr_my_muted_crews()
  returns table (crew_id uuid, display_name text, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select k.blocked_crew, coalesce(c.display_name, ''), k.created_at
      from public.msgr_user_blocks k
      join public.msgr_crews c on c.id = k.blocked_crew
     where k.blocker = auth.uid() and k.blocked_crew is not null
     order by k.created_at desc
$$;

revoke all on function public.msgr_mute_crew(uuid) from public, anon; grant execute on function public.msgr_mute_crew(uuid) to authenticated;
revoke all on function public.msgr_unmute_crew(uuid) from public, anon; grant execute on function public.msgr_unmute_crew(uuid) to authenticated;
revoke all on function public.msgr_my_muted_crews() from public, anon; grant execute on function public.msgr_my_muted_crews() to authenticated;
