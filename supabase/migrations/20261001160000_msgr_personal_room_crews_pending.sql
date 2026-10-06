-- 개인 방 넣기 요청 — 친구가 요청 중인 에이전트의 이름을 읽는다(2026-10-01 유건 제보: 친구 화면에 이름 대신 crew id 앞 8자리 '3d45b1ce').
-- 원인: 개인 크루 행은 주인만 읽고(msgr_crews_select), msgr_personal_room_crews()는 이미 방에 든 크루만 돌려준다. 허락을 결정해야 하는 친구는
--       요청 행(msgr_channel_crew_requests: crew_id만)만 받아 이름을 알 길이 없었다.
-- 변경: 20261001140000 정의 그대로 + 대상 조건 하나 — "내가 든 개인 방에 대기 중(pending)인 넣기 요청이 있는 크루"도 같은 표시용 열로 보인다.
--       반환 열·열 가리기(남의 크루는 commands·bot_kind·org_label·ready·paused NULL, 봇 role_text NULL)는 그대로다.
--       요청이 허락·거절되면 status가 바뀌어 이 조건에서 빠진다(허락이면 방 구성원 조건으로 계속 보인다). 쓰기 0.
-- 반환 열이 같아 create or replace로 충분하지만, 권한은 종전과 같게 다시 건다.
create or replace function public.msgr_personal_room_crews()
returns table(id uuid, org_id uuid, slug text, display_name text, role_text text, owner_user_id uuid, hosting text, status text,
              avatar_url text, face jsonb, department text, last_seen_at timestamptz, commands jsonb, bot_kind text, org_label text, ready boolean, paused text)
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id, c.org_id, c.slug, c.display_name,
         case when c.hosting = 'bot' and c.owner_user_id is distinct from auth.uid() then null else c.role_text end,
         c.owner_user_id, c.hosting, c.status, c.avatar_url, c.face, c.department,
         -- 접속: 방에 들지 않은 개인 행은 심박을 쓰지 않는다 — 같은 크루(주인·회사·slug)의 조직 행 시각을 빌린다(쓰기 0). 쌍둥이는 조직 봇 행 시각.
         greatest(c.last_seen_at, (select max(o.last_seen_at) from public.msgr_crews o where o.owner_user_id = c.owner_user_id and o.ws_id = c.ws_id and o.slug = c.slug and o.org_id is not null)),
         case when c.owner_user_id = auth.uid() then c.commands else null end,
         case when c.owner_user_id = auth.uid() then bb.kind end,
         case when c.owner_user_id = auth.uid() and bb.id is not null and exists (
                select 1 from public.msgr_bot_personal p2 join public.msgr_bots b2 on b2.id = p2.bot_id join public.msgr_crews c2 on c2.id = p2.crew_id
                 where c2.owner_user_id = c.owner_user_id and c2.status = 'active' and p2.bot_id <> bb.id
                   and (lower(c2.display_name) = lower(c.display_name) or (b2.external_id is not null and b2.external_id = bb.external_id)))
              then (select o.name from public.msgr_orgs o where o.id = bb.org_id) end,
         case when c.owner_user_id = auth.uid() and bp.bot_id is not null then public._msgr_bot_twin(bp.bot_id) is not distinct from c.id end,
         -- 쓸 수 없는 이유(주인에게만): 'relink' 다시 연결 필요 / 'left_org' 조직을 나가(또는 조직 삭제) 사용할 수 없음. 쓸 수 있으면 NULL.
         case when c.owner_user_id = auth.uid() and bp.bot_id is not null then nullif(coalesce(public._msgr_bot_twin_state(bp.bot_id), 'relink'), 'ready') end
    from public.msgr_crews c
    left join public.msgr_bot_personal bp on bp.crew_id = c.id
    left join public.msgr_bots bb on bb.id = bp.bot_id
   where c.org_id is null and c.status <> 'available'
     and (c.owner_user_id = auth.uid()
          or exists (select 1 from public.msgr_channel_members cm join public.msgr_channels ch on ch.id = cm.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = ch.id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where cm.member_kind = 'crew' and cm.member_id = c.id)
          -- 대기 중인 넣기 요청 — 요청이 걸린 개인 방의 사람 구성원만(방 밖 사람·다른 방 사람은 못 본다)
          or exists (select 1 from public.msgr_channel_crew_requests q join public.msgr_channels ch on ch.id = q.channel_id and ch.org_id is null
                      join public.msgr_channel_members me on me.channel_id = q.channel_id and me.member_kind = 'user' and me.member_id = auth.uid()
                     where q.crew_id = c.id and q.status = 'pending'))
$$;
revoke all on function public.msgr_personal_room_crews() from public, anon;
grant execute on function public.msgr_personal_room_crews() to authenticated;
