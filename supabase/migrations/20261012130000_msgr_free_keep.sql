-- 무료 계정이 유지할 에이전트를 직접 고른다(유건 2026-10-12: "유지할 4명의 에이전트를 선택해주세요", "4명 한도 내에서는 무제한으로 변경").
-- 20261011120000은 한도를 넘는 연결에서 서버가 멈출 에이전트를 점수로 골랐다. 이 함수는 사람이 고른 묶음(최대 한도)을 그대로 적용한다:
--   고른 에이전트(회사:이름)의 멈춘 행은 재개하고(커서 끝·중지 기록 닫기 — sweep과 같은 _msgr_crew_plan_resume),
--   고르지 않은 연결된 에이전트는 멈춘다(status paused — 채널 참여·기억·데이터 보존, 중지 기록은 msgr_crews_pro_gate_log 트리거).
--   파견 해제(available)는 쓰지 않는다 — 조직 행의 파견 해제는 그 조직 채널 기억을 지운다(crew.recall.confirm).
--   p_activate = 고른 에이전트 중 파견 해제(available) 상태인 행을 함께 연결할 때(연결 버튼으로 이 창이 열린 그 행 — 주인의 명시적 연결).
--   고른 행은 msgr_free_choices에 '지금 고름'으로 남겨 10분 sweep·심박 재개가 사람의 선택을 뒤집지 않는다(sweep 순위 = 점수 → 고른 순간).
-- 횟수 제한 없음 — 한도 안에서 몇 번이고 다시 고른다. 같은 묶음을 다시 보내면 바뀌는 행이 없다(유휴 쓰기는 고른 기록 갱신뿐).
-- 거절: 로그인 없음(42501), 한도 밖 개수·중복·내 것이 아닌 에이전트·봇(msgr_bad_member), 새 앱 없음(msgr_app_update_required — 연결해도 관문이 멈춘다).
-- Pro는 한도가 없어 할 일이 없다 — { pro: true }만 돌려준다.
-- 부하: 사람이 저장을 누를 때 1회. 주인 잠금(관문·sweep과 같은 키)으로 줄 세운다. 주기 호출 없음.
-- 적용: bash scripts/msgr-live-apply.sh 20261012130000_msgr_free_keep

create or replace function public.msgr_free_keep(p_keep text[], p_activate uuid[] default '{}') returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $$
declare me uuid := auth.uid(); lim int; prev text := current_setting('msgr.pro_gate', true); top bigint; r record;
        n_p int := 0; n_r int := 0; n_a int := 0; act uuid[] := coalesce(p_activate, '{}');
begin
  if me is null then raise exception 'msgr_forbidden' using errcode = '42501'; end if;
  if to_regprocedure('public.is_pro_for(uuid)') is not null and public.is_pro_for(me) then return jsonb_build_object('pro', true); end if;
  perform pg_advisory_xact_lock(hashtext('msgr_free_agents:' || me::text)); -- 관문·sweep과 같은 주인 잠금 — 검사보다 먼저(검사한 상태가 쓰기 전에 바뀌지 않게)
  select agent_limit into lim from public._msgr_free_agent_policy();
  if p_keep is null or cardinality(p_keep) = 0 or cardinality(p_keep) > lim or cardinality(act) > lim
     or (select count(distinct k) from unnest(p_keep) k) <> cardinality(p_keep) then
    raise exception 'msgr_bad_member' using errcode = '22023', detail = 'keep 1..limit distinct agents';
  end if;
  -- 고른 것은 모두 내 사람 에이전트(연결·멈춤 행이 있거나, 함께 연결할 행이 그 에이전트의 것)
  if exists (select 1 from unnest(p_keep) k
              where not exists (select 1 from public.msgr_crews c where c.owner_user_id = me and c.hosting <> 'bot' and (c.ws_id || ':' || c.slug) = k
                                  and (c.status in ('active', 'paused') or c.id = any(act)))) then
    raise exception 'msgr_bad_member' using errcode = '22023', detail = 'unknown agent';
  end if;
  if exists (select 1 from unnest(act) a
              where not exists (select 1 from public.msgr_crews c where c.id = a and c.owner_user_id = me and c.hosting <> 'bot'
                                  and c.status in ('available', 'active', 'paused') and (c.ws_id || ':' || c.slug) = any(p_keep))) then
    raise exception 'msgr_bad_member' using errcode = '22023', detail = 'activate row outside keep';
  end if;
  if not public._msgr_free_app_ok(me) then
    raise exception 'msgr_app_update_required' using errcode = 'P0001', detail = 'Free accounts need the latest Argo app running to connect agents to Messenger';
  end if;
  perform set_config('msgr.pro_gate', 'off', true); -- 아래 쓰기가 관문에 되돌려지지 않게(판정은 이 함수가 했다). 끝에서 되돌린다
  select coalesce(max(id), 0) into top from public.msgr_messages;
  -- 1) 고르지 않은 연결된 에이전트 → 멈춤(바뀌는 행만)
  update public.msgr_crews set status = 'paused'
   where owner_user_id = me and hosting <> 'bot' and status = 'active' and not ((ws_id || ':' || slug) = any(p_keep));
  get diagnostics n_p = row_count;
  -- 2) 고른 에이전트의 멈춘 행 → 재개(커서 끝·기록 닫기·자동화 정리)
  for r in select id from public.msgr_crews
            where owner_user_id = me and hosting <> 'bot' and status = 'paused' and (ws_id || ':' || slug) = any(p_keep) order by id loop
    perform public._msgr_crew_plan_resume(r.id, top);
    n_r := n_r + 1;
  end loop;
  -- 3) 함께 연결할 파견 해제 행
  update public.msgr_crews set status = 'active' where id = any(act) and owner_user_id = me and status = 'available';
  get diagnostics n_a = row_count;
  -- 4) 고른 순간 기록 — sweep·심박 재개 순위에서 '지금 고른 것'으로(교체 표시는 푼다). 같은 값이면 쓰지 않는다
  insert into public.msgr_free_choices (crew_id, owner_user_id, chosen_msg, chosen_at)
    select c.id, me, top, now() from public.msgr_crews c
     where c.owner_user_id = me and c.hosting <> 'bot' and c.status = 'active' and (c.ws_id || ':' || c.slug) = any(p_keep)
  on conflict (crew_id) do update set chosen_msg = excluded.chosen_msg, chosen_at = now(), swapped_out = null, swapped_at = null
   where public.msgr_free_choices.chosen_msg is distinct from excluded.chosen_msg or public.msgr_free_choices.swapped_out is not null;
  perform set_config('msgr.pro_gate', coalesce(prev, ''), true);
  return jsonb_build_object('paused', n_p, 'resumed', n_r, 'activated', n_a);
end $$;
revoke all on function public.msgr_free_keep(text[], uuid[]) from public, anon;
grant execute on function public.msgr_free_keep(text[], uuid[]) to authenticated;

notify pgrst, 'reload schema';
