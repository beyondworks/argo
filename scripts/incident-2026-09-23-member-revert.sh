#!/usr/bin/env bash
# 2026-09-23 사고: 백필 재실행(20260916190000)으로 다시 들어간 채널 멤버 1행을 되돌린다.
# 대상은 진단으로 특정한 정확히 한 행(채널·사람·추가 시각·added_by 없음)이며, 1행이 아니면 롤백한다.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
psql "$C" -v ON_ERROR_STOP=1 -q <<'SQL'
begin;
do $$ declare n int; begin
  delete from public.msgr_channel_members
   where channel_id = '43be8ea7-8f74-4ec3-a5ae-9f03fe9f0d00' and member_kind = 'user' and member_id = 'de9a3024-2786-49f0-b422-a2c00e26f3ae'
     and added_by is null and added_at = '2026-09-23 13:05:58.181972+00';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'expected 1 row, got %', n; end if;
end $$;
commit;
SQL
echo "reverted 1 row"
