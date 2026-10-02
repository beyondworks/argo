-- 링크 미리보기(2026-10-02 유건 요청) — 메시지의 첫 링크 하나를 보낼 때 한 번만 가져와 그 글의 meta.link_preview에 저장한다.
-- 읽는 사람마다·화면을 그릴 때마다 다시 가져오지 않는다(DB 위생). 저장된 meta가 곧 캐시라 별도 캐시 표는 만들지 않는다.
--   사람 글: 보내는 기기가 엣지 함수 msgr-link-preview를 한 번 부르고, 엣지 함수가 그 사람 권한으로 이 RPC를 부른다.
--   에이전트 글: 본체 게이트웨이가 보내기 전에 직접 가져와 insert 때 meta에 넣는다(이 RPC를 거치지 않는다).
-- 이 RPC가 지키는 것: 작성자 본인 글만 · 보낸 지 10분 안 · 한 번만(이미 있으면 그대로) · 지운 글·나간 방 제외 ·
--   meta의 link_preview 칸만 바꾼다 · 모양 검사(허용 키, 길이, url은 본문에 실제로 있는 링크, 이미지는 https만).
-- 1:1·개인 방(kind='dm')은 msgr_dm_routing_immutable이 meta 변경을 통째로 막는다 — 이 RPC 안에서만, link_preview 칸만 바뀔 때 통과시킨다.
-- link_preview 칸은 이 RPC로만 바뀐다(가드 트리거) — 일반 수정(본문 고치기)이 검사 안 된 카드를 넣지 못하게. 에이전트 글의 insert는 대상 밖.
-- 부하: 링크가 든 사람 글 1건당 엣지 함수 호출 1 + 글 조회 1 + 이 RPC 1(행 갱신 1, 방송 1). 링크 없는 글은 호출 0. 주기 작업 없음.

create or replace function public.msgr_dm_routing_immutable() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if exists(select 1 from msgr_channels where id=old.channel_id and kind='dm')
 and (new.mentions is distinct from old.mentions or (new.thread_root is distinct from old.thread_root and not (pg_trigger_depth()>1 and new.thread_root is null)) or (new.reply_to is distinct from old.reply_to and not (pg_trigger_depth()>1 and new.reply_to is null))
      or (new.meta is distinct from old.meta
          -- 링크 미리보기 RPC(msgr_set_link_preview) 안에서 link_preview 칸만 바뀌는 경우는 라우팅 변경이 아니다
          and not (coalesce(current_setting('argo.msgr_link_preview', true), '') = '1'
                   and (coalesce(new.meta, '{}'::jsonb) - 'link_preview') is not distinct from (coalesce(old.meta, '{}'::jsonb) - 'link_preview'))))
 then raise exception 'msgr_dm_routing_immutable' using errcode='42501'; end if;
 return new;
end $$;
revoke all on function public.msgr_dm_routing_immutable() from public, anon, authenticated;

create or replace function public.msgr_link_preview_guard() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if (new.meta -> 'link_preview') is distinct from (old.meta -> 'link_preview')
     and coalesce(current_setting('argo.msgr_link_preview', true), '') <> '1' then
    raise exception 'msgr_link_preview_rpc_only' using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.msgr_link_preview_guard() from public, anon, authenticated;
drop trigger if exists msgr_link_preview_guard on public.msgr_messages;
create trigger msgr_link_preview_guard before update of meta on public.msgr_messages
  for each row execute function public.msgr_link_preview_guard();

create or replace function public.msgr_set_link_preview(p_message bigint, p_preview jsonb) returns boolean
language plpgsql security definer set search_path=public,pg_temp as $$
declare me uuid := auth.uid(); m public.msgr_messages; k text; t text; p jsonb;
begin
  if me is null then raise exception 'msgr_auth_required' using errcode = '42501'; end if;
  select * into m from public.msgr_messages where id = p_message for update;
  if m.id is null or m.author_kind <> 'user' or m.author_user_id is distinct from me then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if m.deleted_at is not null or m.kind <> 'text' or m.created_at < now() - interval '10 minutes'
     or coalesce(m.meta, '{}'::jsonb) ? 'link_preview' or not public.msgr_can_read_channel(m.channel_id) then return false; end if;
  if jsonb_typeof(p_preview) is distinct from 'object' then raise exception 'msgr_bad_preview' using errcode = '22023'; end if;
  for k in select jsonb_object_keys(p_preview) loop
    if k not in ('v', 'url', 'title', 'description', 'image', 'site') then raise exception 'msgr_bad_preview' using errcode = '22023'; end if;
    if k <> 'v' and jsonb_typeof(p_preview -> k) <> 'string' then raise exception 'msgr_bad_preview' using errcode = '22023'; end if;
  end loop;
  p := jsonb_build_object('v', 1, 'url', coalesce(p_preview ->> 'url', ''), 'title', coalesce(p_preview ->> 'title', ''),
                          'description', coalesce(p_preview ->> 'description', ''), 'image', coalesce(p_preview ->> 'image', ''), 'site', coalesce(p_preview ->> 'site', ''));
  t := p ->> 'url';
  if length(t) > 2048 or t !~ '^https?://[^[:space:]]+$' or strpos(m.body, t) = 0 then raise exception 'msgr_bad_preview' using errcode = '22023'; end if;
  if char_length(p ->> 'title') > 200 or char_length(p ->> 'description') > 300 or char_length(p ->> 'site') > 80
     or (p ->> 'title') = '' and (p ->> 'description') = ''
     or ((p ->> 'image') <> '' and (length(p ->> 'image') > 2048 or (p ->> 'image') !~ '^https://[^[:space:]]+$')) then
    raise exception 'msgr_bad_preview' using errcode = '22023';
  end if;
  perform set_config('argo.msgr_link_preview', '1', true);
  update public.msgr_messages set meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('link_preview', p) where id = m.id;
  perform set_config('argo.msgr_link_preview', '', true);
  -- 이미 글을 받은 화면이 카드를 붙이도록 'edit'(그 글 다시 읽기) — 첨부 방송(msgr_attachment_broadcast)과 같은 수신자 규칙
  p := jsonb_build_object('id', m.id, 'message_id', m.id, 'channel_id', m.channel_id);
  if m.org_id is null then perform realtime.send(p, 'edit', 'dm:' || m.channel_id::text, true); end if;
  perform public.msgr_room_send(p, 'edit', m.org_id, m.channel_id);
  return true;
end $$;
revoke all on function public.msgr_set_link_preview(bigint, jsonb) from public, anon;
grant execute on function public.msgr_set_link_preview(bigint, jsonb) to authenticated;

notify pgrst, 'reload schema';
