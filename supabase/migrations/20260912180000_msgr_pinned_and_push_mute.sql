-- 즐겨찾기(채널·DM 고정, 유건 2026-09-12) + 음소거 채널은 푸시에서도 제외(그동안 앱 알림만 막고 폰 푸시는 그대로 갔다).
alter table public.msgr_channel_prefs add column if not exists pinned boolean not null default false;

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
    and not exists (select 1 from public.msgr_channel_prefs p where p.channel_id = m.channel_id and p.user_id = s.u and p.muted) -- 음소거는 푸시도 막는다(멘션은 예외 없음 — 슬랙과 같이 단순하게)
$$;
