-- 에이전트 기억 회수 판정(유건 결정 2026-10-03 — 에이전트는 한 사람, 채널·조직에서 빠지면 그 기억을 회수한다).
-- 본체가 PC에 남은 채널 기록(chats/<slug>.json의 채널 범위 줄·채널 세션·전사)을 지울지 (에이전트, 채널) 쌍마다 묻는다. 회사당 한 번에(p_slugs[i], p_ids[i] 쌍).
-- present = 호출자(주인)의 같은 에이전트(ws_id + slug) 행 가운데 하나라도 그 채널에 들어 있음(msgr_crew_in_channel — 참여 행·제외 목록·공간 일치).
--   개인 행과 조직 행이 여럿이어도 한 사람으로 본다 — 어느 공간의 행이든 채널에 남아 있으면 지우지 않는다.
--   보관 채널·소프트 삭제 조직은 참여 행이 남아 있어 present(30일 복구 가능), 채널 삭제·조직 하드 삭제·회수(available)·오프보딩(detached)·제외 목록은 false.
-- 남의 채널 존재 여부는 새지 않는다 — 없는 채널과 내 에이전트가 없는 채널이 똑같이 false다. 로그인 없으면 답 없음(본체는 답 없는 쌍을 지우지 않는다).
-- 읽기 전용(쓰기 0), 500쌍 상한.
create or replace function public.msgr_crew_presence(p_ws text, p_slugs text[], p_ids uuid[]) returns table (slug text, id uuid, present boolean)
  language sql stable security definer set search_path = public, pg_temp as $$
    select x.slug, x.id, exists (
      select 1 from public.msgr_crews c
       where c.owner_user_id = auth.uid() and c.ws_id = p_ws and c.slug = x.slug
         and public.msgr_crew_in_channel(x.id, c.id)
    )
      from unnest(p_slugs[1:500], p_ids[1:500]) x(slug, id)
     where auth.uid() is not null and x.slug is not null and x.id is not null
$$;
revoke all on function public.msgr_crew_presence(text, text[], uuid[]) from public, anon;
grant execute on function public.msgr_crew_presence(text, text[], uuid[]) to authenticated;
notify pgrst, 'reload schema';
