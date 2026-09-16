-- 여럿이 대화하고, 그 방에 에이전트를 부른다(유건 2026-09-16: "1:1 대화방 신설 기능과 대화방에 멤버 및 에이전트 초대 기능 필요").
--
-- 종전에는 DM 정원 트리거가 사람 2·크루 1로 고정했다. 그래서 9/15에 만든 '새 그룹 대화'가 셋부터는 서버에서 msgr_dm_full로 거절당했고,
-- 대화 중인 방에 에이전트를 부르는 길도 없었다(드릴로 재현 확인).
--
-- 정원을 그냥 풀면 종전 검수(2026-09-03 MEDIUM-5)가 막았던 **제3자 끼워넣기**가 다시 열린다. 그래서 역할을 갈라 둔다:
--   · 사람을 더 부르는 길은 **새 방**이다 — 사적인 지난 대화가 불려 온 사람에게 통째로 넘어가지 않는다(슬랙과 같다).
--     앱은 멤버를 골라 msgr_create_channel을 다시 부르고, 같은 구성의 방이 이미 있으면 그 방을 연다.
--   · **에이전트**는 그 방에서 일하는 도구이므로 지금 방에 바로 들어온다. 방에 있는 사람이면 누구나 부를 수 있다.
--   · 개인 공간의 1:1은 '한 쌍 한 방'이 구조적 약속이므로 두 사람 그대로 둔다.

-- ── 1. DM 인원 제한은 개인 1:1에만 남긴다 ───────────────────────────────────
-- 조직 대화방은 인원 제한이 없다. 개인 1:1(personal_pair가 있는 방)은 사람 둘 고정이고 에이전트는 들어가지 않는다.
create or replace function public.msgr_dm_shape() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; pair text; nu int;
begin
  select kind, personal_pair into k, pair from public.msgr_channels where id = new.channel_id;
  if k <> 'dm' or pair is null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('msgr_dm:' || new.channel_id::text)); -- 두 기기가 같은 순간에 열 때(검수 2R LOW-2)
  select count(*) filter (where member_kind = 'user') into nu
    from public.msgr_channel_members where channel_id = new.channel_id;
  if new.member_kind <> 'user' or nu >= 2 then raise exception 'msgr_dm_pair_only'; end if;
  return new;
end $$;
revoke execute on function public.msgr_dm_shape() from anon, public;

-- ── 2. 대화방에 사람을 밀어 넣는 길은 여전히 없다 ───────────────────────────
-- msgr_can_manage_channel은 DM이면 참가자 전원을 통과시킨다. 종전에는 트리거의 정원이 그 뒤를 막고 있었으므로,
-- 정원을 푼 지금은 정책이 직접 갈라야 한다 — DM에 들어가는 사람은 방을 만들 때(definer RPC)만 정해진다.
drop policy if exists msgr_channel_members_insert on public.msgr_channel_members;
create policy msgr_channel_members_insert on public.msgr_channel_members for insert to authenticated
  with check (public.msgr_can_manage_channel(channel_id)
              and public.msgr_channel_member_ok(channel_id, member_kind, member_id)
              and (member_kind = 'crew'
                   or not exists (select 1 from public.msgr_channels c where c.id = channel_id and c.kind = 'dm')));
