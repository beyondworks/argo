-- 봇 = 외부 에이전트 한 명(헤르메스 프로필 하나, 오픈클로 에이전트 하나). 앱이 그 컴퓨터의 에이전트 전원을 읽어 각각 봇을 만들고(유건 지시 2026-09-08
-- "헤르메스랑 오픈클로도 전원 다 불러오는 게 맞다"), 다시 연결할 때 같은 에이전트를 찾도록 원본 id를 기록한다: external_id = '<kind>:<agent id>'.
-- 이름은 종류 라벨이 아니라 그 에이전트의 이름(프로필·에이전트 이름)을 쓴다.
alter table public.msgr_bots add column if not exists external_id text;
create unique index if not exists msgr_bots_org_external on public.msgr_bots (org_id, external_id) where external_id is not null and revoked_at is null;

drop function if exists public.msgr_bot_create(uuid, text, text, text);
create or replace function public.msgr_bot_create(org uuid, kind text, name text, role_text text default null, external_id text default null) returns jsonb
  language plpgsql security definer set search_path = public, extensions, pg_temp as $$
declare me uuid := auth.uid(); token text; crew uuid; bid uuid; nm text := btrim(coalesce(name, '')); ext text := nullif(btrim(coalesce(external_id, '')), '');
begin
  if me is null or public.msgr_is_admin(org) is not true then raise exception 'msgr_admin_only' using detail = 'only org owner/admin can add an agent bot'; end if;
  if public.msgr_org_locked(org) then raise exception 'msgr_org_locked'; end if;
  if nm = '' or nm ~ '[\n\r]' then raise exception 'msgr_bot_name' using detail = 'bot name is required (single line)'; end if;
  if ext is not null and exists (select 1 from public.msgr_bots b where b.org_id = org and b.external_id = ext and b.revoked_at is null) then
    raise exception 'msgr_bot_exists' using detail = 'a bot for this agent already exists — rotate it instead';
  end if;
  token := 'argo_bot_' || encode(gen_random_bytes(24), 'hex');
  perform set_config('msgr.bot_create', '1', true);
  insert into public.msgr_crews (org_id, owner_user_id, ws_id, slug, display_name, role_text, hosting, status, allow)
    values (org, me, 'bot', 'bot-' || left(replace(gen_random_uuid()::text, '-', ''), 12), nm, coalesce(nullif(btrim(role_text), ''), kind || ' agent'), 'bot', 'active', 'all')
    returning id into crew;
  perform set_config('msgr.bot_create', '', true);
  insert into public.msgr_bots (org_id, crew_id, kind, name, token_hash, token_hint, created_by, external_id)
    values (org, crew, kind, nm, public.msgr_bot_hash(token), left(token, 12), me, ext) returning id into bid;
  perform public.msgr_audit(org, 'bot.create', 'bot', bid::text, jsonb_build_object('kind', kind, 'name', nm, 'crew', crew, 'external_id', ext));
  return jsonb_build_object('bot_id', bid, 'crew_id', crew, 'token', token);
end $$;
revoke all on function public.msgr_bot_create(uuid, text, text, text, text) from public;
grant execute on function public.msgr_bot_create(uuid, text, text, text, text) to authenticated;
