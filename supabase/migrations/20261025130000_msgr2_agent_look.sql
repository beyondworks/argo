-- 메신저 v2 에이전트 프로필 저장 — 얼굴·사진·직무·소개(0.1.65 결함 3 + 검수 D1, 2026-10-25 유건 아이폰 — "얼굴 저장"을 눌러도 그대로, 직무·소개도 같은 오류).
-- 원인 ① v2에는 에이전트 얼굴·사진을 바꾸는 입구가 없었다. 화면은 옛 msgr_crews를 update했고, v2 조회 어댑터는 그 쓰기를 v2_unsupported로 막았다.
--      사진·소개 칸도 msgr2_agents에 없었다. 이름은 그대로 Argo 앱(본체)이 정한다.
-- 원인 ② 본체 동기화(agent.sync → msgr2_agent_sync)는 얼굴을 늘 null로 보낸다(face_hash: null). 서버는 값이 다르면 face를 덮어써,
--      백필로 옮겨 온 저장 얼굴이 본체가 동기화할 때마다 null이 됐다(옛 msgr_crews 값은 그대로 — 데이터 삭제 아님).
-- 바꾸는 것:
--   · msgr2_agents.avatar_path·bio·role_by_user 칸. 사진은 공개 주소가 아니라 버킷 msgr-avatars의 객체 경로(avatars/<uid>/<파일명>)만 저장한다
--     (#1163 엄격 검수 B1: 주소 안 문자열 검사는 외부 호스트·?·#를 통과시켰다). 공개 주소는 앱이 자기 프로젝트 주소로 만든다.
--   · msgr2_agent_set_profile(p_agent, p_patch) — 앱 기기의 주인만. p_patch 키는 face·avatar_path·role_text·bio만, 있는 키만 바꾼다(null = 지우기).
--     직무를 고치면 role_by_user = true — 본체 동기화가 그 직무를 다시 덮지 않는다(본체 쪽 직무는 사람이 메신저에서 고치기 전까지만 따른다).
--     사진 경로는 자기 폴더만: ^avatars/<부른 사람 uid>/[A-Za-z0-9._-]+$ (업로드 정책과 같은 경계, ..·?·#·/ 추가 불가).
--     값이 같으면 쓰지 않는다(IS DISTINCT FROM). 돌려주는 값 = 실제로 바꿨는가.
--   · msgr2_agent_sync — 들어온 face가 null이면 기존 face를 지키고, role_by_user면 직무를 지킨다. 이름·hosting·status는 종전 그대로.
-- 부하: 사람이 저장(얼굴 저장·사진·직무·소개 칸 밖 누름)할 때만 1회. 주기 호출 없음. 동기화의 쓰기 조건은 좁아지기만 한다(face null → 기존 값과 같다고 본다).
-- 되돌림: scripts/rollback/20261025130000_msgr2_agent_look.down.sql — 저장 함수만 지운다. 동기화 새 본문(얼굴·사람이 고친 직무 지키기)과 칸은 남긴다(#1163 엄격 검수 B3).

alter table public.msgr2_agents add column if not exists avatar_path text check (avatar_path is null or (length(avatar_path) <= 300 and avatar_path ~ '^avatars/[0-9a-f-]{36}/[A-Za-z0-9._-]+$' and avatar_path !~ '\.\.'));
alter table public.msgr2_agents add column if not exists bio text check (bio is null or length(bio) <= 300);
alter table public.msgr2_agents add column if not exists role_by_user boolean not null default false;

create or replace function public.msgr2_agent_set_profile(p_agent uuid, p_patch jsonb) returns boolean
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := public._msgr2_need_app(); a public.msgr2_agents; nf jsonb; nu text; nr text; nb text;
begin
  perform public._msgr2_need_live();
  if p_agent is null or jsonb_typeof(p_patch) is distinct from 'object' or p_patch = '{}'::jsonb
     or exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('face', 'avatar_path', 'role_text', 'bio')) then
    raise exception 'msgr2_bad_profile' using errcode = '22023';
  end if;
  if p_patch ? 'face' and (jsonb_typeof(p_patch->'face') not in ('object', 'null') or length((p_patch->'face')::text) > 256) then
    raise exception 'msgr2_bad_profile' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(array['avatar_path', 'role_text', 'bio']) k where p_patch ? k and jsonb_typeof(p_patch->k) not in ('string', 'null')) then
    raise exception 'msgr2_bad_profile' using errcode = '22023';
  end if;
  select * into a from public.msgr2_agents where id = p_agent for update;
  if not found or a.owner_user_id <> uid or a.status = 'retired' then raise exception 'msgr2_not_owner' using errcode = '42501'; end if;
  nf := case when p_patch ? 'face' then nullif(p_patch->'face', 'null'::jsonb) else a.face end;
  nu := case when p_patch ? 'avatar_path' then p_patch->>'avatar_path' else a.avatar_path end;
  nr := case when p_patch ? 'role_text' then left(coalesce(btrim(p_patch->>'role_text'), ''), 200) else a.role_text end; -- 칸이 not null — 지우기는 빈 글자
  nb := case when p_patch ? 'bio' then nullif(btrim(p_patch->>'bio'), '') else a.bio end;
  if nb is not null and length(nb) > 300 then raise exception 'msgr2_bad_profile' using errcode = '22023'; end if;
  if p_patch ? 'avatar_path' and nu is not null
     and (length(nu) > 300 or nu !~ ('^avatars/' || uid::text || '/[A-Za-z0-9._-]+$') or nu ~ '\.\.') then
    raise exception 'msgr2_bad_profile' using errcode = '22023';
  end if;
  update public.msgr2_agents set face = nf, avatar_path = nu, role_text = nr, bio = nb,
      role_by_user = role_by_user or (p_patch ? 'role_text'), updated_at = now()
   where id = p_agent and (face, avatar_path, role_text, bio, role_by_user) is distinct from (nf, nu, nr, nb, role_by_user or (p_patch ? 'role_text'));
  return found;
end $$;
revoke all on function public.msgr2_agent_set_profile(uuid, jsonb) from public, anon;
grant execute on function public.msgr2_agent_set_profile(uuid, jsonb) to authenticated;

-- 에이전트 등록(20261020200000 본문) — 바뀌는 것 둘: 들어온 face가 null(SQL·JSON 둘 다)이면 기존 얼굴을, 사람이 고친 직무(role_by_user)면 그 직무를 지킨다.
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
    values (uid, a->>'ws_id', a->>'slug', left(coalesce(a->>'display_name', ''), 80), left(coalesce(a->>'role_text', ''), 200), nullif(a->'face', 'null'::jsonb), -- JSON null(본체가 face_hash null을 보냄)도 SQL null로
      coalesce(a->>'hosting', 'local'), coalesce(a->>'status', 'active'))
    on conflict (owner_user_id, ws_id, slug) do update set
      display_name = excluded.display_name, role_text = case when t.role_by_user then t.role_text else excluded.role_text end,
      face = coalesce(excluded.face, t.face), hosting = excluded.hosting, status = excluded.status, updated_at = now()
    where (t.display_name, t.role_text, t.face, t.hosting, t.status) is distinct from
          (excluded.display_name, case when t.role_by_user then t.role_text else excluded.role_text end, coalesce(excluded.face, t.face), excluded.hosting, excluded.status);
    get diagnostics k = row_count; n := n + k;
  end loop;
  return n;
end $$;
