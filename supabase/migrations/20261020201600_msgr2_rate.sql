-- 메신저 사람 채팅 폭주 상한 보강(#1124 검수 미룸 2건, 유건 "폭주 안되게 막는 게 제일 중요해" — 공개 전에 넣는다).
-- 사람 채팅 스위치(msgr2_people = on)일 때, 사람 문맥(auth.uid() 있음)의 쓰기에만:
--   · 반응 달기·지우기: 사람마다 분당 ≤ msgr2_limit_reactions_min(기본 60, 최대 120) — detail reactions
--   · 방 만들기(모든 종류·1:1 포함): 사람마다 분당 ≤ msgr2_limit_room_create_min(기본 10, 최대 30), 하루 ≤ msgr2_limit_room_create_day(기본 200, 최대 500) — detail room_create
--   · 방 보관·보관 풀기(archived_at 바꾸기): 사람마다 분당 ≤ msgr2_limit_room_archive_min(기본 10, 최대 30) — detail room_archive
--     (공간당 방 1,000개 상한을 "만들고 보관하기" 반복으로 돌리지 못하게. 지금 v2에는 사람이 보관하는 RPC가 없고 1:1 다시 열기의 보관 풀기만 있다 — 앞으로 생겨도 같은 관문)
--   넘치면 'msgr2_limit'(22023, detail 위). 앱은 다시 보내지 않는다(rejectCodeOf → rejected).
-- 세는 법: 사람·종류·시간 칸(분·일)마다 1행(msgr2_rate_hits)을 올린다 — 쓰기는 그 행동 1번당 1행이고, 거부되면 트랜잭션과 함께 되돌아가 남지 않는다.
--   쉬는 동안 쓰기 0(행동이 없으면 아무것도 쓰지 않는다). 지난 칸은 하루 1번 도는 기존 정리 작업(msgr2_retention_prune)이 이틀 지난 것을 지운다(기억 데이터 아님).
-- 꺼짐(A+)이면 종전 그대로(관문 없음).
-- 되돌릴 때는 이 파일을 20261020201500(사람 채팅)보다 먼저(그 파일의 되돌림도 이 트리거를 지운다).
-- 되돌림: scripts/rollback/20261020201600_msgr2_rate.down.sql · 시험: test/msgr2-people-pg.test.mjs "폭주 상한 보강"

create table if not exists public.msgr2_rate_hits (
  user_id uuid not null,
  kind text not null,
  bucket timestamptz not null,
  n int not null default 0,
  primary key (user_id, kind, bucket)
);
create index if not exists msgr2_rate_hits_bucket on public.msgr2_rate_hits (bucket);
alter table public.msgr2_rate_hits enable row level security; -- 정책 없음: 서버 함수만
revoke all on public.msgr2_rate_hits from public, anon, authenticated;

-- 한 번 세고 상한을 넘으면 거부한다. p_per = 'minute' | 'day'. 사람 채팅 꺼짐 판정은 부르는 쪽(msgr2_rate_guard) 한 곳에서 한다.
create or replace function public._msgr2_rate(p_kind text, p_per text, p_limit int) returns void
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); c int;
begin
  if uid is null then return; end if;
  insert into public.msgr2_rate_hits as h (user_id, kind, bucket, n) values (uid, p_kind || ':' || p_per, date_trunc(p_per, now()), 1)
    on conflict (user_id, kind, bucket) do update set n = h.n + 1 returning n into c;
  if c > p_limit then raise exception 'msgr2_limit' using errcode = '22023', detail = p_kind; end if;
end $$;

create or replace function public.msgr2_rate_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public._msgr2_people() then return coalesce(new, old); end if;
  if tg_table_name = 'msgr2_reactions' then
    perform public._msgr2_rate('reactions', 'minute', public._msgr2_clamp('msgr2_limit_reactions_min', 60, 120));
  elsif tg_op = 'INSERT' then -- msgr2_rooms
    perform public._msgr2_rate('room_create', 'minute', public._msgr2_clamp('msgr2_limit_room_create_min', 10, 30));
    perform public._msgr2_rate('room_create', 'day', public._msgr2_clamp('msgr2_limit_room_create_day', 200, 500));
  elsif new.archived_at is distinct from old.archived_at then
    perform public._msgr2_rate('room_archive', 'minute', public._msgr2_clamp('msgr2_limit_room_archive_min', 10, 30));
  end if;
  return coalesce(new, old);
end $$;
revoke all on function public._msgr2_rate(text, text, int), public.msgr2_rate_guard() from public, anon, authenticated;
drop trigger if exists msgr2_rate_guard on public.msgr2_reactions;
create trigger msgr2_rate_guard before insert or delete on public.msgr2_reactions for each row execute function public.msgr2_rate_guard();
drop trigger if exists msgr2_rate_guard on public.msgr2_rooms;
create trigger msgr2_rate_guard before insert or update of archived_at on public.msgr2_rooms for each row execute function public.msgr2_rate_guard();

-- 하루 정리에 지난 칸 지우기를 얹는다(20261020201500 정의 + 한 줄). 지난 칸이 없으면 쓰기 0.
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
  delete from public.msgr2_rate_hits where bucket < now() - interval '2 days'; -- 속도 세기 칸(기억 데이터 아님)
  return n;
end $$;
revoke all on function public.msgr2_retention_prune() from public, anon, authenticated;
