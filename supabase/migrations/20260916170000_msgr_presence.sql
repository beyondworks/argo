-- PC를 보고 있는 동안에는 폰 알림을 보내지 않는다(유건 2026-09-16: "양쪽으로 알림 오니까 정신 없다").
--   · 기기가 화면 앞에 있을 때만 심박을 남긴다(창이 보이고 초점이 있을 때). 자리를 뜨면 기록이 낡아 폰 알림이 되살아난다.
--   · 전환은 저절로 일어난다 — 폰을 들면 PC 심박이 멎고, PC로 돌아오면 다시 멎는 쪽이 폰이다.
create table if not exists public.msgr_presence (
  user_id uuid primary key references auth.users (id) on delete cascade,
  source text not null check (source in ('desktop', 'web', 'mobile')), -- 마지막으로 보고 있던 기기 종류
  seen_at timestamptz not null default now()
);
alter table public.msgr_presence enable row level security;
-- 표에는 아무 권한도 주지 않는다 — 심박은 아래 RPC(definer)로만 남긴다. "누가 언제 어느 기기를 보고 있었나"는
-- 조직원끼리도 들여다볼 일이 아니다. 정책은 방어를 한 겹 더 두는 것이고, 실제 차단은 권한 부재가 한다.
drop policy if exists msgr_presence_self on public.msgr_presence;
create policy msgr_presence_self on public.msgr_presence for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- 심박 — 앱이 1분마다 부른다. 값은 한 행이라 쌓이지 않는다.
create or replace function public.msgr_presence_ping(source text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'msgr_auth_required'; end if;
  if source not in ('desktop', 'web', 'mobile') then raise exception 'msgr_bad_source'; end if;
  insert into public.msgr_presence (user_id, source, seen_at) values (me, source, now())
    on conflict (user_id) do update set source = excluded.source, seen_at = excluded.seen_at;
end $$;
revoke all on function public.msgr_presence_ping(text) from public, anon;
grant execute on function public.msgr_presence_ping(text) to authenticated;

-- "지금 PC를 보고 있다" 판정 — 2분 안의 데스크톱·웹 심박. 폰 심박은 여기에 해당하지 않는다(폰을 보고 있으면 폰 알림이 맞다).
create or replace function public.msgr_on_desktop(uid uuid, grace interval default interval '2 minutes') returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
    select exists (select 1 from public.msgr_presence p
                    where p.user_id = uid and p.source in ('desktop', 'web') and p.seen_at > now() - grace)
$$;
grant execute on function public.msgr_on_desktop(uuid, interval) to authenticated, service_role;

-- 푸시 수신자에서 "PC를 보고 있는 사람"을 뺀다. 음소거·작성자 제외 규칙은 종전 그대로다.
create or replace function public.msgr_push_recipients(m public.msgr_messages) returns setof uuid
language sql stable set search_path = public, pg_temp as $$
  select distinct u from (
    select om.user_id as u from public.msgr_channels ch join public.msgr_org_members om on om.org_id = ch.org_id and om.removed_at is null
      where ch.id = m.channel_id and ch.kind = 'public'
    union all
    select cm.member_id from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id
      where ch.id = m.channel_id and ch.kind <> 'public' and cm.member_kind = 'user'
    union all select (x->>'id')::uuid from jsonb_array_elements(coalesce(m.mentions, '[]'::jsonb)) x
      where x->>'kind' = 'user' and (x->>'id') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) s where u is not null and u is distinct from m.author_user_id
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = m.channel_id and p.user_id = s.u and p.muted) -- 음소거는 푸시도 막는다(종전 그대로)
    and not public.msgr_on_desktop(s.u) -- PC 앞이면 그 화면의 배너로 이미 안다(폰 중복 알림 방지)
$$;
