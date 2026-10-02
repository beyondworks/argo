-- 조직 초대 링크는 멤버 하나·관리자 하나(5차 피드백, 유건 2026-10-02) + 지난 초대 행 보존 기간.
--
-- 하나로 맞추는 곳은 새 앱의 '새 링크로 바꾸기'뿐이다(msgr_invite_replace). 넣기(insert)마다 이전 링크를 취소하지 않는다:
--   이미 나간 옛 앱은 초대 창을 열자마자 링크를 만들고, 복사하지 않고 닫으면 그 링크를 지운다(origin/main invite-dialog.jsx).
--   넣기마다 취소하면 창을 열고 닫기만 해도 밖에 뿌린 멤버 링크가 말없이 죽는다(분리 검수 MEDIUM, 2026-10-02 — 처음 안은 트리거였다).
-- 새 앱은 쓸 수 있는 링크가 있으면 그 링크를 다시 쓰고, 사용자가 '새 링크로 바꾸기'를 확인하면 새 링크를 만든 뒤 이 함수로 나머지를 취소한다.
--   새 링크가 먼저 생기므로 바꾸는 사이에 쓸 수 있는 링크가 없는 순간이 없다. 이 함수가 실패하면 앱이 새 링크를 지워 이전 링크가 그대로 남는다.
-- 대상: role member·admin, 노드용(for_node) 제외 — 노드 코드는 종전대로 하나씩 따로 관리한다. 게스트 링크(채널 하나·1회)는 사람마다라 그대로.
-- 취소는 아직 쓸 수 있는 링크만(만료·소진은 이미 못 쓴다 — 쓰기 0), 취소마다 invite.revoke 감사(msgr_invite_revoke와 같은 모양 + 바꾼 링크 id).

-- 이 파일의 앞 안(넣기 트리거)을 적용한 시험 스택이 있으면 걷어낸다(운영에는 적용된 적 없다).
drop trigger if exists msgr_invite_one_per_kind on public.msgr_invites;
drop function if exists public.msgr_invite_one_per_kind();

create or replace function public.msgr_invite_replace(keep uuid) returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.msgr_invites%rowtype; x public.msgr_invites%rowtype; n integer := 0;
begin
  if auth.uid() is null then raise exception 'msgr_auth_required'; end if;
  select * into inv from public.msgr_invites where id = keep;
  if inv.id is null or not coalesce(public.msgr_is_admin(inv.org_id), false) then
    raise exception 'msgr_invite_not_found'; -- 볼 권한이 없는 초대는 없는 것과 같다(msgr_invite_revoke와 같은 판정 — 조직 링크는 관리자만)
  end if;
  if inv.role not in ('member', 'admin') or inv.for_node then return 0; end if;
  -- 관리자 둘·기기 둘이 동시에 바꾸면 줄 세운다 — 뒤 트랜잭션은 앞이 취소한 결과를 보고 판정한다
  perform pg_advisory_xact_lock(hashtext('msgr_invite_kind:' || inv.org_id::text || ':' || inv.role));
  select * into inv from public.msgr_invites where id = keep;
  if inv.revoked_at is not null then raise exception 'msgr_invite_revoked'; end if; -- 남길 링크가 취소됐으면 나머지를 취소하지 않는다(쓸 링크가 0개가 된다)
  for x in
    update public.msgr_invites set revoked_at = now()
     where org_id = inv.org_id and role = inv.role and not for_node and id <> inv.id and revoked_at is null
       and (expires_at is null or expires_at > now()) and (max_uses is null or use_count < max_uses)
    returning *
  loop
    perform public.msgr_audit(x.org_id, 'invite.revoke', 'invite', x.id::text, jsonb_build_object('replaced_by', inv.id));
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function public.msgr_invite_replace(uuid) from public, anon;
grant execute on function public.msgr_invite_replace(uuid) to authenticated;

-- 보존 기간: 만료·취소된 초대는 만료(취소) 30일 뒤 지운다. 사용 기록(msgr_invite_uses)은 함께 지워지고, 누가 들어왔는지는 감사 기록(invite.accept)에 남는다.
-- 지운 행 수를 돌려준다(시험·수동 점검용). pg_cron이 없는 환경(로컬 PG 시험)에서는 예약하지 않는다(20260927150000과 같은 형식).
create or replace function public.msgr_invites_purge() returns integer
  language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  delete from public.msgr_invites
   where (revoked_at is not null and revoked_at < now() - interval '30 days')
      or (expires_at is not null and expires_at < now() - interval '30 days');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.msgr_invites_purge() from public, anon, authenticated;

-- 시각은 기존 정리 작업(03:17·03:23·03:29·03:43)과 겹치지 않게 03:37.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('purge-msgr-invites', '37 3 * * *', $c$select public.msgr_invites_purge()$c$);
  end if;
end $$;

notify pgrst, 'reload schema';
