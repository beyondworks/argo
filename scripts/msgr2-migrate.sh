#!/usr/bin/env bash
# 메신저 v2 이전(U8) 실행기 — supabase/migrations/20261020200700_msgr2_backfill.sql의 함수를 부른다. 런북: scripts/msgr2-migrate-runbook.md
# 사용: bash scripts/msgr2-migrate.sh <status|run|verify|restart|rollback>
#   status   작업 행(단계·세대·체크포인트·끝난 시각·쓴 행 수) 보기
#   run      앞 단계부터 끝날 때까지 한 묶음씩 부른다. 멈췄다가 다시 부르면 체크포인트부터 간다. 다른 실행기가 잡고 있으면(busy) 기다렸다가 다시, 세대가 바뀌면(stale) 멈춘다
#   verify   표별 누락·방별 본문 해시·무작위 200글 대조(옛 표 행 수 포함). ok가 아니면 exit 1
#   restart  세대 +1, 체크포인트를 비운다(스위치 직전 두 번째 실행 전에)
#   rollback 스위치 전 되돌림 — 백필 사본만 있을 때 msgr2_* 비우기(scripts/msgr2-migrate-rollback.sql)
# 접속: MSGR2_MIGRATE_DB(psql 접속 문자열)가 있으면 그것을, 없으면 .env.local로 운영 풀러에 붙는다(scripts/msgr-live-apply.sh와 같은 방식, 값은 출력하지 않는다).
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-}"; [ -n "$CMD" ] || { sed -n '2,10p' "$0"; exit 2; }

if [ -n "${MSGR2_MIGRATE_DB:-}" ]; then
  C="$MSGR2_MIGRATE_DB"
  case "$C" in *@127.0.0.1*|*@localhost*|*host=127.0.0.1*|*host=localhost*) LOCAL=1 ;; *) LOCAL=0 ;; esac
else
  LOCAL=0
fi
# 운영 DB는 맥 one에서만(CLAUDE.md "머신" 표). 맥 two에서는 로컬 시험 DB(127.0.0.1·localhost)만 허용한다 — scripts/msgr-live-apply.sh와 같은 검문.
if [ "$LOCAL" != 1 ]; then
  [ "$HOME" != "/Users/leankim" ] || ! git remote get-url origin 2>/dev/null | grep -q 'github.com' || { echo "거부  운영 DB 이전은 맥 one에서만 합니다 — 여기는 맥 two(HOME=$HOME). 맥 one 세션에 넘기세요"; exit 5; }
fi
if [ -z "${MSGR2_MIGRATE_DB:-}" ]; then
  set -a; . ./.env.local; set +a
  REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
  export PGPASSWORD="$SUPABASE_DB_PASSWORD"
  C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
fi
# 한 번 부르기 = 한 트랜잭션. 잠금은 5초만 기다리고, 한 묶음이 2분을 넘으면 그 묶음만 되돌린다(체크포인트는 그대로).
export PGOPTIONS="-c lock_timeout=5s -c statement_timeout=120s"
q() { psql "$C" -X -v ON_ERROR_STOP=1 -At -c "$1"; }
WORKER="$(hostname -s 2>/dev/null || echo host):$$"

case "$CMD" in
  status)
    psql "$C" -X -v ON_ERROR_STOP=1 -c "select step, name, generation as gen, batch_limit as lim, checkpoint, done_at, runs, rows_written as written, verified_at, claimed_by from public.msgr2_backfill_jobs order by step" ;;
  run)
    GEN=$(q "select max(generation) from public.msgr2_backfill_jobs")
    for JOB in $(q "select name from public.msgr2_backfill_jobs order by step"); do
      busy=0
      while :; do
        R=$(q "select public.msgr2_backfill_run('$JOB', $GEN, '$WORKER')") || { echo "멈춤  $JOB — 위 오류(그 묶음은 되돌아갔고 체크포인트는 그대로). 고친 뒤 다시 run"; exit 3; }
        case "$R" in
          *'"ok": true'*'"done": true'*) echo "끝    $JOB  $R"; break ;;
          *'"ok": true'*) echo "묶음  $JOB  $R" ;;
          *'"code": "busy"'*) busy=$((busy + 1)); [ $busy -le 60 ] || { echo "멈춤  $JOB — 5분 동안 다른 실행기가 잡고 있다"; exit 3; }; sleep 5 ;;
          *'"code": "stale_generation"'*) echo "멈춤  $JOB — 세대가 바뀌었다(다른 곳에서 restart). status를 보고 다시 run"; exit 3 ;;
          *) echo "멈춤  $JOB  $R"; exit 3 ;;
        esac
      done
    done
    echo "백필 끝(세대 $GEN). 다음: bash scripts/msgr2-migrate.sh verify" ;;
  verify)
    R=$(q "select jsonb_pretty(public.msgr2_backfill_verify(200))"); echo "$R"
    case "$R" in *'"ok": true'*) ;; *) exit 1 ;; esac ;;
  restart)
    echo "세대 $(q "select public.msgr2_backfill_restart()")로 처음부터" ;;
  rollback)
    psql "$C" -X -v ON_ERROR_STOP=1 -f scripts/msgr2-migrate-rollback.sql ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
