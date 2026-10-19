#!/usr/bin/env bash
# 데스크톱 옛 세션 일괄 폐기(supabase/migrations/20261019150000_argo_old_desktop_session_purge.sql) — 두 단계.
#   bash scripts/old-desktop-session-purge.sh preview
#       대상 세션 수·계정 수·버전 분포·제외 사유별 수·digest를 보여 준다. 아무것도 쓰지 않는다.
#   bash scripts/old-desktop-session-purge.sh run <target_sessions> <digest>
#       미리보기에서 받은 수와 digest를 그대로 준다. 대상 id 목록을 0600 파일로 먼저 남기고(파일에서 다시 센 수·digest가 같아야 진행),
#       서버가 관문 기록 표를 잠그고 다시 계산해 같을 때만 지운다. 다르면 0건 삭제 후 오류.
# 접속: 레포 루트 .env.local의 SUPABASE_DB_PASSWORD·NEXT_PUBLIC_SUPABASE_URL(msgr-live-apply.sh와 같은 서울 풀러, 값은 출력하지 않는다).
#   시험용: ARGO_PURGE_PG에 로컬 접속 문자열(127.0.0.1·localhost만 받는다).
# 목록 파일: ${ARGO_PURGE_OUT:-$HOME/.argo-ops}/old-desktop-sessions-<UTC시각>.tsv (폴더 0700, 파일 0600 — 세션 id·계정 id·생성 시각·버전 분류)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -n "${ARGO_PURGE_PG:-}" ]; then
  [[ $ARGO_PURGE_PG =~ (@|host=)(127\.0\.0\.1|localhost)([:/ ]|$) ]] || { echo "거부  ARGO_PURGE_PG는 로컬 시험용입니다(127.0.0.1·localhost만)"; exit 2; }
  C="$ARGO_PURGE_PG"
else
  # 운영 DB 쓰기는 맥 one에서만(CLAUDE.md "머신" 표). msgr-live-apply.sh와 같은 검문.
  [ "$HOME" != "/Users/leankim" ] || ! git remote get-url origin 2>/dev/null | grep -q 'github.com' || { echo "거부  운영 세션 폐기는 맥 one에서만 합니다 — 여기는 맥 two(HOME=$HOME). 맥 one 세션에 넘기세요"; exit 5; }
  set -a; . ./.env.local; set +a
  REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
  export PGPASSWORD="$SUPABASE_DB_PASSWORD"
  C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
fi
q() { psql "$C" -X -q -v ON_ERROR_STOP=1 -At "$@"; }

case "${1:-}" in
  preview)
    q -c "select jsonb_pretty(public.argo_old_desktop_purge_preview())"
    echo "다음: bash scripts/old-desktop-session-purge.sh run <target_sessions> <digest>"
    ;;
  run)
    N="${2:-}"; D="${3:-}"
    [[ $N =~ ^[0-9]+$ && $D =~ ^[0-9a-f]{32}$ ]] || { echo "사용: run <target_sessions 숫자> <digest 32자>"; exit 2; }
    OUT="${ARGO_PURGE_OUT:-$HOME/.argo-ops}"
    (umask 077; mkdir -p "$OUT"); chmod 700 "$OUT"
    F="$OUT/old-desktop-sessions-$(date -u +%Y%m%dT%H%M%SZ).tsv"
    (umask 077; q -F $'\t' -c "select session_id, user_id, created_at, ver from public.argo_old_desktop_purge_list()" > "$F")
    chmod 600 "$F"
    GOT_N=$(grep -c . "$F" || true)
    GOT_D=$(cut -f1 "$F" | LC_ALL=C sort | paste -sd, - | tr -d '\n' | { md5sum 2>/dev/null || md5 -q; } | cut -c1-32)
    if [ "$GOT_N" != "$N" ] || [ "$GOT_D" != "$D" ]; then
      echo "거부  목록이 미리보기와 다릅니다(확인 ${N}건, 지금 ${GOT_N}건) — 0건 삭제. 미리보기부터 다시. 목록: $F"; exit 3
    fi
    echo "목록 저장: $F (${GOT_N}건, 0600)"
    q -c "select jsonb_pretty(public.argo_old_desktop_purge_run($N, '$D'))"
    echo "지운 뒤: 옛 기기의 접근 토큰은 최대 1시간 유효하다 — 1시간 뒤 최소 앱 버전을 올리고 접속 0을 확인한 다음 새 시작 스위치로."
    ;;
  *) echo "사용: $0 preview | run <target_sessions> <digest>"; exit 2 ;;
esac
