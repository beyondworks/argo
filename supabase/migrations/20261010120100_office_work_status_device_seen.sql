-- 업무 현황의 에이전트 접속 시각에 기기 단위 심박을 더한다(20261010120000_msgr_device_heartbeat).
-- 20261008200000 정의 그대로 + 에이전트 'last_seen_at'·정렬 = greatest(행 시각, 그 에이전트를 맡은 기기의 마지막 심박). 쓰기 0, 반환 모양 같음.
-- 오피스 표(office_*)가 있어야 하므로 메신저 마이그레이션과 파일을 나눴다(메신저 마이그레이션만 올리는 PG 시험이 깨지지 않게).

create or replace function public.office_work_status(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  who uuid := auth.uid(); admin boolean; ids uuid[]; bots uuid[];
  v_crews jsonb; v_sessions jsonb; v_running jsonb; v_runs jsonb; v_tasks jsonb; v_people jsonb;
begin
  if p_org is null then raise exception 'session_input'; end if; -- 조직 전용 화면
  perform public.office_business_scope(p_org, false); -- 손님·밖의 사람·로그인 안 한 사람은 여기서 막힌다
  admin := exists (select 1 from public.msgr_org_members where org_id = p_org and user_id = who and removed_at is null and role in ('owner', 'admin'));

  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', coalesce(nullif(c.display_name, ''), c.slug), 'slug', c.slug,
      'hosting', case when c.hosting = 'bot' then 'bot' else 'local' end, 'owner', c.owner_user_id, 'last_seen_at', c.seen, 'department', c.department)
      order by c.seen desc nulls last, c.id), '[]'::jsonb), coalesce(array_agg(c.id), '{}'), coalesce(array_agg(c.id) filter (where c.hosting = 'bot'), '{}')
    into v_crews, ids, bots
    from (select c.*, greatest(c.last_seen_at, public._msgr_device_seen(c.owner_user_id, c.ws_id, c.slug)) seen -- 기기 단위 심박(20261010120000)
            from public.msgr_crews c where c.org_id = p_org and c.status = 'active' and (admin or c.owner_user_id = who)
          order by seen desc nulls last, c.id limit 500) c;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'project', s.project, 'owner', s.owner_user_id, 'task_id', s.task_id, 'last_seen_at', s.last_seen_at)
      order by s.last_seen_at desc, s.id), '[]'::jsonb)
    into v_sessions
    from (select * from public.office_agent_sessions s where s.org_id = p_org and s.last_seen_at > now() - interval '7 days' and (admin or s.owner_user_id = who)
          order by s.last_seen_at desc, s.id limit 500) s;

  select coalesce(jsonb_agg(jsonb_build_object('crew_id', e.crew_id, 'started_at', e.started_at) order by e.started_at desc, e.crew_id), '[]'::jsonb)
    into v_running
    from (select e.crew_id, e.started_at from public.msgr_executions e
          where e.crew_id = any(ids) and e.state = 'running'
            and e.heartbeat_at > now() - case when e.crew_id = any(bots) then interval '10 minutes' else interval '2 minutes' end
            and not exists (select 1 from public.msgr_messages m join public.msgr_messages x on x.channel_id = m.channel_id and x.author_kind = 'crew'
                  and coalesce(x.crew_id::text, x.author_user_id::text, '') = e.crew_id::text and x.client_msg_id = 'unknown:' || e.crew_id || ':' || m.id
                where m.id = e.source_msg_id) -- 안내 행 한 건 조회(유니크 색인 msgr_messages_client_id의 네 칸 그대로 — 크루가 쓴 안내만)
          order by e.started_at desc limit 500) e;

  select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'lead_crew_id', w.lead_crew_id, 'goal', w.goal, 'status', w.status, 'created_at', w.created_at)
      order by w.created_at desc, w.id), '[]'::jsonb)
    into v_runs
    from (select w.id, w.lead_crew_id, w.goal, w.status, w.created_at from public.msgr_work_runs w
          where w.org_id = p_org and w.status in ('running', 'blocked') and w.lead_crew_id = any(ids)
            and (w.status = 'blocked' or w.updated_at > now() - interval '24 hours')
            and public.msgr_can_read_channel(w.channel_id) -- auth.uid() 기준이라 정의자 함수 안에서도 부른 사람으로 판정한다
          order by w.created_at desc, w.id limit 100) w;

  select coalesce(jsonb_agg(to_jsonb(t) - 'scope' order by t.due_on nulls last, t.created_at, t.id), '[]'::jsonb)
    into v_tasks
    from (select * from public.office_tasks t
          where t.scope = 'o:' || p_org and t.done_at is null and t.cancelled_at is null and (admin or t.assignee = who or t.created_by = who)
          order by t.due_on nulls last, t.created_at, t.id limit 500) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name',
      case when m.user_id is null then null else coalesce(nullif(m.display_name, ''), nullif(p.display_name, ''), split_part(u.email, '@', 1), '?') end) order by x.id), '[]'::jsonb)
    into v_people
    from (select y.id from (select (e->>'assignee')::uuid id from jsonb_array_elements(v_tasks) e
          union select (e->>'created_by')::uuid from jsonb_array_elements(v_tasks) e
          union select (e->>'owner')::uuid from jsonb_array_elements(v_crews) e
          union select (e->>'owner')::uuid from jsonb_array_elements(v_sessions) e) y where y.id is not null) x
    left join public.msgr_org_members m on m.org_id = p_org and m.user_id = x.id and m.removed_at is null and m.role <> 'guest'
    left join public.msgr_profiles p on p.user_id = x.id
    left join auth.users u on u.id = x.id;

  return jsonb_build_object('admin', admin, 'now', now(), 'crews', v_crews, 'sessions', v_sessions, 'running', v_running,
    'runs', v_runs, 'tasks', v_tasks, 'people', v_people);
end $$;

revoke all on function public.office_work_status(uuid) from public, anon;
grant execute on function public.office_work_status(uuid) to authenticated;
notify pgrst, 'reload schema';
