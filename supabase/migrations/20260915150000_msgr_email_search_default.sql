-- 이메일로 친구 찾기 기본 허용(유건 지시 2026-09-15). 라이브 실측: 사용자 598명 중 이메일 검색 허용 0명, 프로필 행 1개 —
-- 옵트인 기본값이 "가입한 사용자 이메일을 정확히 넣어도 안 나온다"를 만들었다. 정확히 일치하는 이메일을 이미 아는 사람만
-- 찾을 수 있으므로 기본을 허용(옵트아웃)으로 바꾼다. 프로필의 끄기 체크박스는 그대로 두고, 명시적으로 끈 사람은 계속 숨는다.
-- 기존 행의 false는 사용자가 고른 값이 아니라 체크박스 기본 미체크 상태였으므로(라이브 1행) 허용으로 올린다.
-- RPC 계약(4열)·같은 조직·아이디·차단·자기 자신 규칙은 20260913084237 그대로.
alter table public.msgr_profiles alter column email_search set default true;
update public.msgr_profiles set email_search = true where email_search = false;
create or replace function public.msgr_find_user(q text) returns table (user_id uuid, handle text, display_name text, relation text)
  language plpgsql stable security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); needle text := lower(btrim(coalesce(q, '')));
begin
  if me is null then raise exception 'msgr_auth'; end if;
  if length(needle) < 3 then return; end if;
  return query
    select u.id, p.handle, coalesce(p.display_name, shared.display_name, split_part(u.email, '@', 1)),
           coalesce((select case when f.status = 'accepted' then 'friend' when f.status = 'pending' and f.requested_by = me then 'sent' when f.status = 'pending' then 'received' else f.status end
                       from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id)), 'none')
      from auth.users u left join public.msgr_profiles p on p.user_id = u.id
      left join lateral (
        select theirs.display_name, true as is_member
          from public.msgr_org_members mine
          join public.msgr_org_members theirs on theirs.org_id = mine.org_id and theirs.user_id = u.id
          join public.msgr_orgs org on org.id = mine.org_id and org.deleted_at is null
         where mine.user_id = me
           and mine.removed_at is null and (mine.expires_at is null or mine.expires_at > now())
           and theirs.removed_at is null and (theirs.expires_at is null or theirs.expires_at > now())
         order by theirs.joined_at, theirs.org_id limit 1
      ) shared on true
     where u.id <> me
       and ((needle like '%@%' and lower(u.email) = needle and (coalesce(p.email_search, true) or coalesce(shared.is_member, false)))
            or (needle not like '%@%' and p.handle is not null and p.handle like needle || '%' and coalesce(p.handle_search, true)))
       and not exists (select 1 from public.msgr_friends f where f.a = least(me, u.id) and f.b = greatest(me, u.id) and f.status = 'blocked')
     order by p.handle nulls last limit 10;
end $$;
revoke all on function public.msgr_find_user(text) from public, anon;
grant execute on function public.msgr_find_user(text) to authenticated;
