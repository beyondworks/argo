-- 친구 숨김(유건 확정 2026-10-02, 폰 셸 v2 4차 피드백): 숨김 = 내 친구 목록·새 채팅·초대 후보에서만 뺀다.
-- 친구 관계·대화·메시지 받기·알림은 그대로이고 상대는 모른다(차단 msgr_user_blocks와 다른 표 — 서버가 아무것도 막지 않는다).
-- 계정에 저장해 모든 기기에 같이 적용된다. 내 행만 읽고(RLS), 쓰기는 아래 RPC로만 한다(직접 insert·update·delete 권한 없음).
-- 같은 값이면 다시 쓰지 않고(on conflict do nothing), 사용자당 500행 상한. 계정·상대가 지워지면 같이 지워진다(cascade).
create table if not exists public.msgr_user_hides (
  owner uuid not null references auth.users (id) on delete cascade,
  hidden uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner, hidden),
  check (owner <> hidden)
);
alter table public.msgr_user_hides enable row level security;
drop policy if exists msgr_user_hides_own on public.msgr_user_hides;
create policy msgr_user_hides_own on public.msgr_user_hides for select to authenticated using (owner = auth.uid());
revoke all on public.msgr_user_hides from public, anon, authenticated;
grant select on public.msgr_user_hides to authenticated;

-- 친구(수락됨)만 숨길 수 있다 — 임의 uuid로 아무나 숨긴 흔적을 남기지 못하게.
create or replace function public.msgr_hide_user(target uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  if target is null or target = me then raise exception 'msgr_hide_invalid' using errcode = '22023'; end if;
  if exists (select 1 from public.msgr_user_hides where owner = me and hidden = target) then return; end if; -- 이미 숨김 — 다시 쓰지 않는다
  if not exists (select 1 from public.msgr_friends f where f.a = least(me, target) and f.b = greatest(me, target) and f.status = 'accepted') then
    raise exception 'msgr_not_friend' using errcode = '42501';
  end if;
  if (select count(*) from public.msgr_user_hides where owner = me) >= 500 then raise exception 'msgr_hide_limit' using errcode = '54000'; end if;
  insert into public.msgr_user_hides (owner, hidden) values (me, target) on conflict do nothing;
end $$;

create or replace function public.msgr_unhide_user(target uuid) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  delete from public.msgr_user_hides where owner = me and hidden = target;
end $$;

create or replace function public.msgr_my_hidden_users()
  returns table (user_id uuid, created_at timestamptz)
  language sql stable security definer set search_path = public, pg_temp as $$
    select h.hidden, h.created_at from public.msgr_user_hides h where h.owner = auth.uid() order by h.created_at desc
$$;

revoke all on function public.msgr_hide_user(uuid) from public, anon; grant execute on function public.msgr_hide_user(uuid) to authenticated;
revoke all on function public.msgr_unhide_user(uuid) from public, anon; grant execute on function public.msgr_unhide_user(uuid) to authenticated;
revoke all on function public.msgr_my_hidden_users() from public, anon; grant execute on function public.msgr_my_hidden_users() to authenticated;
