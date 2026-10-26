-- 20261026120000_msgr2_account_delete 되돌리기: 감싸개·잠금·방송을 직전 정의(20261023180000·20261020200200·20261020201500)로 돌리고 새 함수를 지운다.
-- 이미 익명화·지운 표시한 글은 되돌리지 않는다(작성자 계정이 사라져 되살릴 대상이 없다).

do $do$ begin
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    execute $w$
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_session_untrusted() then raise exception 'msgr2_app_device_required' using errcode = '42501'; end if; -- S4: 본체·폐기 기기 세션은 계정을 지우지 못한다
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 계정 삭제를 잠시 막는다(스위치 직후 다시 열린다)'; end if;
  return public._msgr_delete_me_body();
end $f$
$w$;
    revoke all on function public.msgr_delete_me() from public, anon;
    grant execute on function public.msgr_delete_me() to authenticated;
  end if;
end $do$;

create or replace function public.msgr2_lock_cols() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
declare col text; n jsonb := to_jsonb(new); o jsonb := to_jsonb(old);
begin
  if auth.uid() is null then return new; end if;
  foreach col in array tg_argv loop
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

drop function if exists public._msgr2_account_delete(uuid);
notify pgrst, 'reload schema';
