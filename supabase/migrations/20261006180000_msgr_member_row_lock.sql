-- 대화방·채널 참여 행의 신원 열(channel_id·member_kind·member_id)은 update로 바꿀 수 없다. 20261006170000_msgr_group_delete_report.sql(#847) 다음에 적용한다.
-- 시험: test/msgr-member-row-lock-pg.test.mjs (이 파일 적용 전 재현 → 적용 뒤 거절, 정상 update·delete+insert 유지)
--
-- 원인: 참여 행 update 정책(msgr_channel_members_update, 마지막 정의 20261006170000 1-c)은 "그 방을 관리·삭제할 수 있는 사람"만 보고
--   어떤 열을 바꾸는지는 보지 않는다. 조직 1:1(사람 둘)에서는 삭제 판정이 참여자 누구에게나 열려 있어, c가
--   update msgr_channel_members set member_id = d where member_id = b 한 줄로 b를 빼고 d를 넣었다 — b는 자기 1:1을 잃고 d는 전체 기록을 본다.
--   "대화방 사람은 만들 때만 정한다"는 insert 규칙(msgr_channel_members_insert·msgr_dm_shape·개인 공간 게이트)도 update로 우회됐다.
--   공개·비공개 채널의 관리자도 같은 update로 insert 쪽 트리거(msgr_dm_shape·msgr_channel_personal_gate·msgr_personal_room_cap)를 건너뛰었다.
-- 처방: 신원 열을 바꾸는 update는 어느 채널 종류·어느 역할에서든 거절한다. 사람을 바꾸는 정상 동작은 delete + insert이고 각자 정책·트리거를 지난다.
--   정책은 그대로 둔다(1:1에서 관리 판정이 열린 것은 이름 바꾸기·보관 등 채널 행의 일이다 — 참여 행 신원과 무관).
-- 정상 update 경로 전수(2026-10-06 grep — apps/messenger/src·src/gateway·apps/office·supabase/functions·supabase/migrations):
--   · msgr_delete_me(20260914200000)·msgr_personal_dm(20260916150000)의 정의자 함수: set added_by = null — 신원 열이 아니라 통과
--   · 앱 ChannelSheet addMember·restoreMember의 upsert(onConflict channel_id,member_kind,member_id): 충돌 시 신원 열은 같은 값 — 통과
--   · 신원 열을 바꾸는 코드는 없다. FK on update cascade도 없다(channel_id는 on delete cascade만).
-- 잠금 방식: 저장소 공통 msgr_lock_cols는 쓰지 않는다. 그 함수는 auth.uid() 없음과 pg_trigger_depth() > 1을 통과시키는데, depth는 SQL을 직접 쓰는
--   사용자가 임시 표 트리거로 위조할 수 있다(msgr_channel_admins_guard 주석, 재검 #691 실증). 이 열을 바꾸는 정상 경로가 하나도 없으므로
--   예외 없이(서비스 문맥 포함) 거절한다 — 운영 도구도 delete + insert로 한다. 오류 이름은 msgr_lock_cols와 같은 모양(msgr_immutable_<열>).
-- 부하: WHEN 절이 열 비교만 한다 — 정상 update(added_by 등)에서는 함수가 불리지 않는다. 새 표·주기 작업·쓰기 없음.

-- create trigger는 msgr_channel_members에 SHARE ROW EXCLUSIVE 잠금을 잡는다. 대화방 열기·참여 조회가 잦은 표라 오래 기다리며 뒤 요청을 줄 세우지 않고
-- 실패한다(다시 실행하면 된다). scripts/msgr-live-apply.sh는 적용 psql의 PGOPTIONS를 자체 값으로 덮어 바깥 lock_timeout이 닿지 않는다 — 그래서 파일 안에 둔다.
set local lock_timeout = '5s';

create or replace function public.msgr_channel_member_identity_lock() returns trigger
  language plpgsql set search_path = public, pg_temp as $$
begin
  if new.channel_id is distinct from old.channel_id then raise exception 'msgr_immutable_channel_id' using errcode = '42501'; end if;
  if new.member_kind is distinct from old.member_kind then raise exception 'msgr_immutable_member_kind' using errcode = '42501'; end if;
  if new.member_id is distinct from old.member_id then raise exception 'msgr_immutable_member_id' using errcode = '42501'; end if;
  return new;
end $$;
revoke all on function public.msgr_channel_member_identity_lock() from public, anon, authenticated;

drop trigger if exists msgr_lock_channel_members on public.msgr_channel_members;
create trigger msgr_lock_channel_members before update on public.msgr_channel_members
  for each row
  when (old.channel_id  is distinct from new.channel_id
     or old.member_kind is distinct from new.member_kind
     or old.member_id   is distinct from new.member_id)
  execute function public.msgr_channel_member_identity_lock();
