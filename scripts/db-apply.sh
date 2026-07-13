#!/usr/bin/env bash
# Supabase DB에 마이그레이션 적용 — 풀러 경유(직결 DNS 없는 신형 프로젝트).
# 사용: scripts/db-apply.sh supabase/migrations/<file>.sql
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?사용법: db-apply.sh <sql파일>}"
REF=$(grep NEXT_PUBLIC_SUPABASE_URL .env.local | sed -E 's|.*//([a-z0-9]+)\.supabase\.co.*|\1|')
PW=$(grep SUPABASE_DB_PASSWORD .env.local | cut -d= -f2-)
PGPASSWORD="$PW" psql -h aws-1-ap-northeast-2.pooler.supabase.com -p 5432 \
  -U "postgres.${REF}" -d postgres -v ON_ERROR_STOP=1 -f "$FILE"
