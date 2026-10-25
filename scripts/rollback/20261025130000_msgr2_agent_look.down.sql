-- 되돌림: supabase/migrations/20261025130000_msgr2_agent_look.sql을 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: ① msgr2_agent_set_profile을 지운다(메신저 얼굴·사진·직무·소개 저장이 다시 v2_unsupported가 된다) ② msgr2_agent_sync를 20261020200000 본문으로 되돌린다.
-- 남기는 것: msgr2_agents.avatar_url·bio·role_by_user 칸과 그 값(사람이 고른 사진·소개 — 지우면 사라진다. 칸이 남아도 옛 코드는 읽지 않는다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261025130000_msgr2_agent_look.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr2_agent_set_profile(uuid, jsonb);
-- 20261020200000 본문
create or replace function public.msgr2_agent_sync(p_agents jsonb) returns integer
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); n integer := 0; k integer; a jsonb;
begin
  if uid is null then raise exception 'msgr2_signin_required' using errcode = '42501'; end if;
  if not public._msgr2_device_ok() then raise exception 'msgr2_device_invalid' using errcode = '42501'; end if;
  if jsonb_typeof(p_agents) is distinct from 'array' or jsonb_array_length(p_agents) > 500 then raise exception 'msgr2_bad_agents' using errcode = '22023'; end if;
  for a in select * from jsonb_array_elements(p_agents) loop
    if coalesce(a->>'ws_id', '') = '' or coalesce(a->>'slug', '') = '' then raise exception 'msgr2_bad_agents' using errcode = '22023'; end if;
    insert into public.msgr2_agents as t (owner_user_id, ws_id, slug, display_name, role_text, face, hosting, status)
    values (uid, a->>'ws_id', a->>'slug', left(coalesce(a->>'display_name', ''), 80), left(coalesce(a->>'role_text', ''), 200), a->'face',
      coalesce(a->>'hosting', 'local'), coalesce(a->>'status', 'active'))
    on conflict (owner_user_id, ws_id, slug) do update set
      display_name = excluded.display_name, role_text = excluded.role_text, face = excluded.face, hosting = excluded.hosting, status = excluded.status, updated_at = now()
    where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from (excluded.display_name, excluded.role_text, excluded.face, excluded.hosting, excluded.status);
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;
commit;
