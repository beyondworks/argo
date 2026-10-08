#!/usr/bin/env bash
# 2026-09-23 사고 대조용 덤프(읽기 전용) — public 함수 본문 해시와 정책 정의를 탭 구분으로 뽑는다. 쓰기 없음(read only 세션).
# 사용: `bash scripts/incident-2026-09-23-dump.sh <출력 폴더>` → fns.tsv, policies.tsv
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:?출력 폴더}"
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
# 읽기 전용은 세션 첫 문장 set으로 건다 — Supavisor 풀러는 PGOPTIONS(시작 옵션)를 버린다(2026-10-08 show로 관찰). 풀러는 다음 접속 전에 세션 설정을 지운다(같은 날 관찰).
RO='set default_transaction_read_only = on'
psql "$C" -At -q -F $'\t' -c "$RO" -c "select p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'msgr\_%' order by 1, 2" > "$OUT/fns.tsv"
psql "$C" -At -q -F $'\t' -c "$RO" -c "select schemaname, tablename, policyname, cmd, coalesce(qual, ''), coalesce(with_check, '') from pg_policies where (schemaname = 'public' and tablename like 'msgr\_%') or schemaname = 'realtime' order by 1, 2, 3" > "$OUT/policies.tsv"
wc -l "$OUT/fns.tsv" "$OUT/policies.tsv"
