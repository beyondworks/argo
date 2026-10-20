-- 되돌림: 20261020201600_msgr2_rate.sql — 반응·방 만들기·보관 속도 상한을 걷어낸다(하루 정리는 20261020201500 정의로). 속도 세기 칸은 기억 데이터가 아니라 표째 지운다.
drop trigger if exists msgr2_rate_guard on public.msgr2_reactions;
drop trigger if exists msgr2_rate_guard on public.msgr2_rooms;
create or replace function public.msgr2_retention_prune() returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare n int;
begin
  with d as (
    delete from public.msgr2_work_events e
     where e.created_at < now() - interval '30 days'
       and (e.work_id is null or exists (select 1 from public.msgr2_works w where w.id = e.work_id
              and (w.state in ('done', 'failed', 'cancelled') or (w.state = 'offered' and w.expires_at < now() - interval '30 days'))))
    returning 1)
  select count(*)::int into n from d;
  if exists (select 1 from public.msgr2_msg_waits) then perform public._msgr2_flush_waits(null, null); end if;
  return n;
end $$;
revoke all on function public.msgr2_retention_prune() from public, anon, authenticated;
drop function if exists public.msgr2_rate_guard();
drop function if exists public._msgr2_rate(text, text, int);
drop table if exists public.msgr2_rate_hits;
