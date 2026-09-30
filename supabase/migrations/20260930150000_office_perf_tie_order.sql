-- 성과 기록: 같은 시각의 거래 활동은 일어난 순서(견적 → 계약 → 되돌림 → 취소)로 센다(유건 9/30 운영 제보).
-- 인트라넷 이관처럼 날짜만 있는 기록은 계약과 취소가 같은 시각이 된다. 이름순(a.kind)이면 'cancel'이 'contract'보다 먼저라
-- 취소가 무시되고 계약만 더해졌다(운영 9월 계약 3,120만 원 = 실제 1,620만 원 + 같은 날 취소된 1,500만 원). 함수 정의만 바꾸고 저장된 데이터는 그대로다.
create or replace function public.office_perf_compute(p_org uuid, p_user uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  sc text := 'o:' || p_org;
  lo timestamptz := p_from::timestamp at time zone 'Asia/Seoul';
  hi timestamptz := (p_to + 1)::timestamp at time zone 'Asia/Seoul';
  deals jsonb; tasks jsonb; approvals jsonb; pages jsonb; crew jsonb; notes jsonb; mail jsonb; reqs jsonb; t jsonb;
begin
  -- 담당 거래: 계약(+공급가액)·계약 되돌림/계약 뒤 취소(−)·청구(−감액)·입금(−환불). 공동 담당은 각자 전액 + 인원 표시
  with mine as (
    select o.id, o.title, cardinality(o.owners) co,
      (select coalesce(sum(l.quantity * l.unit_price), 0) from public.office_business_lines l where l.order_id = o.id) supply
    from public.office_business_orders o where o.scope = sc and p_user = any(o.owners)
  ), acts as (
    select a.order_id, a.kind, a.at,
      coalesce(sum(case a.kind when 'contract' then 1 when 'reopen' then -1 when 'cancel' then -1 else 0 end)
        over (partition by a.order_id order by a.at, case a.kind when 'contract' then 1 when 'reopen' then 2 when 'cancel' then 3 else 0 end rows between unbounded preceding and 1 preceding), 0) live_before
    from public.office_business_activity a join mine m on m.id = a.order_id where a.kind in ('contract', 'reopen', 'cancel')
  ), ev as (
    select a.order_id, a.at, case when a.kind = 'contract' then 'contract' else 'uncontract' end kind,
      case when a.kind = 'contract' then m.supply else -m.supply end amount
    from acts a join mine m on m.id = a.order_id
    where a.at >= lo and a.at < hi and (a.kind = 'contract' or a.live_before > 0)
    union all
    select e.order_id, e.at, e.kind, case when e.kind in ('credit', 'refund') then -e.amount else e.amount end
    from public.office_business_entries e join mine m on m.id = e.order_id where e.at >= lo and e.at < hi
  )
  select coalesce(jsonb_agg(jsonb_build_object('day', (ev.at at time zone 'Asia/Seoul')::date, 'order_id', ev.order_id, 'title', m.title,
      'kind', ev.kind, 'amount', ev.amount, 'co', m.co) order by ev.at), '[]') into deals
  from ev join mine m on m.id = ev.order_id;

  -- 할 일: 그 기간에 끝낸 일 + 그 기간이 기한인 일(취소 제외). 기한 준수 = 한국 날짜로 끝낸 날 ≤ 기한
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'title', x.title, 'due_on', x.due_on,
      'day', (x.done_at at time zone 'Asia/Seoul')::date, 'done', x.done_at is not null,
      'on_time', x.done_at is not null and x.due_on is not null and (x.done_at at time zone 'Asia/Seoul')::date <= x.due_on) order by x.done_at nulls last, x.due_on), '[]')
    into tasks
  from public.office_tasks x
  where x.scope = sc and x.assignee = p_user and x.cancelled_at is null
    and ((x.done_at >= lo and x.done_at < hi) or x.due_on between p_from and p_to);

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]') into approvals from (
    select (a.decided_at at time zone 'Asia/Seoul')::date d, count(*) n from public.msgr_crew_approvals a
    where a.org_id = p_org and a.decided_by = p_user and a.status in ('approved', 'rejected') and a.decided_at >= lo and a.decided_at < hi group by 1) s;

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'page_id', page_id, 'title', title) order by d, title), '[]') into pages from (
    select x.day d, x.page_id, x.title from public.office_perf_page_days x
    where x.org_id = p_org and x.user_id = p_user and x.day between p_from and p_to) s;

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]') into crew from (
    select (m.created_at at time zone 'Asia/Seoul')::date d, count(*) n from public.msgr_messages m
    where m.org_id = p_org and m.author_user_id = p_user and m.deleted_at is null and m.meta->>'source' like 'office%'
      and m.created_at >= lo and m.created_at < hi group by 1) s;

  -- 성과 한 줄: 고친 줄이 있으면 고친 것만, 원본 내용은 original로 같이
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'day', n.day, 'body', n.body, 'goal_id', n.goal_id, 'created_at', n.created_at,
      'edited', n.replaces is not null, 'original', o.body) order by n.day, n.created_at), '[]') into notes
  from public.office_perf_notes n left join public.office_perf_notes o on o.id = n.replaces
  where n.org_id = p_org and n.user_id = p_user and n.day between p_from and p_to
    and not exists (select 1 from public.office_perf_notes r where r.replaces = n.id);

  -- 거래처 메일(판정·근거 종류·메일 id만)
  select coalesce(jsonb_agg(jsonb_build_object('thread_id', x.thread_id, 'day', x.day, 'grade', x.grade, 'reasons', to_jsonb(x.reasons), 'reply_minutes', x.reply_minutes,
      'message_id', x.last_message_id, 'account', x.account, 'customer_id', x.customer_id, 'customer', c.name) order by x.day, x.thread_id), '[]') into mail
  from public.office_perf_mail x left join public.office_business_customers c on c.id = x.customer_id
  where x.org_id = p_org and x.user_id = p_user and x.day between p_from and p_to;

  -- 메신저 요청: 나를 멘션한 글 + 1:1 대화에서 상대가 새로 말을 건 글(같은 사람의 10분 안 연속 글은 하나로). 답 = 그 채널의 내 다음 글
  with req as (
    select m.id, m.channel_id, m.created_at from public.msgr_messages m join public.msgr_channels c on c.id = m.channel_id
    where m.org_id = p_org and m.author_kind = 'user' and m.author_user_id is distinct from p_user and m.deleted_at is null and m.created_at >= lo and m.created_at < hi
      and p_user = auth.uid() and public.msgr_can_read_channel(m.channel_id) -- 내가 실제로 읽을 수 있는 채널만(분리 검수 HIGH: 비공개 채널 멘션의 id·날짜가 새던 문제)
      and (m.mentions @> jsonb_build_array(jsonb_build_object('kind', 'user', 'id', p_user::text))
        or (c.kind = 'dm' and exists (select 1 from public.msgr_channel_members cm where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = p_user)
          and not exists (select 1 from public.msgr_messages p where p.channel_id = m.channel_id and p.author_user_id = m.author_user_id and p.deleted_at is null
            and p.created_at < m.created_at and p.created_at > m.created_at - interval '10 minutes')))
  ), ans as (
    select r.*, (select min(x.created_at) from public.msgr_messages x where x.channel_id = r.channel_id and x.author_kind = 'user' and x.author_user_id = p_user
      and x.deleted_at is null and x.created_at > r.created_at) replied_at from req r
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'day', (a.created_at at time zone 'Asia/Seoul')::date,
      'minutes', case when a.replied_at is not null then round(extract(epoch from a.replied_at - a.created_at) / 60)::int end,
      'unanswered', a.replied_at is null and a.created_at < now() - interval '24 hours',
      'done', exists (select 1 from public.office_tasks t where t.scope = sc and t.assignee = p_user and t.source->>'kind' = 'msgr' and t.source->>'message_id' = a.id::text and t.done_at is not null))
      order by a.created_at), '[]') into reqs from ans a;

  select jsonb_build_object(
    'mail_threads', jsonb_array_length(mail),
    'mail_good', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'good'),
    'mail_normal', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'normal'),
    'mail_caution', (select count(*) from jsonb_array_elements(mail) e where e->>'grade' = 'caution'),
    'req_count', jsonb_array_length(reqs),
    'req_answered', (select count(*) from jsonb_array_elements(reqs) e where e->>'minutes' is not null),
    'req_unanswered', (select count(*) from jsonb_array_elements(reqs) e where (e->>'unanswered')::boolean),
    'req_done', (select count(*) from jsonb_array_elements(reqs) e where (e->>'done')::boolean),
    'req_minutes', (select round(avg((e->>'minutes')::int))::int from jsonb_array_elements(reqs) e where e->>'minutes' is not null),
    'contract', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('contract', 'uncontract')), 0),
    'invoiced', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('invoice', 'credit')), 0),
    'paid', coalesce((select sum((e->>'amount')::bigint) from jsonb_array_elements(deals) e where e->>'kind' in ('payment', 'refund')), 0),
    'deals', (select count(distinct e->>'order_id') from jsonb_array_elements(deals) e),
    'tasks_done', (select count(*) from jsonb_array_elements(tasks) e where (e->>'done')::boolean and (e->>'day')::date between p_from and p_to),
    -- 기한인 일 = 그 기간이 기한이고, 이미 끝냈거나 기한이 지난 일(기한이 아직 안 지난 미완료 일은 실패가 아니다)
    'tasks_due', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and ((e->>'done')::boolean or (e->>'due_on')::date < public.office_perf_today())),
    'tasks_done_due', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and (e->>'done')::boolean),
    'tasks_on_time', (select count(*) from jsonb_array_elements(tasks) e where (e->>'due_on')::date between p_from and p_to and (e->>'on_time')::boolean),
    'approvals', coalesce((select sum((e->>'n')::int) from jsonb_array_elements(approvals) e), 0),
    'pages', (select count(distinct e->>'page_id') from jsonb_array_elements(pages) e),
    'crew', coalesce((select sum((e->>'n')::int) from jsonb_array_elements(crew) e), 0),
    'notes', jsonb_array_length(notes)) into t;

  return jsonb_build_object('from', p_from, 'to', p_to, 'totals', t, 'deals', deals, 'tasks', tasks, 'approvals', approvals, 'pages', pages, 'crew', crew, 'notes', notes, 'mail', mail, 'asks', reqs); -- asks: 메신저 요청('requests'는 본인 기록의 고치기 요청 목록이 쓴다)
end $$;
