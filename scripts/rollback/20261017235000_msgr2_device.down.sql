-- 되돌림: supabase/migrations/20261017235000_msgr2_device.sql(U3 — 기기)를 걷어 낸다. _msgr2_device_ok·_msgr2_device_app은 U1의 닫힌 자리 함수(늘 거짓)로 되돌린다.
-- 바로 실행하는 파일이다(마이그레이션이 아니다). 순서는 역순만: U2b → U2 → U3 → U1. 앞 단위가 남아 있으면 그 단위를 먼저 되돌린다.
-- 빈 표만 지운다 — 행이 하나라도 있으면 아무것도 바꾸지 않고 멈춘다(기억 데이터·기록 보존, CLAUDE.md DB 위생 1). storage.objects는 건드리지 않는다.
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261017235000_msgr2_device.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
do $g$ declare t text; n bigint; begin
  foreach t in array array['msgr2_devices', 'msgr2_user_gen'] loop
    if to_regclass('public.' || t) is not null then
      execute format('select count(*) from public.%I', t) into n;
      if n > 0 then raise exception 'msgr2_rollback_not_empty: % has % rows', t, n; end if;
    end if;
  end loop;
end $g$;
drop table if exists public.msgr2_devices, public.msgr2_user_gen;
create or replace function public._msgr2_device_ok() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$ select false $$;
create or replace function public._msgr2_device_app() returns boolean
  language sql stable security definer set search_path = public, pg_temp as $$ select false $$;
do $d$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any (array['_msgr2_device_kind', '_msgr2_session_id', '_msgr2_ver', 'msgr2_device_register', 'msgr2_device_revoke', 'msgr2_devices_list']) loop
    execute format('drop function %s', f);
  end loop;
end $d$;
notify pgrst, 'reload schema';
commit;
