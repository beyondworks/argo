-- 되돌림: supabase/migrations/20261020201200_msgr2_invite_revoke_signal.sql(초대 취소 방송)을 20261020200600 정의로 되돌린다. 표는 만들지 않았다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 20261020200600을 되돌리기 전에 먼저 실행한다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261020201200_msgr2_invite_revoke_signal.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
create or replace function public.msgr2_invite_revoke(p_invite uuid) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); i public.msgr2_space_invites;
begin
  select * into i from public.msgr2_space_invites where id = p_invite for update;
  if i.id is null or not (i.created_by = uid or coalesce(public._msgr2_team_role(i.space_id, uid), '') in ('owner', 'admin')) then
    raise exception 'msgr2_invite_not_found' using errcode = '42501';
  end if;
  if i.revoked_at is not null then return false; end if;
  update public.msgr2_space_invites set revoked_at = now() where id = i.id;
  return true;
end $$;
commit;
