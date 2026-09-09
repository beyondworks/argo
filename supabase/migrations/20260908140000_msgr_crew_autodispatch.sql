-- 기본 파견(유건 지시 2026-09-08): 아르고에 로그인해 메신저와 연결되면 내 크루 전부가 파견된 상태로 올라온다. 허용 범위·파견 해제는 메신저에서.
--  · 'available'의 뜻이 바뀐다: "파견 전(브리지가 올렸지만 아직 안 누름)" → "소유자가 메신저에서 파견 해제한 상태". 게이트는 그대로(available은 지시·답글·채널 멤버 불가).
--  · 이 파일은 옛 뜻의 available 행(파견 전 잔여)을 한 번 승격한다 — allow는 조직 정책 기본값, 정책이 없으면 owner. 봇(hosting='bot')은 대상 아님.
--  · 감사: 승격은 crew.dispatch 트리거(20260907120000)가 그대로 기록한다(소유자 행위가 아니라 마이그레이션이라 actor는 null).
update public.msgr_crews c
   set status = 'active', allow = coalesce(p.allow_default, 'owner'), allow_users = case when coalesce(p.allow_default, 'owner') = 'list' then c.allow_users else '{}'::uuid[] end
  from (select cc.id, pp.allow_default from public.msgr_crews cc left join public.msgr_org_policies pp on pp.org_id = cc.org_id where cc.status = 'available' and cc.hosting <> 'bot') p
 where c.id = p.id;

-- 파견 해제(active → available)는 "모든 채널에서 빠진다"(메신저 크루 카드 문구) — 서버가 멤버 행을 지운다. 되살리면(available → active) 채널은 다시 넣어야 한다.
create or replace function public.msgr_crew_recall_sweep() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.status = 'active' and new.status = 'available' then
    delete from public.msgr_channel_members where member_kind = 'crew' and member_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists msgr_crew_recall_sweep on public.msgr_crews;
create trigger msgr_crew_recall_sweep after update of status on public.msgr_crews for each row execute function public.msgr_crew_recall_sweep();
