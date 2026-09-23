-- 턴마다 서버 기억(유건 결정 2026-09-24 — 채널·조직 기억은 서버에만). 본체는 조직 문서를 PC(vault/org/)에 미러하지 않고, 턴마다 이 RPC로 받는다.
-- 호출자 = 크루 주인. 싣는 것: 전사 문서(주인이 owner·admin·member일 때) + 크루가 참여한 이 채널의 문서 + 이 채널의 최근 일지(최대 2일, 4,000자).
-- 다른 채널 문서는 싣지 않는다 — 크루 답은 이 채널 청중이 보므로, 주인이 장이라서 읽을 수 있는 다른 채널 기억이 섞이면 새는 길이 된다(설계 검수 H3).
-- 읽기 전용(쓰기 0). 크루 주인이 아니면 null.
create or replace function public.msgr_crew_memory(crew uuid, ch uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp as $$
    with k as (
      select c.id, c.org_id from public.msgr_crews c
       where c.id = crew and c.owner_user_id = auth.uid() and c.status = 'active'
    ), inch as (
      select exists (select 1 from k join public.msgr_channels x on x.id = ch and x.org_id = k.org_id and x.archived_at is null
                      where public.msgr_crew_in_channel(ch, k.id)) ok
    )
    select case when not exists (select 1 from k) then null else jsonb_build_object(
      'docs', coalesce((select jsonb_agg(jsonb_build_object('scope', case when d.channel_id is null then 'org' else 'channel' end,
                                                             'folder', split_part(d.path, '/', 1), 'title', d.title, 'body', d.body) order by d.channel_id nulls first, d.path)
                          from public.msgr_org_docs d, k
                         where d.org_id = k.org_id and d.path not like 'journal/%'
                           and ((d.channel_id is null and public.msgr_role(k.org_id) in ('owner', 'admin', 'member'))
                                or (d.channel_id = ch and (select ok from inch)))), '[]'::jsonb),
      'journal', coalesce((select right(string_agg(j.body, E'\n' order by j.path), 4000)
                             from (select d.path, d.body from public.msgr_org_docs d, k
                                    where d.org_id = k.org_id and d.channel_id = ch and d.path like 'journal/%' and (select ok from inch)
                                    order by d.path desc limit 2) j), '')
    ) end
$$;
revoke all on function public.msgr_crew_memory(uuid, uuid) from public, anon;
grant execute on function public.msgr_crew_memory(uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

-- 퇴장 회수 판정 — 본체가 PC에 남은 채널 사본(.msgr-journal/)을 지울지 채널마다 묻는다. 읽을 수 있거나(msgr_can_read_channel) 장이면(msgr_is_chief) true.
-- 없는 채널(삭제)은 false. 목록에 없는 것을 지우지 않고, 이 답이 false인 것만 지운다(설계 검수 M7). 읽기 전용.
create or replace function public.msgr_channel_access(ids uuid[]) returns table (id uuid, ok boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
    select x.id, coalesce(public.msgr_can_read_channel(x.id) or public.msgr_is_chief(x.id), false)
      from unnest(ids[1:500]) x(id)
$$;
revoke all on function public.msgr_channel_access(uuid[]) from public, anon;
grant execute on function public.msgr_channel_access(uuid[]) to authenticated;
notify pgrst, 'reload schema';
