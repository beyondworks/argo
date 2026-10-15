-- 메신저를 쓴 계정에는 프로필 행이 있다 — 앱↔메신저 연결 감사 D2(2026-10-15, 총괄 배정 PR-A).
-- 본체의 메신저 자동 켜기(src/gateway/msgr.mjs autoEnableMsgr)와 설정 카드의 '메신저에 로그인한 적 있음' 판정(app/api/companies/[ws]/msgr/setup-facts.mjs)은
-- msgr_profiles 행이 있는지로 메신저 사용을 판정한다. 그런데 메신저는 이 행을 설정에서 이름·사진을 저장할 때만 쓴다(apps/messenger/src/App.jsx).
-- 그래서 조직 없이 개인 공간만 쓰는 사용자는 같은 계정으로 메신저에 로그인해도 에이전트가 영영 연결되지 않았고, 카드는 "로그인한 적 없습니다·[다른 계정으로 로그인]"을 보였다
-- (격리 재현: artifacts/msgr-link-audit/audit.md 1-4. 운영 읽기: 30일 앱 사용자 31명 중 24명이 행 없음, 그중 11명은 활성 에이전트 0).
--
-- 메신저는 화면이 보이는 동안 msgr_presence_ping으로 msgr_presence(사용자당 1행, 20260916170000)를 남긴다 — 9/16 이후 모든 메신저 버전.
-- 그 첫 행이 생길 때 빈 프로필 행을 만들고, 이미 있는 presence 사용자는 한 번 채운다. 본체·메신저를 업데이트하지 않아도 옛 앱 사용자까지 풀린다.
--  · 빈 행은 행이 없을 때와 동작이 같다: email_search 기본 true = 검색 함수의 coalesce(p.email_search, true), accept_requests 기본 true = 행 없음 허용,
--    handle·display_name null = 아이디 검색 안 됨·이메일 앞부분 표시(행 없음과 같음). 이미 있는 행은 건드리지 않는다(on conflict do nothing).
--  · 쓰기는 사용자당 평생 1번이다 — presence 심박은 on conflict do update라 AFTER INSERT가 첫 행에서만 돈다. 주기 쓰기 0.
-- 되돌리기: drop trigger msgr_presence_profile on public.msgr_presence; drop function public._msgr_profile_from_presence();
--          (채운 빈 행은 행 없음과 동작이 같아 지우지 않아도 된다. 지운다면 handle·display_name이 null이고 updated_at이 이 적용 시각인 행만.)

create or replace function public._msgr_profile_from_presence() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.msgr_profiles (user_id) values (new.user_id) on conflict (user_id) do nothing;
  return null;
end $$;
revoke all on function public._msgr_profile_from_presence() from public, anon, authenticated;

drop trigger if exists msgr_presence_profile on public.msgr_presence;
create trigger msgr_presence_profile after insert on public.msgr_presence
  for each row execute function public._msgr_profile_from_presence();

-- 이미 메신저를 쓴 사용자(presence 행이 있음) 한 번 채우기 — 다시 적용해도 없는 행만 넣는다.
insert into public.msgr_profiles (user_id)
  select p.user_id from public.msgr_presence p
  on conflict (user_id) do nothing;

notify pgrst, 'reload schema';
