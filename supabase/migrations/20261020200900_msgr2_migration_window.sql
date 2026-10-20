-- 메신저 v2 U8 — 이전 작업 창 동안 옛 계정 삭제·보관 조직 영구 삭제 막기(설계 6절 0단계, 총괄 결정 2026-10-18: 짧은 창만).
-- 표지: public.msgr_settings 한 줄 key = 'msgr2_migration_window', value = 시작 시각(ISO). 런북(scripts/msgr2-migrate-runbook.md)이 백필 직전에 넣고 스위치 직후에 지운다.
--   표지가 있으면 옛 msgr_delete_me()·msgr_purge_orgs()가 'msgr2_migration_in_progress'(55000)로 거부한다 — 이전 도중 옛 표의 행이 사라져
--   백필·검증이 엇갈리는 것을 막는다(옛 표는 백필이 읽는 원본이다). 표지가 없으면 지금과 같은 동작이다.
--   같은 표지 동안 옛 핵심 표(msgr_messages·msgr_channels·msgr_channel_members·msgr_attachments·msgr_reactions)의 UPDATE·DELETE도 사람 문맥(auth.uid() 있음)에서
--   거부한다(문장 단위 트리거). 옛 중단 스위치(msgr_paused, 20261016170000)는 INSERT만 막아서, 옛 앱의 글 수정·지우기·반응·방 삭제가 창 안에서도 통과했다
--   (#1087 검수 재현 — verify 뒤 옛 앱에서 지운 글이 v2에 다시 나타난다). 서비스 문맥(이전 함수·운영 도구)은 통과한다.
-- 방법: 본문을 다시 쓰지 않는다. 지금 함수의 이름을 _msgr_delete_me_body()·_msgr_purge_orgs_body()로 바꾸고(본문·설정·소유자 그대로),
--   같은 이름·같은 반환형의 얇은 감싸개가 표지를 본 뒤 원래 함수를 부른다. 권한은 원래 함수와 같게 두고, 원래 함수는 감싸개만 부르게 닫는다.
--   (본문을 복사하면 20261012160000 정의와 어긋날 수 있다 — 시험이 이름 바꾼 함수의 본문이 그 파일 정의와 같은지 md5로 본다.)
-- 함정: 나중에 누가 20261012160000 같은 옛 파일을 다시 적용하면 감싸개가 옛 본문으로 덮인다(표지 검사 없음). 라이브 적용은 msgr-live-apply.sh의 "더 새 버전이 있으면 거부"가 막는다.
-- 멱등: 이름 바꾸기는 _body가 없을 때만. 감싸개는 create or replace.
-- 되돌림: scripts/rollback/20261018052000_msgr2_migration_window.down.sql · 시험: test/msgr2-migration-window-pg.test.mjs

create or replace function public._msgr2_migration_window() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from public.msgr_settings where key = 'msgr2_migration_window')
$$;
revoke all on function public._msgr2_migration_window() from public, anon, authenticated;

-- 옛 함수가 없는 DB(v2만 적용한 시험 판)에서는 아무것도 하지 않는다 — 이름 바꾸기·감싸개·권한 모두 그 함수가 있을 때만.
do $do$ begin
  -- 계정 삭제(사람) — 원래 권한: public·anon 회수, authenticated 실행
  if to_regprocedure('public._msgr_delete_me_body()') is null and to_regprocedure('public.msgr_delete_me()') is not null then
    alter function public.msgr_delete_me() rename to _msgr_delete_me_body;
  end if;
  if to_regprocedure('public._msgr_delete_me_body()') is not null then
    revoke all on function public._msgr_delete_me_body() from public, anon, authenticated; -- 원래 함수는 감싸개만 부른다(표지를 건너뛰지 못하게)
    execute $w$
create or replace function public.msgr_delete_me() returns jsonb
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 계정 삭제를 잠시 막는다(스위치 직후 다시 열린다)'; end if;
  return public._msgr_delete_me_body();
end $f$
$w$;
    revoke all on function public.msgr_delete_me() from public, anon;
    grant execute on function public.msgr_delete_me() to authenticated;
  end if;
  -- 보관 조직 영구 삭제(서비스 잡) — 원래 권한: public·anon·authenticated 회수
  if to_regprocedure('public._msgr_purge_orgs_body()') is null and to_regprocedure('public.msgr_purge_orgs()') is not null then
    alter function public.msgr_purge_orgs() rename to _msgr_purge_orgs_body;
  end if;
  if to_regprocedure('public._msgr_purge_orgs_body()') is not null then
    revoke all on function public._msgr_purge_orgs_body() from public, anon, authenticated;
    execute $w$
create or replace function public.msgr_purge_orgs() returns int
  language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 보관 조직 영구 삭제를 미룬다(작업 창이 닫힌 뒤 다시 부른다)'; end if;
  return public._msgr_purge_orgs_body();
end $f$
$w$;
    revoke all on function public.msgr_purge_orgs() from public, anon, authenticated;
    grant execute on function public.msgr_purge_orgs() to service_role; -- 원래 파일(20260903120000:1527)처럼 명시(기본 권한이 없는 PG에서도 서비스 역할이 부른다)
  end if;
end $do$;

-- 옛 핵심 표 UPDATE·DELETE 막기(창 표지 + 사람 문맥만). 옛 표가 없는 DB에서는 만들지 않는다.
create or replace function public._msgr2_window_write_guard() returns trigger
  language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is not null and public._msgr2_migration_window() then
    raise exception 'msgr2_migration_in_progress' using errcode = '55000', hint = '메신저 이전 작업 중에는 옛 메신저의 글·방을 바꾸거나 지울 수 없다(스위치 뒤 새 버전에서)'; end if;
  return null;
end $$;
revoke all on function public._msgr2_window_write_guard() from public, anon, authenticated;
do $do$ declare t text; begin
  foreach t in array array['msgr_messages', 'msgr_channels', 'msgr_channel_members', 'msgr_attachments', 'msgr_reactions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists a0_msgr2_window_guard on public.%I', t);
      execute format('create trigger a0_msgr2_window_guard before update or delete on public.%I for each statement execute function public._msgr2_window_write_guard()', t);
    end if;
  end loop;
end $do$;
