-- 사람 이름을 한 규칙으로(2026-10-01 유건 제보 "배너 알림에 친구 이름이 '?'"의 같은 계열 결함).
-- 운영 확인: msgr_profiles 행은 5개뿐이고 글을 쓴 사용자 9명은 행이 없다. 앱의 친구 목록(msgr_my_friends)은
--   coalesce(프로필 이름, 이메일 앞부분)으로 이름을 보이는데, 프로필만 읽는 경로들은 이름을 못 찾아 '?'·'Argo'·id 앞 8자리를 보였다:
--   - 모바일 푸시(msgr-push) — #784에서 서버 쪽 수정 완료
--   - 데스크톱 다른 공간 알림(cross-space.mjs readableForNotify)·맥 네이티브 알림(native_realtime.rs) — 클라이언트는 이메일을 못 읽는다
--   - 개인 그룹방 구성원 이름(msgr_dm_personal_list members.name) — 친구 아닌 구성원이 id 앞 8자리로 보였다
-- 처방: 이름 규칙을 msgr_person_label 하나로 두고(내부 전용), 목록 함수와 클라이언트용 조회(msgr_people_names)가 그것을 쓴다.
--   msgr_people_names는 나·친구(차단 제외)·나와 같은 방에 있는 사람만 돌려준다 — 이미 그 방의 글과 구성원을 보는 사이라 새로 드러나는 것은
--   이메일 앞부분뿐이고, 이는 친구 목록이 이미 보이는 값과 같다. 한 번에 최대 200명.
-- DB 위생: 쓰기·주기 호출 없음(읽기 함수뿐). 클라이언트는 알림 한 건에 한 번, 이름을 못 찾았을 때만 부른다.

create or replace function public.msgr_person_label(uid uuid) returns text
  language sql stable security definer set search_path = public, pg_temp as $$
    select coalesce(nullif(btrim(p.display_name), ''), nullif(split_part(u.email, '@', 1), ''))
      from auth.users u left join public.msgr_profiles p on p.user_id = u.id
     where u.id = uid
$$;
revoke all on function public.msgr_person_label(uuid) from public, anon, authenticated;

create or replace function public.msgr_people_names(ids uuid[]) returns table (user_id uuid, name text)
  language sql stable security definer set search_path = public, pg_temp as $$
    select x.id, public.msgr_person_label(x.id)
      from unnest((ids)[1:200]) as x(id)
     where auth.uid() is not null
       and (x.id = auth.uid()
            or exists (select 1 from public.msgr_friends f
                        where f.status <> 'blocked'
                          and ((f.a = auth.uid() and f.b = x.id) or (f.b = auth.uid() and f.a = x.id)))
            or exists (select 1 from public.msgr_channel_members me
                         join public.msgr_channel_members them on them.channel_id = me.channel_id and them.member_kind = 'user' and them.member_id = x.id
                        where me.member_kind = 'user' and me.member_id = auth.uid()))
$$;
revoke all on function public.msgr_people_names(uuid[]) from public, anon;
grant execute on function public.msgr_people_names(uuid[]) to authenticated;

-- 개인 방 목록 — 20260930210000 정의 그대로, 구성원 이름만 msgr_person_label로(프로필이 없는 구성원도 이름이 보이게).
drop function if exists public.msgr_dm_personal_list(boolean);
CREATE OR REPLACE FUNCTION public.msgr_dm_personal_list(include_groups boolean DEFAULT false)
 RETURNS TABLE(channel_id uuid, other_user_id uuid, last_at timestamp with time zone, last_body text, name text, members jsonb, is_group boolean, created_by uuid, crew_dm uuid, crews jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
    select c.id,
           (select m.member_id from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user' and m.member_id <> auth.uid() order by m.added_at, m.member_id limit 1),
           (select max(x.created_at) from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null),
           (select x.body from public.msgr_messages x where x.channel_id = c.id and x.deleted_at is null order by x.id desc limit 1),
           c.name,
           (select coalesce(jsonb_agg(jsonb_build_object('id', m.member_id, 'name', public.msgr_person_label(m.member_id)) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m
             where m.channel_id = c.id and m.member_kind = 'user'),
           c.personal_pair is null,
           c.created_by,
           case when c.personal_pair like 'crew:%' then substr(c.personal_pair, 6)::uuid end,
           (select coalesce(jsonb_agg(jsonb_build_object('id', cr.id, 'name', cr.display_name, 'owner_user_id', cr.owner_user_id) order by m.added_at), '[]'::jsonb)
              from public.msgr_channel_members m join public.msgr_crews cr on cr.id = m.member_id
             where m.channel_id = c.id and m.member_kind = 'crew')
      from public.msgr_channels c
     where c.org_id is null and c.kind = 'dm' and c.archived_at is null
       and (include_groups or (c.personal_pair is not null and c.personal_pair not like 'crew:%')) -- 옛 앱은 크루 1:1을 모른다(dm:?로 그려진다)
       and exists (select 1 from public.msgr_channel_members m
                    where m.channel_id = c.id and m.member_kind = 'user' and m.member_id = auth.uid())
     order by 3 desc nulls last
$function$;
revoke all on function public.msgr_dm_personal_list(boolean) from public, anon;
grant execute on function public.msgr_dm_personal_list(boolean) to authenticated;
