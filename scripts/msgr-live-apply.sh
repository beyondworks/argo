#!/usr/bin/env bash
# 팀 메신저 라이브 Supabase 배선 — 빠진 마이그레이션을 순서대로 적용하고 schema_migrations에 기록한다.
# 사용: 레포 루트에서 `bash scripts/msgr-live-apply.sh` (.env.local의 SUPABASE_DB_PASSWORD·NEXT_PUBLIC_SUPABASE_URL 사용, 값은 출력하지 않는다)
# 접속 = 서울 풀러 aws-1-ap-northeast-2(직결 호스트는 IPv6 전용이라 맥에서 안 붙는다 — 2026-09-09 실측).
# 각 파일은 한 트랜잭션(-1)이며 ON_ERROR_STOP — 실패한 파일에서 멈추고 그 앞까지만 적용된다(전부 additive: 표·열·정책·함수 추가/교체).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
FILES=(20260908120000_msgr_bots 20260908140000_msgr_crew_autodispatch 20260909000000_msgr_bot_external_id 20260909001000_msgr_crew_folder 20260909002000_msgr_profiles_friends 20260909003000_msgr_message_meta 20260909004000_msgr_p0_reads_reactions_prefs 20260909005000_msgr_avatars)
for f in "${FILES[@]}"; do
  V=${f%%_*}
  if [ "$(psql "$C" -At -c "select count(*) from supabase_migrations.schema_migrations where version = '$V'")" = "1" ]; then echo "skip  $f (이미 기록됨)"; continue; fi
  psql "$C" -v ON_ERROR_STOP=1 -1 -q -f "supabase/migrations/$f.sql" 2>&1 | grep -v NOTICE || true
  psql "$C" -q -c "insert into supabase_migrations.schema_migrations (version, name, statements) values ('$V', '${f#*_}', array[]::text[]) on conflict (version) do nothing"
  echo "OK    $f"
done
echo "--- 검증"
psql "$C" -At <<'SQL'
select 'tables='||count(*) from pg_tables where schemaname='public' and tablename like 'msgr_%';
select 'buckets='||string_agg(id, ',') from storage.buckets;
select 'fn='||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'msgr_%';
select 'crews_active='||count(*) filter (where status='active')||' available='||count(*) filter (where status='available') from public.msgr_crews;
SQL
