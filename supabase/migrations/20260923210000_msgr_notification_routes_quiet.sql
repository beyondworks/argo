-- 알림 경로 동기화 쓰기 줄이기 — 본체가 회사마다 30초에 한 번 부르는데, 매번 이 기기 노드를 전부 ready=false로 바꿨다가
-- 다시 업서트하고 경로 ready를 다시 계산해 행마다 4~5번 썼다(2026-09-23 DB 점검: 경로·노드 표 각 누적 300만 갱신, 행 228개).
-- 판정은 3분 신선도(n.last_seen_at >= now()-3분)라, 같은 내용이면 60초 안에는 쓰지 않는다. 내용이 바뀌거나 60초가 지나면 쓴다.
-- 경로를 빼면(p_routes에서 사라지면) 그 기기 노드는 종전처럼 ready=false가 된다(값이 바뀔 때만 쓴다).
create or replace function public.msgr_notification_routes_sync(p_ws text,p_routes jsonb,p_device text default 'legacy') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; rid uuid;
begin
  if auth.uid() is null then raise exception 'msgr_notification_forbidden' using errcode='42501'; end if;
  if p_device is null or length(p_device) not between 1 and 200 or p_ws is null or length(btrim(p_ws)) not between 1 and 200 or jsonb_typeof(p_routes) is distinct from 'array'
    or jsonb_array_length(p_routes)>2 then raise exception 'msgr_notification_invalid_routes'; end if;
  if exists(select 1 from jsonb_array_elements(p_routes) x where jsonb_typeof(x) <> 'object'
    or coalesce(x->>'kind','') not in ('telegram','slack') or jsonb_typeof(x->'ready') is distinct from 'boolean'
    or length(coalesce(btrim(x->>'label'),'')) not between 1 and 120)
    or (select count(*)<>count(distinct x->>'kind') from jsonb_array_elements(p_routes) x) then raise exception 'msgr_notification_invalid_routes'; end if;
  -- 이번 목록에 없는 경로의 이 기기 노드만 내린다(이미 내려가 있으면 쓰지 않는다)
  update public.msgr_notification_route_nodes n set ready=false,last_seen_at=now()
    from public.msgr_notification_routes r where n.route_id=r.id and r.owner_user_id=auth.uid() and r.ws_id=p_ws and n.device_id=p_device and n.ready
     and r.kind not in (select x->>'kind' from jsonb_array_elements(p_routes) x);
  for r in select value from jsonb_array_elements(p_routes) loop
    insert into public.msgr_notification_routes as t(owner_user_id,ws_id,kind,label,ready,last_seen_at)
      values(auth.uid(),p_ws,r->>'kind',btrim(r->>'label'),(r->>'ready')::boolean,now())
      on conflict(owner_user_id,ws_id,kind) do update set label=excluded.label,last_seen_at=now()
       where t.label is distinct from excluded.label or t.last_seen_at < now()-interval '60 seconds';
    select id into rid from public.msgr_notification_routes where owner_user_id=auth.uid() and ws_id=p_ws and kind=r->>'kind';
    insert into public.msgr_notification_route_nodes as t(route_id,device_id,ready,last_seen_at) values(rid,p_device,(r->>'ready')::boolean,now())
      on conflict(route_id,device_id) do update set ready=excluded.ready,last_seen_at=now()
       where t.ready is distinct from excluded.ready or t.last_seen_at < now()-interval '60 seconds';
  end loop;
  update public.msgr_notification_routes r set ready=x.ready
    from (select r2.id, exists(select 1 from public.msgr_notification_route_nodes n where n.route_id=r2.id and n.ready and n.last_seen_at>=now()-interval '3 minutes') ready
            from public.msgr_notification_routes r2 where r2.owner_user_id=auth.uid() and r2.ws_id=p_ws) x
   where r.id=x.id and r.ready is distinct from x.ready;
  return coalesce((select jsonb_agg(to_jsonb(x)-'owner_user_id' order by x.kind) from public.msgr_notification_routes x where owner_user_id=auth.uid() and ws_id=p_ws),'[]');
end $$;

notify pgrst, 'reload schema';
