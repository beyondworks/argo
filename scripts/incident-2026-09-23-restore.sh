#!/usr/bin/env bash
# 2026-09-23 사고 복구 적용 — 옛 마이그레이션 재적용으로 덮인 함수 11개·정책 3개를 저장소 최신 정의로 되돌리고,
# 되살아난 옛 겹침 정의 msgr_dm_personal_list()를 지운다. 정의만(데이터 문장 없음), 한 트랜잭션.
# SQL: scripts/incident-2026-09-23-restore.sql (최신 마이그레이션 파일의 문장을 그대로 옮김). 임시 Postgres 리허설로 12개 복구 확인.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGOPTIONS='-c client_min_messages=warning' psql "$C" -v ON_ERROR_STOP=1 -q -f scripts/incident-2026-09-23-restore.sql
echo "restore applied"
