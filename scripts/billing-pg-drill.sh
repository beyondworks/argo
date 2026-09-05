#!/usr/bin/env bash
# 실 Postgres 드릴(분리 검수 F6) — Docker 불필요. Homebrew postgresql의 initdb/pg_ctl로 임시 인스턴스를 띄우고,
# 배포될 마이그레이션 파일을 그대로 적용해 pg 통합 테스트를 돌린 뒤 흔적 없이 정리한다.
# 대상 파일(순차·파일마다 별도 DB — node --test는 파일을 병렬 프로세스로 돌리므로 한 DB를 공유하면 경합한다):
#   test/billing-pg-integration.test.mjs  (apply_ls_event·is_pro 만료·대사 쿨다운·동시성)
#   test/msgr-pg-integration.test.mjs     (팀 메신저 RLS·역할 경계표·좌석·결재 미러·Realtime 방송)
# 요구: psql·initdb·pg_ctl (예: brew install postgresql@14). 포트 충돌 시 ARGO_PG_DRILL_PORT 지정.
# 대안: supabase start 후 ARGO_PG_TEST_URL을 직접 지정해 node --test test/<파일>
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in initdb pg_ctl psql; do
  command -v "$bin" >/dev/null || { echo "[drill] $bin 없음 — brew install postgresql@14 후 재시도" >&2; exit 1; }
done

# 기본 포트는 OS가 배정한 빈 포트 — 고정 포트는 상주 인스턴스와 충돌한다(실측: 54329 점유 사례)
PORT="${ARGO_PG_DRILL_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}"
DIR="$(mktemp -d)"
cleanup() { pg_ctl -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

echo "[drill] 임시 Postgres 기동 (port $PORT, $DIR)"
initdb -D "$DIR/data" -A trust -U postgres >/dev/null
pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1" -l "$DIR/pg.log" start >/dev/null

FILES=("${@:-}")
if [ -z "${FILES[0]}" ]; then FILES=(test/billing-pg-integration.test.mjs test/msgr-pg-integration.test.mjs); fi
i=0
for f in "${FILES[@]}"; do
  i=$((i + 1)); db="argo_drill_$i"
  psql "postgresql://postgres@127.0.0.1:$PORT/postgres" -X -q -c "create database $db"
  echo "[drill] $f → $db"
  ARGO_PG_TEST_URL="postgresql://postgres@127.0.0.1:$PORT/$db" node --test "$f"
done
echo "[drill] 통과 — 임시 인스턴스 정리"
