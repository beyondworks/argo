-- 방에 없는 에이전트를 부르면 거절 안내가 그 방에 닿게 한다(2026-09-18 Argo Dev E2E 실측).
-- 거절 안내는 에이전트 명의의 system 글인데, 채널 범위 트리거(9/12)가 "방에 없는 에이전트의 글"을 막아
-- 게이트웨이가 로그만 남기고 건너뛰었다 — 멘션한 사람에게 아무 반응이 없었다(#577로 닫은 조용한 소실과 같은 모양).
-- "방에 들어온 에이전트는 방 전원이 부린다"(20260918150000) 뒤로는 거절의 주된 경우가 바로 "에이전트가 방에 없을 때"다.
--
-- 그래서 **받은 멘션에 대한 거절 안내만** 좁게 연다. 여는 조건은 전부 서버가 확인한다:
--   kind='system' · client_msg_id = 'deny:<이 에이전트>:<reply_to>' · reply_to가 **같은 채널**에 실재하고 삭제되지 않았으며
--   **이 에이전트를 멘션한 글** · 안내 자신은 아무도 멘션하지 않는다(넘김 통로가 되지 않게).
-- 이 조건이 없으면 에이전트 주인의 브리지가 deny: 접두사만 붙여 자기 에이전트가 없는 방에 아무 글이나 넣을 수 있다.
-- 에이전트 주인이 그 방에 쓸 수 없으면(주인 없는 비공개 방·DM) 메시지 RLS(msgr_can_write_channel)가 먼저 막는다 — 이 파일은 넓히지 않는다.
-- 나머지(방에 있는 에이전트, DM 위임 답글)는 20260913122421 정의 그대로다.
create or replace function public.msgr_messages_crew_scope_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.author_kind='crew' and new.crew_id is not null and not msgr_crew_in_channel(new.channel_id,new.crew_id)
 and not (exists(select 1 from msgr_channels where id=new.channel_id and kind='dm') and msgr_delivery_allowed(new.crew_id,new.reply_to))
 and not (new.kind='system' and new.reply_to is not null and new.client_msg_id = 'deny:'||new.crew_id||':'||new.reply_to
          and (new.mentions is null or new.mentions = '[]'::jsonb)
          and exists(select 1 from msgr_messages s where s.id=new.reply_to and s.channel_id=new.channel_id and s.deleted_at is null
                      and exists(select 1 from jsonb_array_elements(coalesce(s.mentions,'[]'::jsonb)) x where x->>'kind'='crew' and x->>'id'=new.crew_id::text)))
 then raise exception 'msgr_crew_not_in_channel' using errcode='42501',hint='이 채널에 초대되지 않았거나 내보낸 에이전트입니다'; end if;
 return new;
end $$;
