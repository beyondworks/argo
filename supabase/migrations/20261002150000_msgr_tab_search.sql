-- 폰 채팅·채널 탭 검색의 본문 찾기(기능 점검 D9) — 서버 범위를 묶는다(분리 검수 MEDIUM, 2026-10-02).
-- 전에는 앱이 msgr_messages를 공간(org_id) 전체로 ilike 하며 최근 300건을 모았다. 맞는 글이 적으면 공간의 글을 끝까지 훑고,
-- 행마다 RLS(msgr_can_read_channel)를 다시 평가했다 — 입력이 멈출 때마다 한 번이라도 공간이 크면 무겁다.
-- 이 함수는 내가 든 방(msgr_channel_members)만, 방마다 최근 500개 글(삭제 글 제외) 안에서 찾고, 맞은 방 id만 최대 200개 돌려준다.
--   방 고르기는 msgr_channel_latest·msgr_dm_personal_list와 같은 모양(공간의 채널 → 참여 행 기본 키 확인), 글은 (channel_id, id) 색인 역순으로
--   방마다 첫 맞는 글에서 멈춘다. 일은 "내 방 수 × 최대 500행"을 넘지 않는다. 읽기만 한다(쓰기 0). 부르는 때: 검색 칸을 연 동안 두 글자부터,
--   입력이 300ms 멈췄을 때 한 번(앱) — 주기 호출 없음.
-- 차단한 사람의 글·숨긴 에이전트(msgr_user_blocks.blocked_crew)의 글로는 찾지 않는다(앱이 하던 거르기를 서버가 한다).
-- 검색어의 %·_·\는 글자 그대로(ilike 와일드카드가 아니다). 2~100자만. 개인 공간은 org = null.
create or replace function public.msgr_tab_search(org uuid, q text)
returns table (channel_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with me as (
    select auth.uid() as uid,
           '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%' as pat
  )
  select c.id
    from me
    join public.msgr_channels c on c.archived_at is null and (c.org_id = org or (org is null and c.org_id is null))
   where me.uid is not null
     and char_length(btrim(coalesce(q, ''))) between 2 and 100
     and exists (select 1 from public.msgr_channel_members cm
                  where cm.channel_id = c.id and cm.member_kind = 'user' and cm.member_id = me.uid)
     and public.msgr_can_read_channel(c.id)
     and exists (
       select 1
         from (select m.body, m.author_kind, m.author_user_id, m.crew_id
                 from public.msgr_messages m
                where m.channel_id = c.id and m.deleted_at is null
                order by m.id desc limit 500) w
        where w.body ilike me.pat
          and not (w.author_kind = 'user' and exists (select 1 from public.msgr_user_blocks b where b.blocker = me.uid and b.blocked = w.author_user_id))
          and not (w.author_kind = 'crew' and exists (select 1 from public.msgr_user_blocks b where b.blocker = me.uid and b.blocked_crew = w.crew_id)))
   limit 200
$$;
revoke all on function public.msgr_tab_search(uuid, text) from public, anon;
grant execute on function public.msgr_tab_search(uuid, text) to authenticated;

notify pgrst, 'reload schema';
