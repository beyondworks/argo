-- 메신저 v2 계정 삭제 정리(감사 결함 4, 2026-10-26 유건 승인 "응 지우고 팀 글을 익명으로 바꾸기", 총괄 범위 확정).
-- 지금 계정 삭제(msgr_delete_me → _msgr_delete_me_body)는 옛 msgr_* 표만 정리해, 탈퇴자의 v2 멤버십·에이전트·글이 그대로 남았다(글의 작성자가 사라진 계정을 가리킴).
-- 바꾸는 것:
--   1) _msgr2_account_delete(uid) 새 함수 — 팀 주인 막기 · 개인 공간 방의 그 사람 글을 지운 글로 + 익명화 · 팀 방 글 익명화(본문 유지) · 멤버십 닫기 · 에이전트 은퇴
--   2) 감싸개 msgr_delete_me가 본문 전에 1)을 부른다(같은 트랜잭션 — 본문이 막히면 v2 정리도 되돌아간다). 본문은 그대로(md5 고정 시험)
--   3) msgr2_lock_cols: 계정 삭제 표지(argo.msgr_account_delete) 안에서 본인 글의 author_kind·author_user_id를 system·null로 바꾸는 것만 연다
--   4) msgr2_on_message_broadcast: 계정 삭제 표지 안의 글 UPDATE는 방송하지 않는다(글 수천 건 = 방송 수천 건)
-- 안 하는 것: 소급 정리(이미 탈퇴한 계정), 첨부 Storage 파일 삭제(SQL로 지우지 않는다 — 후속), 탈퇴자가 친구 에이전트에 맡긴 일(그대로 끝난다).
-- 부하: 탈퇴 1회에 그 사람 글 수만큼 UPDATE(방송 0), 멤버십·에이전트 행 몇 개. 주기 호출 없음.
-- 되돌리기: scripts/rollback/20261026120000_msgr2_account_delete.down.sql
-- 시험: bash scripts/billing-pg-drill.sh test/msgr2-account-delete-pg.test.mjs

-- v2 계정 정리(내부 전용). 감싸개 msgr_delete_me가 본문 전에 부른다. 반환: 지운 글·익명화한 글·나간 공간·은퇴한 에이전트 수.
-- 두 번 불러도 바뀌는 행이 없다(멱등).
create or replace function public._msgr2_account_delete(p_uid uuid) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare blocked text; sp uuid; ag uuid; n_del int := 0; n_anon int := 0; n_sp int := 0; n_ag int := 0;
begin
  if p_uid is null then return null; end if;
  -- 1) 팀 주인 막기: 다른 활동 멤버가 있는 내 v2 팀은 주인을 넘긴 뒤에 지운다(옛 조직 확인과 같은 오류 — 거울 조직이 없는 v2 팀도 막는다)
  select string_agg(coalesce(nullif(s.name, ''), s.id::text), ', ' order by s.name) into blocked
    from public.msgr2_spaces s
   where s.kind = 'team' and s.owner_user_id = p_uid and s.deleted_at is null
     and exists (select 1 from public.msgr2_space_members m where m.space_id = s.id and m.user_id <> p_uid
                   and m.removed_at is null and (m.expires_at is null or m.expires_at > now()));
  if blocked is not null then raise exception 'msgr_owner_transfer_required: %', blocked; end if;
  -- 2) 개인 공간 방에서 이 사람이 쓴 글: 지운 글로(앱의 글 지우기처럼 행은 남기고 본문·멘션·meta를 비운다) + 작성자 익명화.
  --    상대(친구)가 쓴 글은 그대로다. 첨부 행·Storage 파일은 남는다(v2 방 경로는 저장소 정리 대상이 아니다 — 후속).
  update public.msgr2_messages m
     set body = '', mentions = '{}', meta = jsonb_build_object('deleted_user', true), deleted_at = coalesce(m.deleted_at, now()),
         author_kind = 'system', author_user_id = null
    from public.msgr2_rooms r join public.msgr2_spaces s on s.id = r.space_id
   where r.id = m.room_id and s.kind = 'personal' and m.author_kind = 'user' and m.author_user_id = p_uid;
  get diagnostics n_del = row_count;
  -- 3) 남은 글(팀 방): 지우지 않고 작성자만 "탈퇴한 사용자"로(본문·첨부 그대로). 화면은 meta.deleted_user로 이름을 그린다
  update public.msgr2_messages m set meta = m.meta || jsonb_build_object('deleted_user', true), author_kind = 'system', author_user_id = null
   where m.author_kind = 'user' and m.author_user_id = p_uid;
  get diagnostics n_anon = row_count;
  -- 4) 멤버십 닫기: 공간(방 멤버·그 사람 에이전트 방 멤버·파견 함께) + 남의 개인 공간 방(1:1 등) 멤버 행
  for sp in select m.space_id from public.msgr2_space_members m where m.user_id = p_uid and m.removed_at is null loop
    perform public._msgr2_space_drop(sp, p_uid); n_sp := n_sp + 1;
  end loop;
  update public.msgr2_room_members set removed_at = now() where member_kind = 'user' and member_id = p_uid and removed_at is null;
  -- 5) 에이전트 은퇴: 봇 토큰 폐기(봇만)·방 멤버·파견 닫기·진행 중인 일 취소는 _msgr2_bot_retire, 상태는 로컬·봇 모두 retired
  for ag in select a.id from public.msgr2_agents a where a.owner_user_id = p_uid and a.status <> 'retired' loop
    perform public._msgr2_bot_retire(ag); n_ag := n_ag + 1;
  end loop;
  update public.msgr2_agents set status = 'retired', updated_at = now() where owner_user_id = p_uid and status <> 'retired';
  return jsonb_build_object('deleted_msgs', n_del, 'anonymized_msgs', n_anon, 'spaces', n_sp, 'agents', n_ag);
end $$;
revoke all on function public._msgr2_account_delete(uuid) from public, anon, authenticated;

create or replace function public.msgr2_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old); anon boolean;
begin
  if auth.uid() is null then return new; end if;
  -- 계정 삭제(msgr_delete_me 안, 트랜잭션 한정 표지): 지우는 사람 본인의 글을 "탈퇴한 사용자"(system·작성자 없음)로 바꾸는 것만 연다. 다른 열·다른 사람 글은 그대로 잠근다.
  anon := tg_table_name = 'msgr2_messages' and coalesce(current_setting('argo.msgr_account_delete', true), '') = '1'
          and o->>'author_user_id' = auth.uid()::text and n->>'author_kind' = 'system' and jsonb_typeof(n->'author_user_id') = 'null';
  foreach col in array tg_argv loop
    if anon and col in ('author_kind', 'author_user_id') then continue; end if;
    if n->col is distinct from o->col then raise exception 'msgr2_immutable_%', col using errcode = '42501'; end if;
  end loop;
  return new;
end $$;

create or replace function public.msgr2_on_message_broadcast() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.msgr2_rooms; s public.msgr2_spaces; n int; u uuid; p jsonb;
begin
  -- 이전(U8) 백필: 서비스 문맥(auth.uid() 없음)에서 msgr2.backfill = on이면 방송하지 않는다(옛 글 수백만 건 = 방송 폭주). 사람 문맥은 이 설정과 무관하게 방송한다.
  if auth.uid() is null and coalesce(current_setting('msgr2.backfill', true), '') = 'on' then return null; end if;
  -- 계정 삭제(msgr_delete_me 안): 그 사람 글 수천 건을 한꺼번에 익명화·삭제 표시할 때 글마다 방송하지 않는다(받는 쪽은 다음 불러오기 때 "탈퇴한 사용자"로 본다)
  if tg_op = 'UPDATE' and coalesce(current_setting('argo.msgr_account_delete', true), '') = '1' then return null; end if;
  if tg_op = 'UPDATE' and (new.body, new.meta, new.edited_at, new.deleted_at) is not distinct from (old.body, old.meta, old.edited_at, old.deleted_at) then return null; end if;
  select * into r from public.msgr2_rooms where id = new.room_id;
  select * into s from public.msgr2_spaces where id = r.space_id;
  p := public._msgr2_msg_payload(new);
  select count(*) into n from public._msgr2_room_humans(new.room_id);
  if s.kind = 'team' and r.kind = 'open' and n > public._msgr2_fanout_max() then
    perform public._msgr2_send_s(s.id, 'msg', p);
    -- v2:s:를 못 받는 사람(그 공간의 owner·admin·member가 아닌 방 멤버 — 손님 등)에게는 따로(검수 #1076 중간)
    for u in select h from public._msgr2_room_humans(new.room_id) h
              where not exists (select 1 from public.msgr2_space_members sm where sm.space_id = s.id and sm.user_id = h and sm.role in ('owner', 'admin', 'member')
                                  and sm.removed_at is null and (sm.expires_at is null or sm.expires_at > now())) loop
      perform public._msgr2_send_u(u, 'msg', p);
    end loop;
  else
    for u in select * from public._msgr2_room_humans(new.room_id) loop perform public._msgr2_send_u(u, 'msg', p); end loop;
  end if;
  return null;
end $$;

do $do$ begin
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    execute $w$
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_session_untrusted() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if; -- S4: 본체·폐기 기기 세션은 계정을 지우지 못한다
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 계정 삭제를 잠시 막는다(스위치 직후 다시 열린다)'; end if;
  perform set_config('argo.msgr_account_delete', '1', true); -- 본문(_msgr_delete_me_body)이 끝에서 비운다. 예외면 트랜잭션째 되돌아간다
  perform public._msgr2_account_delete(auth.uid()); -- v2 정리를 먼저(같은 트랜잭션 — 본문의 옛 주인 확인이 막으면 함께 되돌아간다)
  return public._msgr_delete_me_body();
end $f$
$w$;
    revoke all on function public.msgr_delete_me() from public, anon;
    grant execute on function public.msgr_delete_me() to authenticated;
  end if;
end $do$;

notify pgrst, 'reload schema';
