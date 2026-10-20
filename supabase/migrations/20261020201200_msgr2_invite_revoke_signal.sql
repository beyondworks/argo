-- 메신저 v2 초대 취소 방송(U6d 후속, 총괄 배정 2026-10-18, 버전 칸 061300). 정의 하나만 바꾼다 — 표·열·주기 호출을 더하지 않는다.
-- 고치는 것: 사람을 지정한 초대(target_user_id)를 보낸 쪽이 취소해도 받는 사람에게 알리지 않아, 받는 쪽 초대함(msgr2_my_invites를 읽은 목록)에
--   다음 다시 읽기(앱 복귀·다른 사건) 전까지 남았다(#1094·#1096 검수 미룸). 초대를 만들 때 보내는 v2:u: 'invite' 사건과 같은 길로 취소도 알린다.
-- 받는 쪽: 셸은 'invite' 사건이면 받은 초대 목록을 한 번 다시 읽는다(apps/messenger/src/v2/room-events.mjs → my-invites.mjs) — 취소된 초대는 서버 목록에서 빠진다. 앱 변경 없음.
-- 보내는 때: 이번 호출로 취소됐고(이미 취소됐으면 false, 방송 없음) 사람 지정 초대이며 아직 정해지지 않았을 때(수락 0·거절 안 함) 한 번. 링크 초대(받는 사람 없음)는 보내지 않는다.
-- 방송 실패는 취소를 막지 않는다(_msgr2_send_u가 예외를 삼킨다).
-- 되돌림: scripts/rollback/20261018061300_msgr2_invite_revoke_signal.down.sql(20261018040000 정의로)

-- 취소: 앱 기기, 만든 사람 또는 그 공간의 owner·admin. 이미 취소됐으면 false. 없는 초대·남의 공간은 msgr2_invite_not_found.
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
  if i.target_user_id is not null and i.use_count = 0 and i.declined_at is null then
    perform public._msgr2_send_u(i.target_user_id, 'invite', jsonb_build_object('invite_id', i.id, 'space_id', i.space_id, 'revoked', true));
  end if;
  return true;
end $$;
