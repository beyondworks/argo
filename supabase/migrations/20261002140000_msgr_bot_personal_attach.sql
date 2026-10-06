-- 외부 봇(헤르메스·오픈클로)이 개인 방에서 파일을 주고받는다(2026-10-02 유건 요청).
-- 막혀 있던 이유: 보내기 — _msgr_bot_attach_target이 조직 글(org_id = 봇 조직, crew_id = 봇 크루)만 받았다. 개인 방 글은 쌍둥이 크루(#794, msgr_bot_personal)가
--   쓰고 org_id가 NULL이라 항상 msgr_bot_bad_attach_target. 받기 — msgr_bot_file이 첨부를 org_id = 봇 조직으로만 찾았고, 개인 배달(_msgr_bot_personal_updates)은
--   첨부를 '[]'로 고정했다(그때는 개인 첨부가 없었다).
-- 변경(조직 경로·조직 판정은 그대로 — 아래 함수마다 조직 갈래는 가장 최근 정의 본문 그대로다):
--   보내기: 개인 방 글이면 그 글이 이 봇의 쓸 수 있는 쌍둥이(_msgr_bot_twin) 글이고, 쌍둥이가 지금 그 방 구성원이고, 방이 보관되지 않았을 때만.
--           경로는 개인 방 규칙 p/<channel>/<message>/bot-<8>-<이름>(20261002100000), 첨부 행 org_id NULL. 글당 10개·25MB·1시간 규칙은 같다.
--   받기:   개인 방 첨부는 쌍둥이가 그 방 구성원이고, 주인 글(명시적 동의)·주인 크루 글의 파일일 때만 msgr_bot_file이 내주고 개인 배달에도 싣는다.
--           친구 글의 파일은 문맥과 같은 이유(M4 — 회사 도구·기억을 가진 에이전트에게 친구 글을 넘기지 않는다)로 넘기지 않는다.
-- 정의 출처: _msgr_bot_attach_target·msgr_bot_attach_prepare·msgr_bot_attach_commit = 20260930160000, msgr_bot_file = 20260927140000,
--           _msgr_bot_personal_updates = 20261001140000. 권한(grant/revoke)도 같게 다시 건다.
-- 엣지 함수 msgr-bot은 RPC가 준 경로를 그대로 서명하므로 바뀌지 않는다. 부하: 파일당 RPC 2(준비·등록) + 서명 업로드 1 — 조직 봇과 같다.

create or replace function public._msgr_bot_attach_target(b public.msgr_bots, p_message bigint) returns public.msgr_messages
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m public.msgr_messages; tw uuid;
begin
  select * into m from public.msgr_messages where id = p_message and author_kind = 'crew' and deleted_at is null;
  if m.id is not null and m.org_id is null then -- 개인 방 — 쌍둥이 글에만
    tw := public._msgr_bot_twin(b.id);
    if tw is null then raise exception 'msgr_not_allowed' using detail = 'personal use of this agent needs a reconnect'; end if;
    if m.crew_id is distinct from tw then raise exception 'msgr_bot_bad_attach_target'; end if;
    if not exists (select 1 from public.msgr_channels c where c.id = m.channel_id and c.org_id is null and c.archived_at is null) then raise exception 'msgr_bot_bad_attach_target'; end if;
    if m.created_at < now() - interval '1 hour' then raise exception 'msgr_bot_attach_expired'; end if;
    if not public.msgr_crew_in_channel(m.channel_id, tw) then raise exception 'msgr_bot_not_member'; end if;
    return m;
  end if;
  -- 조직 글 — 20260930160000 본문 그대로
  select * into m from public.msgr_messages where id = p_message and org_id = b.org_id and author_kind = 'crew' and crew_id = b.crew_id and deleted_at is null;
  if m.id is null then raise exception 'msgr_bot_bad_attach_target'; end if;
  if public.msgr_org_locked(b.org_id) or not exists (select 1 from public.msgr_crews c join public.msgr_org_members om on om.org_id = c.org_id and om.user_id = c.owner_user_id and om.removed_at is null
    where c.id = b.crew_id and c.status = 'active') then raise exception 'msgr_not_allowed'; end if; -- msgr_bot_send와 같은 조건
  if m.created_at < now() - interval '1 hour' then raise exception 'msgr_bot_attach_expired'; end if;
  if not public.msgr_crew_in_channel(m.channel_id, b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
  return m;
end $$;
revoke all on function public._msgr_bot_attach_target(public.msgr_bots, bigint) from public, anon, authenticated;

-- 준비: 20260930160000 본문 + 경로 첫 칸 = coalesce(org_id, 'p'). 정리 대상(2시간 지난 미등록 bot- 객체)도 이 봇의 개인 쌍둥이 글까지.
create or replace function public.msgr_bot_attach_prepare(token text, p_message bigint, p_name text, p_bytes bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; raw text := btrim(coalesce(p_name, '')); dot int; stem text; ext text; purge jsonb; space text; tw uuid;
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if raw = '' or length(raw) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'msgr_bot_bad_file_size'; end if;
  if p_bytes > 26214400 then raise exception 'msgr_bot_file_too_large'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  space := coalesce(m.org_id::text, 'p');
  tw := public._msgr_bot_twin(b.id);
  if (select count(*) from storage.objects o where o.bucket_id = 'msgr' and o.name like space || '/' || m.channel_id::text || '/' || m.id::text || '/bot-%') >= 10
    then raise exception 'msgr_bot_too_many_files'; end if; -- 올린 객체 기준(등록 안 한 것 포함) — 등록 없이 올리기만 반복해도 글당 10개
  dot := length(raw) - strpos(reverse(raw), '.') + 1;
  if strpos(raw, '.') = 0 or dot <= 1 then stem := raw; ext := '';
  else stem := left(raw, dot - 1); ext := left(regexp_replace(substr(raw, dot + 1), '[^A-Za-z0-9]', '', 'g'), 12); end if;
  stem := left(regexp_replace(regexp_replace(stem, '[^A-Za-z0-9._-]+', '_', 'g'), '^[_.]+|[_.]+$', '', 'g'), 60);
  select coalesce(jsonb_agg(o.name), '[]'::jsonb) into purge from (
    select o.name from storage.objects o join public.msgr_messages x on x.id = (substring(o.name from '^(?:[0-9a-f-]{36}|p)/[0-9a-f-]{36}/([0-9]{1,18})/bot-'))::bigint
     where o.bucket_id = 'msgr' and o.name ~ '^([0-9a-f-]{36}|p)/[0-9a-f-]{36}/[0-9]{1,18}/bot-[0-9a-f]{8}-' and o.created_at < now() - interval '2 hours'
       and x.author_kind = 'crew' and ((x.crew_id = b.crew_id and x.org_id = b.org_id) or (tw is not null and x.crew_id = tw and x.org_id is null))
       and split_part(o.name, '/', 1) = coalesce(x.org_id::text, 'p') and split_part(o.name, '/', 2) = x.channel_id::text -- 폴더의 공간·방이 그 글과 같을 때만(재검수 LOW)
       and not exists (select 1 from public.msgr_attachments a where a.storage_path = o.name)
     order by o.created_at limit 20) o;
  return jsonb_build_object('purge', purge, 'storage_path', space || '/' || m.channel_id::text || '/' || m.id::text || '/bot-'
    || left(replace(gen_random_uuid()::text, '-', ''), 8) || '-' || coalesce(nullif(stem, ''), 'file') || case when ext <> '' then '.' || ext else '' end);
end $$;
revoke all on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) from public;
grant execute on function public.msgr_bot_attach_prepare(text, bigint, text, bigint) to anon, authenticated;

-- 등록: 20260930160000 본문 + 경로 첫 칸 = coalesce(org_id, 'p'), 첨부 행 org_id = 글의 org_id(개인 방이면 NULL — msgr_attachments_space_path CHECK와 맞는다)
create or replace function public.msgr_bot_attach_commit(token text, p_message bigint, p_path text, p_name text, p_mime text default null) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare b public.msgr_bots; m public.msgr_messages; obj record; got uuid; nm text := btrim(coalesce(p_name, ''));
begin
  b := public.msgr_bot_auth(token);
  if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
  if nm = '' or length(nm) > 200 then raise exception 'msgr_bot_bad_file_name'; end if;
  m := public._msgr_bot_attach_target(b, p_message);
  if coalesce(p_path, '') !~ ('^' || coalesce(m.org_id::text, 'p') || '/' || m.channel_id::text || '/' || m.id::text || '/bot-[0-9a-f]{8}-[A-Za-z0-9._-]{1,80}$') then
    raise exception 'msgr_bot_bad_attach_path';
  end if;
  perform 1 from public.msgr_messages where id = m.id for update; -- 같은 글의 등록을 한 줄로 세운다(개수 상한·같은 경로 중복 등록)
  select id into got from public.msgr_attachments where message_id = m.id and storage_path = p_path;
  if got is not null then return got; end if;
  select (o.metadata->>'size')::bigint as bytes, o.metadata->>'mimetype' as mime into obj from storage.objects o where o.bucket_id = 'msgr' and o.name = p_path;
  if not found then raise exception 'msgr_bot_upload_missing'; end if;
  if coalesce(obj.bytes, 0) > 26214400 then raise exception 'msgr_bot_file_too_large'; end if;
  if (select count(*) from public.msgr_attachments where message_id = m.id) >= 10 then raise exception 'msgr_bot_too_many_files'; end if;
  insert into public.msgr_attachments(message_id, org_id, storage_path, name, mime, bytes)
    values (m.id, m.org_id, p_path, nm, left(coalesce(nullif(btrim(p_mime), ''), obj.mime), 200), coalesce(obj.bytes, 0))
    returning id into got;
  return got;
end $$;
revoke all on function public.msgr_bot_attach_commit(text, bigint, text, text, text) from public;
grant execute on function public.msgr_bot_attach_commit(text, bigint, text, text, text) to anon, authenticated;

-- 받기: 20260927140000 본문(조직 갈래 그대로) + 개인 방 갈래
create or replace function public.msgr_bot_file(token text,attachment uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare b msgr_bots; a msgr_attachments; s msgr_messages; ch msgr_channels; tw uuid;
begin
 b:=msgr_bot_auth(token); if b.id is null then raise exception 'msgr_bot_unauthorized'; end if;
 select * into a from msgr_attachments where id=attachment and org_id is null;
 if a.id is not null then -- 개인 방 첨부 — 이 봇의 쌍둥이가 그 방 구성원일 때만, 글 작성자는 명시적 동의(개인 공간 규칙)
   select * into s from msgr_messages where id=a.message_id and deleted_at is null and org_id is null;
   select * into ch from msgr_channels where id=s.channel_id and archived_at is null and org_id is null;
   if s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>'p' or split_part(a.storage_path,'/',2)<>s.channel_id::text or split_part(a.storage_path,'/',3)<>s.id::text then raise exception 'msgr_bot_no_file'; end if;
   tw:=public._msgr_bot_twin(b.id);
   if tw is null then raise exception 'msgr_not_allowed' using detail = 'personal use of this agent needs a reconnect'; end if;
   if not msgr_crew_in_channel(ch.id,tw) then raise exception 'msgr_bot_not_member'; end if;
   -- 개인 배달과 같은 범위 — 주인 글(명시적 동의)·주인 크루 글의 파일만. 친구 글의 파일은 id를 알아도 내주지 않는다(M4)
   if not ((s.author_kind='user' and s.author_user_id=(select owner_user_id from msgr_crews where id=tw) and public.msgr_ai_consent_ok_for(s.author_user_id, true))
        or (s.author_kind='crew' and exists (select 1 from msgr_crews oc where oc.id=s.crew_id and oc.owner_user_id=(select owner_user_id from msgr_crews where id=tw)))) then
     raise exception 'msgr_bot_no_file';
   end if;
   return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
 end if;
 select * into a from msgr_attachments where id=attachment and org_id=b.org_id;
 select * into s from msgr_messages where id=a.message_id and deleted_at is null;
 select * into ch from msgr_channels where id=s.channel_id and archived_at is null;
 if a.id is null or s.id is null or ch.id is null or split_part(a.storage_path,'/',1)<>s.org_id::text or split_part(a.storage_path,'/',2)<>s.channel_id::text or split_part(a.storage_path,'/',3)<>s.id::text then raise exception 'msgr_bot_no_file'; end if;
 if ch.kind='dm' then
   if not msgr_crew_in_channel(ch.id,b.crew_id) and not msgr_dm_access(b.crew_id,coalesce(s.thread_root,s.id),false) then raise exception 'msgr_bot_not_member'; end if;
 elsif not msgr_crew_in_channel(ch.id,b.crew_id) then raise exception 'msgr_bot_not_member'; end if;
 -- 검수 L-5(2차 재검수, 선택 적용) — 파일을 올린 글의 작성자가 동의하지 않았으면(거부·철회, 전환 기간 지남) 파일도 감춘다.
 if s.author_kind='user' and not public.msgr_ai_consent_visible(s.author_user_id) then raise exception 'msgr_bot_no_file'; end if;
 return jsonb_build_object('file_id',a.id,'file_name',a.name,'mime_type',a.mime,'file_size',a.bytes,'storage_path',a.storage_path);
end $$;
revoke all on function public.msgr_bot_file(text, uuid) from public;
grant execute on function public.msgr_bot_file(text, uuid) to anon, authenticated;

-- 개인 배달: 20261001140000 본문 그대로 + 첨부 한 줄(위 머리 주석)
create or replace function public._msgr_bot_personal_updates(p_bot uuid, p_twin uuid, after_id bigint, lim int) returns setof jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare bp public.msgr_bot_personal; tw public.msgr_crews; cur bigint; lo bigint; key text; s public.msgr_messages; r public.msgr_messages; ch public.msgr_channels;
  a uuid; won uuid; n int := 0; peers jsonb; ctx jsonb; r_json jsonb; pending boolean := false; waited boolean := false; maxid bigint := 0; cap int;
begin
  select * into bp from public.msgr_bot_personal where bot_id = p_bot;
  select * into tw from public.msgr_crews where id = p_twin;
  if bp.bot_id is null or tw.id is null then return; end if;
  cap := greatest(1, least(coalesce(lim, 50), 100));
  cur := coalesce(tw.cursor_msg_id, 0);
  lo := greatest(cur, least(coalesce(after_id, 0), coalesce(bp.personal_sent_id, cur))); -- H3: 개인으로 실제 보낸 데까지만 ack
  key := public._msgr_bot_personal_key(p_twin, lo, tw.owner_user_id);
  if bp.scan_key = key and lo = cur and (not bp.scan_pending or bp.scan_at > now() - interval '30 seconds') then return; end if;
  if lo > cur then update public.msgr_crews set cursor_msg_id = lo where id = p_twin and cursor_msg_id < lo; end if;

  -- 결과 미도착 안내(10분) — 조직 경로와 같은 규칙, 한 번만
  for s in select m.* from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
            where e.crew_id = p_twin and e.state = 'running' and e.heartbeat_at < now() - interval '10 minutes' and public.msgr_delivery_allowed(p_twin, m.id)
              and not exists (select 1 from public.msgr_messages x where x.channel_id = m.channel_id and x.client_msg_id = 'unknown:' || p_twin || ':' || m.id) loop
    insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, reply_to, thread_root, client_msg_id, body, meta)
      values (s.channel_id, 'crew', p_twin, 'system', s.id, coalesce(s.thread_root, s.id), 'unknown:' || p_twin || ':' || s.id,
        '외부 에이전트의 실행 결과가 아직 도착하지 않았습니다. 실행 상태를 확인해 주세요. / The external agent has not returned a result. Check its status.',
        '{"execution_status":"unknown","disposition":"done"}') on conflict do nothing; -- 동시 두 호출(검수 #794 LOW-3)
  end loop;

  -- 후보: 쌍둥이가 든 개인 방(참여 행 기반 — org IS NULL 전역 스캔 금지)의 커서 뒤, 24시간 안, 쌍둥이를 겨냥한 글(to 멘션 또는 크루 1:1의 사람 글)
  for s in with cand as materialized (
      select m.* from public.msgr_channel_members cm
        join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
        join public.msgr_channels c on c.id = m.channel_id and c.org_id is null and c.archived_at is null
       where cm.member_kind = 'crew' and cm.member_id = p_twin
         and m.org_id is null and m.kind = 'text' and m.deleted_at is null and m.created_at > now() - interval '24 hours'
         and m.crew_id is distinct from p_twin
         and (public.msgr_to_mentioned(m.mentions, p_twin) or (m.author_kind = 'user' and c.personal_pair like 'crew:%')))
    select x.* from cand x
     where public.msgr_delivery_allowed(p_twin, x.id)
       and not exists (select 1 from public.msgr_executions e where e.crew_id = p_twin and e.source_msg_id = x.id)
     order by x.id loop
    select * into r from public.msgr_messages where id = case when s.author_kind = 'user' then coalesce(s.thread_root, s.id) else s.thread_root end;
    select * into ch from public.msgr_channels where id = s.channel_id;
    -- 개인 방은 명시적 동의만(#779 H3). 뿌리 작성자는 지시할 수 있는 사람(= 주인)이고 사람 글이면 이번 글 작성자와 같다(msgr_dm_message_guard).
    if not public.msgr_ai_consent_ok_for(r.author_user_id, true) then
      if not exists (select 1 from public.msgr_messages x where x.channel_id = s.channel_id and x.client_msg_id = 'aiconsent:' || p_twin || ':' || s.channel_id) then
        insert into public.msgr_messages (channel_id, author_kind, crew_id, kind, client_msg_id, body, meta)
          values (s.channel_id, 'crew', p_twin, 'system', 'aiconsent:' || p_twin || ':' || s.channel_id,
            '앱을 업데이트하고 AI 이용에 동의하면 크루에게 맡길 수 있습니다. / Update the app and agree to AI use to hand this to a crew.',
            jsonb_build_object('disposition', 'done')) on conflict do nothing; -- 동시 두 호출(검수 #794 LOW-3)
      end if;
      continue;
    end if;
    -- 순차 멘션(>@): 앞의 크루가 아직 답하지 않았으면 기다린다(2분) — 조직 경로와 같은 규칙
    if s.author_kind = 'user' and s.body ~ '>[ \t\r\n]*@' and s.created_at > now() - interval '2 minutes' and exists (
      select 1 from jsonb_array_elements(s.mentions) with ordinality prev(x, pos)
       where prev.x->>'kind' = 'crew' and coalesce(prev.x->>'role', 'to') = 'to'
         and prev.pos < (select min(pos) from jsonb_array_elements(s.mentions) with ordinality own(x, pos) where own.x->>'id' = p_twin::text and coalesce(own.x->>'role', 'to') = 'to')
         and public.msgr_delivery_allowed((prev.x->>'id')::uuid, s.id)
         and not exists (select 1 from public.msgr_messages answer where answer.channel_id = s.channel_id and answer.crew_id::text = prev.x->>'id' and answer.reply_to = s.id)) then
      waited := true; pending := true; exit;
    end if;
    if s.author_kind = 'crew' and public.msgr_delivery_target(p_twin, r.id) and r.body ~ '>[ \t\r\n]*@'
       and not exists (select 1 from public.msgr_messages answer where answer.channel_id = s.channel_id and answer.crew_id = p_twin and answer.reply_to = r.id and answer.id < s.id) then
      continue;
    end if;
    a := gen_random_uuid(); won := null;
    insert into public.msgr_executions (crew_id, source_msg_id, attempt) values (p_twin, s.id, a) on conflict do nothing returning attempt into won;
    if won is null then continue; end if;
    -- 동료: 이 방의 크루 중 뿌리 작성자와 주인 둘 다 지시할 수 있는 것(사실상 주인의 크루)
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.display_name)), '[]') into peers
      from public.msgr_channel_members cm join public.msgr_crews c on c.id = cm.member_id and c.org_id is null and c.status = 'active' and c.id <> p_twin
     where cm.channel_id = ch.id and cm.member_kind = 'crew'
       and public.msgr_can_instruct(c.id, r.author_user_id, ch.id) and public.msgr_can_instruct(c.id, tw.owner_user_id, ch.id)
       and exists (select 1 from public.msgr_channel_members o where o.channel_id = ch.id and o.member_kind = 'user' and o.member_id = c.owner_user_id);
    -- 문맥(M4): 주인 글(명시적 동의)과 주인의 크루 글만 — 친구 글은 회사 도구·기억을 가진 에이전트에게 넘기지 않는다
    select coalesce(jsonb_agg(h.row order by h.id), '[]') into ctx from (
      select m.id, jsonb_build_object('message_id', m.id, 'text', m.body, 'author_kind', m.author_kind, 'crew_id', m.crew_id, 'mentions', m.mentions) as row
        from public.msgr_messages m
       where m.channel_id = ch.id and m.kind = 'text' and m.deleted_at is null
         and (m.id <= s.id or (m.reply_to = s.id and public.msgr_to_mentioned(s.mentions, m.crew_id)))
         and (s.author_kind = 'user' or m.id <= s.id)
         and ((m.author_kind = 'user' and m.author_user_id = tw.owner_user_id and public.msgr_ai_consent_ok_for(m.author_user_id, true))
              or (m.author_kind = 'crew' and exists (select 1 from public.msgr_crews oc where oc.id = m.crew_id and oc.owner_user_id = tw.owner_user_id)))
       order by m.id desc limit 12) h;
    r_json := jsonb_build_object('message_id', r.id, 'text', r.body, 'author_kind', r.author_kind, 'crew_id', r.crew_id, 'mentions', r.mentions);
    if not exists (select 1 from jsonb_array_elements(ctx) x where (x->>'message_id')::bigint = r.id) then ctx := jsonb_build_array(r_json) || ctx; end if;
    return next jsonb_build_object('update_id', s.id, 'message', jsonb_build_object(
      'message_id', s.id, 'execution_attempt', a, 'delivery_role', 'to', 'thread_root', r.id, 'origin_user_id', r.author_user_id, 'delegated', false,
      'personal', true, -- 개인 공간 글(조직 밖) — 어댑터가 조직 기억과 나눌 수 있게
      'chat', jsonb_build_object('id', ch.id, 'kind', ch.kind, 'name', ch.name),
      'from', jsonb_build_object('id', coalesce(s.author_user_id, s.crew_id), 'kind', s.author_kind,
        'name', coalesce((select display_name from public.msgr_crews where id = s.crew_id), public.msgr_person_label(s.author_user_id), '')),
      'date', extract(epoch from s.created_at)::bigint, 'text', s.body, 'reply_to', s.reply_to, 'peers', peers, 'context', ctx,
      -- 개인 방 첨부(20261002100000부터 있다) — 주인 글(명시적 동의)·주인 크루 글의 첨부만. 친구 글의 파일은 문맥과 같은 이유(M4)로 넘기지 않는다
      'attachments', case when (s.author_kind = 'user' and s.author_user_id = tw.owner_user_id and public.msgr_ai_consent_ok_for(s.author_user_id, true))
                             or (s.author_kind = 'crew' and exists (select 1 from public.msgr_crews oc where oc.id = s.crew_id and oc.owner_user_id = tw.owner_user_id))
                          then (select coalesce(jsonb_agg(jsonb_build_object('file_id', f.id, 'file_name', f.name, 'mime_type', f.mime, 'file_size', f.bytes)), '[]') from public.msgr_attachments f where f.message_id = s.id)
                          else '[]'::jsonb end,
      'mentioned', public.msgr_to_mentioned(s.mentions, p_twin)));
    n := n + 1; maxid := greatest(maxid, s.id);
    exit when n >= cap;
  end loop;

  if n > 0 then
    -- 처음 개인 글을 보낼 때 조직 기록값이 없으면 지금 조직 커서에서 시작한다(그 뒤로는 조직 배달마다 msgr_bot_updates가 올린다)
    update public.msgr_bot_personal p set personal_sent_id = greatest(coalesce(p.personal_sent_id, 0), maxid),
        org_sent_id = greatest(coalesce(p.org_sent_id, 0), (select coalesce(oc.cursor_msg_id, 0) from public.msgr_bots b join public.msgr_crews oc on oc.id = b.crew_id where b.id = p_bot)),
        scan_key = null -- 다음 호출이 이어서 훑는다(한도 때문에 남은 후보)
      where p.bot_id = p_bot;
    return;
  end if;
  -- 보류: 결과를 기다리는 실행(안내 전)이 있으면 30초마다 다시 본다. 안내를 실제로 남길 수 있는 실행만 — 배달 판정이 거짓이 된 실행(글 삭제·방 보관·
  -- 나가기·차단)은 안내도 답도 못 남겨 running으로 남는다. 그런 실행이나 11분(안내 기한 10분 + 한 번 더 볼 여유)이 지난 실행은 기다리지 않는다
  -- (검수 #794 M-1 — 끝나지 않는 보류가 30초마다 msgr_bot_personal을 다시 썼다).
  pending := pending or exists (select 1 from public.msgr_executions e join public.msgr_messages m on m.id = e.source_msg_id
     where e.crew_id = p_twin and e.state = 'running' and e.heartbeat_at > now() - interval '11 minutes'
       and not exists (select 1 from public.msgr_messages x where x.channel_id = m.channel_id and x.client_msg_id = 'unknown:' || p_twin || ':' || m.id)
       and public.msgr_delivery_allowed(p_twin, m.id));
  if not waited then
    -- 아무것도 못 준 스캔 — 커서를 당긴다. 10분 안의 글과 24시간 안의 겨냥 글(아직 실행 기록 없음) 앞에서 멈춘다.
    -- least()는 NULL을 무시한다 — 넘길 끝(10분 넘은 글의 최댓값)이 없으면 움직이지 않는다(case).
    update public.msgr_crews c set cursor_msg_id = x.id from (
      select case when a2.id is not null then least(a2.id,
          (select min(m.id) - 1 from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
            where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at >= now() - interval '10 minutes'),
          (select min(m.id) - 1 from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
             join public.msgr_channels d on d.id = m.channel_id
            where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at >= now() - interval '24 hours'
              and m.kind = 'text' and m.deleted_at is null and m.crew_id is distinct from p_twin
              and (public.msgr_to_mentioned(m.mentions, p_twin) or (m.author_kind = 'user' and d.personal_pair like 'crew:%'))
              and not exists (select 1 from public.msgr_executions e where e.crew_id = p_twin and e.source_msg_id = m.id))) end as id
        from (select max(m.id) as id from public.msgr_channel_members cm join public.msgr_messages m on m.channel_id = cm.channel_id and m.id > lo
               where cm.member_kind = 'crew' and cm.member_id = p_twin and m.created_at < now() - interval '10 minutes') a2) x
     where c.id = p_twin and x.id is not null and c.cursor_msg_id < x.id;
  end if;
  select cursor_msg_id into cur from public.msgr_crews where id = p_twin;
  update public.msgr_bot_personal set scan_key = public._msgr_bot_personal_key(p_twin, cur, tw.owner_user_id), scan_at = now(), scan_pending = pending
   where bot_id = p_bot;
end $$;
revoke all on function public._msgr_bot_personal_updates(uuid, uuid, bigint, int) from public, anon, authenticated;

notify pgrst, 'reload schema';
