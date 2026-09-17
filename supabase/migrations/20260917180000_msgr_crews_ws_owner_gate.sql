-- 한 회사 폴더(ws_id)의 크루는 한 계정 소유다(실사고 2026-09-17 윈도우 PC).
--   예전 계정(beyondworks)이 쓰던 회사 폴더가 남은 PC에 다른 계정(lean8kim)으로 로그인하자, 앱이 그 회사 크루 12명을 새 계정 소유로
--   lean-win·Lean-AX에 24행 미러했다(소유자 게이트 이전 빌드, 게이트도 "소유자가 있을 때만 비교"라 미기록·읽기 실패가 통과).
--   앱 게이트는 새 빌드에만 닿는다 — 옛 빌드가 남은 기기까지 막으려고 서버가 마지막으로 거른다.
-- 규칙: 로컬·상주 크루를 넣을 때, 같은 ws_id에 **다른 소유자**의 크루가 이미 있으면 거부한다. 봇(ws_id 'bot')은 대상 밖.
-- 한계: 원래 주인이 한 번도 메신저에 올리지 않은 회사는 서버가 주인을 모른다 — 그 경우는 앱 게이트(일치할 때만)가 막는다.
create or replace function public.msgr_crews_ws_owner_gate() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.hosting in ('local', 'resident') and new.ws_id is not null and new.ws_id <> 'bot' then
    perform pg_advisory_xact_lock(hashtext('msgr_crews_ws:' || new.ws_id)); -- 두 계정이 같은 순간에 처음 올릴 때 한쪽만
    if exists (select 1 from public.msgr_crews x
                where x.ws_id = new.ws_id and x.owner_user_id <> new.owner_user_id and x.hosting in ('local', 'resident')) then
      raise exception 'msgr_ws_owned_by_other' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.msgr_crews_ws_owner_gate() from public, anon, authenticated;
drop trigger if exists msgr_crews_ws_owner_gate on public.msgr_crews;
create trigger msgr_crews_ws_owner_gate before insert on public.msgr_crews for each row execute function public.msgr_crews_ws_owner_gate();
