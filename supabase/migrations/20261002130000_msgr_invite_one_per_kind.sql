-- 조직 초대 링크는 멤버 하나·관리자 하나(5차 피드백, 유건 2026-10-02) + 지난 초대 행 보존 기간.
--
-- 왜 서버 트리거인가(앱 재사용만으로 두지 않은 이유):
--   * "쓸 수 있는 링크"는 만료 시각·사용 횟수로 정해져 유니크 인덱스로 못 막는다(인덱스 조건에 now()를 쓸 수 없다).
--   * 관리자 둘·기기 둘이 동시에 만들거나, 이미 나간 옛 앱(초대 창이 설정을 바꿀 때마다 새 링크를 만든다)이 만들어도
--     조직마다 쓸 수 있는 멤버·관리자 링크가 하나로 남아야 한다. 앱은 있는 링크를 다시 쓰고, 새로 만들면 여기서 이전 것을 취소한다.
--   * 새 링크를 넣는 같은 트랜잭션에서 취소하므로 "새 링크로 바꾸기"는 원자적이다(새 링크가 실패하면 이전 링크도 그대로).
-- 대상: role member·admin, 노드용(for_node) 제외 — 노드 코드는 종전대로 하나씩 따로 관리한다. 게스트 링크(채널 하나·1회)는 사람마다라 그대로.
-- 이미 여러 개 있는 조직: 지우지 않는다. 앱 목록은 가장 최근 것만 보이고, 다음에 새로 만들 때 이 트리거가 나머지를 취소한다.

create or replace function public.msgr_invite_one_per_kind() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.role in ('member', 'admin') and not new.for_node then
    -- 같은 조직·같은 종류를 동시에 만드는 트랜잭션을 줄 세운다 — 뒤 트랜잭션은 앞이 커밋한 링크까지 보고 취소한다(READ COMMITTED 문장 단위 스냅샷)
    perform pg_advisory_xact_lock(hashtext('msgr_invite_kind:' || new.org_id::text || ':' || new.role));
    update public.msgr_invites set revoked_at = now()
     where org_id = new.org_id and role = new.role and not for_node and id <> new.id and revoked_at is null;
  end if;
  return null;
end $$;
revoke all on function public.msgr_invite_one_per_kind() from public, anon, authenticated;
drop trigger if exists msgr_invite_one_per_kind on public.msgr_invites;
create trigger msgr_invite_one_per_kind after insert on public.msgr_invites
  for each row execute function public.msgr_invite_one_per_kind();

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
