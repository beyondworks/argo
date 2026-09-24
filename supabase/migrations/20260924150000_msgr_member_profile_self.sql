-- 부서·직급은 본인이 정한다(유건 2026-09-24: "직급이나 부서는 본인이 정하는거라 나 말고 다른 사람들껀 편집 포인트 없어도 돼").
-- 전: 조직 관리자만 누구의 것이든 바꿈. 후: 로그인한 본인 행만(관리자도 남의 것은 못 바꾼다). 서비스 문맥(auth.uid() null)은 그대로 통과.
-- 함수와 열 보호 트리거를 같은 규칙으로 — 함수만 바꾸면 트리거가 본인 저장을 막는다.
create or replace function public.msgr_member_profile_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and (new.department is distinct from old.department or new.title is distinct from old.title) then
    if old.user_id is distinct from auth.uid() then raise exception 'msgr_member_profile_forbidden' using errcode = '42501'; end if;
    -- 본인이 표를 직접 고쳐도(msgr_members_update_self) 함수와 같은 모양으로 — 앞뒤 공백·빈 값이 '같은 부서' 비교를 어긋나게 한다(재검수 #699 L1)
    new.department := nullif(btrim(new.department), ''); new.title := nullif(btrim(new.title), '');
  end if;
  return new;
end $$;

create or replace function public.msgr_set_member_profile(org uuid, member uuid, dept text, job text) returns void
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or member is distinct from auth.uid() then raise exception 'msgr_member_profile_forbidden' using errcode = '42501'; end if;
  update public.msgr_org_members set department = nullif(btrim(dept), ''), title = nullif(btrim(job), '')
   where org_id = org and user_id = member and removed_at is null
     and (department is distinct from nullif(btrim(dept), '') or title is distinct from nullif(btrim(job), ''));
end $$;
revoke all on function public.msgr_set_member_profile(uuid, uuid, text, text) from public, anon;
grant execute on function public.msgr_set_member_profile(uuid, uuid, text, text) to authenticated;
