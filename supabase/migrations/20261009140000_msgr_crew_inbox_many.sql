-- 받은 글 일괄 조회(2026-10-09) — 게이트웨이 drain(src/gateway/msgr.mjs)이 15초 틱·방송 깨우기마다 에이전트 한 명당 msgr_crew_inbox를 한 번씩 불렀다.
-- 운영 실측(읽기 전용, 총괄): pg_stat_statements 2분 차이로 분당 약 2,350회, edge_logs 10분에 에이전트 200명 계정 하나가 10,828회.
-- 이 함수는 한 회사(작업 공간)의 에이전트 여럿을 한 번에 받는다. 결과는 같은 입력으로 msgr_crew_inbox(20260930210000_msgr_personal_crews.sql)를
-- 에이전트마다 부른 것과 같다(같은 행·같은 순서·에이전트마다 limit) — test/msgr-crew-inbox-many-pg.test.mjs가 옛 함수와 대조해 잠근다.
--
-- 인자: p_ws = 회사(작업 공간) id, p_items = [{"crew": uuid, "after": bigint}, …](최대 200, 같은 에이전트 두 번 금지), p_limit = 에이전트마다 앞 몇 건(옛 함수와 같은 1~200 고정).
-- 반환(jsonb 하나):
--   {"messages": [msgr_messages 행, …],                      -- 글은 id 오름차순으로 한 번씩만(조직 글은 그 조직 에이전트 모두가 받는다 — 에이전트 수만큼 다시 내려받지 않는다)
--    "crews": [{"crew": uuid, "ids": [bigint, …]}            -- 에이전트별 받은 글 id(오름차순, 앞 limit개) — 옛 함수의 행 순서
--             | {"crew": uuid, "forbidden": true}, …]}       -- 옛 함수가 42501(msgr_execution_forbidden)로 거절했을 에이전트(내 것 아님·다른 회사·활성 아님·없음)
-- 거절을 에이전트 단위로 두는 이유: 게이트웨이는 받은 글 조회 실패를 그 에이전트 차례에 던진다(앞 에이전트는 처리 — drain의 pre/inboxError).
--   전체를 거절하면 한 에이전트의 상태 경합(파견 해제 직후 등) 때문에 같은 틱의 다른 에이전트까지 멈춘다. 거절 표시는 옛 함수의 42501과 같은 판정·같은 정보다.
-- jsonb 하나로 돌려주는 이유: 행 집합으로 돌려주면 PostgREST 최대 행(Supabase 기본 1000)이 응답을 조용히 자른다(에이전트 100명 × 50건 = 5,000행).
--
-- 계산(조직 에이전트): 옛 함수의 조건 "주인이 읽을 수 있는 방(msgr_can_read_channel) 또는 DM 전달·참조(msgr_delivery_allowed·msgr_cc_delivery_allowed)"를 둘로 나눈다.
--   R = 주인이 읽을 수 있는 조직 글 — 에이전트와 무관하다(can_read는 호출자 기준). 같은 (조직, 커서)는 한 번만 읽는다(index msgr_messages_org_id_id, 앞 lim개).
--   D = 주인이 못 읽는 조직 DM에서 그 에이전트에게 전달·참조되는 글 — 두 함수 모두 에이전트가 그 방에 있어야 참이라(msgr_crew_in_channel) 그 에이전트가 든 DM만 본다.
--       R이 lim개 꽉 찼으면 그 마지막 id 뒤의 D 글은 어느 앞 lim개에도 들지 않으므로 거기서 멈춘다. 조직에 커서 뒤 글이 없으면(유휴 틱) D는 통째로 건너뛰고
--       (조직마다 색인 한 번), 그 DM에 커서 뒤 글이 없으면 읽기 판정도 하지 않는다.
--   에이전트 결과 = (R ∪ D) 중 커서 뒤 앞 lim개(id 순). 개인 에이전트는 옛 함수의 개인 갈래와 같은 질의(그 에이전트가 든 방만)를 에이전트마다.
-- 유휴 쓰기 0: dm_delivery_protocol은 바뀐 행만 한 문장으로 쓴다(옛 함수와 같은 값, IS DISTINCT FROM).
create or replace function public.msgr_crew_inbox_many(p_ws text, p_items jsonb, p_limit integer default 100)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  lim int := greatest(1, least(p_limit, 200)); -- 옛 함수와 같은 고정(null → 200)
  n int;
  v_crews uuid[]; v_after bigint[]; v_ok uuid[]; v_org uuid[];
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'msgr_bad_items' using errcode = '22023'; end if;
  n := jsonb_array_length(p_items);
  if n > 200 then raise exception 'msgr_too_many_items' using errcode = '22023'; end if;
  if n = 0 then return jsonb_build_object('messages', '[]'::jsonb, 'crews', '[]'::jsonb); end if;
  select array_agg((e->>'crew')::uuid order by o), array_agg((e->>'after')::bigint order by o)
    into v_crews, v_after from jsonb_array_elements(p_items) with ordinality as t(e, o);
  if array_position(v_crews, null) is not null or (select count(distinct x) from unnest(v_crews) as x) <> n then
    raise exception 'msgr_bad_items' using errcode = '22023';
  end if;
  -- 옛 함수와 같은 판정: 호출자 소유·이 회사·활성
  select coalesce(array_agg(c.id order by c.id), '{}'), coalesce(array_agg(c.org_id order by c.id), '{}') into v_ok, v_org from msgr_crews c
   where c.id = any (v_crews) and c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.status = 'active';
  update msgr_crews set dm_delivery_protocol = 1 where id = any (v_ok) and dm_delivery_protocol is distinct from 1; -- 같은 값을 폴마다 다시 쓰지 않는다(DB 위생)
  -- 유휴 틱(대부분의 틱) — 받을 글의 필요조건(조직: 그 조직 에이전트 중 가장 이른 커서 뒤에 글이 있음, 개인: 든 방에 커서 뒤 글이 있음)이 하나도 없으면
  -- 아래 큰 질의(계획·CTE)를 돌리지 않고 빈 결과를 돌려준다. 조직마다·개인 방마다 색인 한 번.
  if not exists (
       select 1 from (select o.org_id, min(i.after_id) as lo from unnest(v_ok, v_org) as o(crew, org_id) join unnest(v_crews, v_after) as i(crew, after_id) on i.crew = o.crew
                       where o.org_id is not null group by o.org_id) f
        where exists (select 1 from msgr_messages m where m.org_id = f.org_id and m.id > f.lo))
     and not exists (
       select 1 from unnest(v_ok, v_org) as o(crew, org_id) join unnest(v_crews, v_after) as i(crew, after_id) on i.crew = o.crew
         join msgr_channel_members cm on cm.member_kind = 'crew' and cm.member_id = o.crew
        where o.org_id is null and exists (select 1 from msgr_messages m where m.channel_id = cm.channel_id and m.id > i.after_id)) then
    return jsonb_build_object('messages', '[]'::jsonb, 'crews',
      (select jsonb_agg(case when o.crew is null then jsonb_build_object('crew', i.crew, 'forbidden', true) else jsonb_build_object('crew', i.crew, 'ids', '[]'::jsonb) end order by i.o)
         from unnest(v_crews) with ordinality as i(crew, o) left join unnest(v_ok) as o(crew) on o.crew = i.crew));
  end if;
  return (
    with items as (
      select u.crew, u.after_id, u.o from unnest(v_crews, v_after) with ordinality as u(crew, after_id, o)
    ), ok as ( -- 받을 수 있는 에이전트와 그 조직(개인은 null) — 위에서 읽은 그대로(표를 다시 읽지 않는다)
      select i.crew, i.after_id, o.org_id from items i join unnest(v_ok, v_org) as o(crew, org_id) on o.crew = i.crew
    ), fresh as ( -- 커서 뒤에 글이 하나라도 있는 조직 — 없으면(유휴 틱) 그 조직의 D는 볼 것이 없다. 조직마다 색인(org_id, id) 한 번
      select f.org_id from (select ok.org_id, min(ok.after_id) as lo from ok where ok.org_id is not null group by ok.org_id) f
       where exists (select 1 from msgr_messages m where m.org_id = f.org_id and m.id > f.lo)
    ), cur as ( -- 조직 × 커서 — 같은 커서의 에이전트는 한 번만 읽는다
      select distinct ok.org_id, ok.after_id from ok where ok.org_id is not null
    ), r as (
      select cur.org_id, cur.after_id, x.id from cur cross join lateral (
        select m.id from msgr_messages m join msgr_channels ch on ch.id = m.channel_id
         where m.org_id = cur.org_id and m.id > cur.after_id and m.deleted_at is null and msgr_can_read_channel(ch.id)
         order by m.id limit lim) x
    ), rb as ( -- 커서별 경계: R이 lim개 꽉 찼으면 그 마지막 id
      select r.org_id, r.after_id, max(r.id) as hi from r group by r.org_id, r.after_id having count(*) = lim
    ), d as (
      select ok.crew, x.id
        from ok
        join fresh on fresh.org_id = ok.org_id
        join msgr_channel_members cm on cm.member_kind = 'crew' and cm.member_id = ok.crew
        join msgr_channels ch on ch.id = cm.channel_id and ch.kind = 'dm' and ch.org_id = ok.org_id
        left join rb on rb.org_id = ok.org_id and rb.after_id = ok.after_id
        cross join lateral (
          select m.id from msgr_messages m
           where m.channel_id = ch.id and m.org_id = ok.org_id and m.id > ok.after_id and m.id <= coalesce(rb.hi, 9223372036854775807) and m.deleted_at is null
             and (msgr_delivery_allowed(ok.crew, m.id) or msgr_cc_delivery_allowed(ok.crew, m.id))
           order by m.id limit lim) x
       where ok.org_id is not null
         and case when exists (select 1 from msgr_messages m0 where m0.channel_id = ch.id and m0.id > ok.after_id and m0.id <= coalesce(rb.hi, 9223372036854775807))
                  then not msgr_can_read_channel(ch.id) else false end -- 읽을 수 있는 방의 글은 이미 R에 있다
    ), p as ( -- 개인 에이전트: 옛 함수의 개인 갈래 그대로(그 에이전트가 든 방만)
      select ok.crew, x.id from ok cross join lateral (
        select m.id from msgr_channel_members cm join msgr_messages m on m.channel_id = cm.channel_id join msgr_channels ch on ch.id = m.channel_id
         where cm.member_kind = 'crew' and cm.member_id = ok.crew and ch.org_id is null and m.id > ok.after_id and m.deleted_at is null
           and (msgr_can_read_channel(ch.id) or msgr_delivery_allowed(ok.crew, m.id))
         order by m.id limit lim) x
       where ok.org_id is null
    ), got as (
      select ok.crew, r.id from ok join r on r.org_id = ok.org_id and r.after_id = ok.after_id
      union
      select d.crew, d.id from d
      union
      select p.crew, p.id from p
    ), picked as (
      select z.crew, z.id from (select got.crew, got.id, row_number() over (partition by got.crew order by got.id) as rn from got) z where z.rn <= lim
    )
    select jsonb_build_object(
      'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from msgr_messages m where m.id = any (array(select distinct picked.id from picked))), '[]'::jsonb), -- 배열로 기본키 조회(빈 결과에 표 전체를 훑지 않게)
      'crews', (select jsonb_agg(case when ok.crew is null then jsonb_build_object('crew', i.crew, 'forbidden', true)
                                      else jsonb_build_object('crew', i.crew, 'ids', coalesce((select jsonb_agg(pk.id order by pk.id) from picked pk where pk.crew = i.crew), '[]'::jsonb)) end
                                 order by i.o)
                  from items i left join ok on ok.crew = i.crew))
  );
end $function$;

revoke all on function public.msgr_crew_inbox_many(text, jsonb, integer) from public, anon;
grant execute on function public.msgr_crew_inbox_many(text, jsonb, integer) to authenticated;

notify pgrst, 'reload schema';
