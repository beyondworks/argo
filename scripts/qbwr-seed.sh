#!/usr/bin/env bash
# qbwr 합성 데이터 넣기·빼기 — 볼트 2026-10-18-msgr2-u9-qbwr-plan 3절(생성기 test/fixtures/msgr2/qbwr-seed.mjs).
# 사용: bash scripts/qbwr-seed.sh db [scale]     합성 옛 메신저 데이터(사람 60·조직 6·채널 300·글 20만·첨부 행 1,000·결재 130)를 넣는다
#       bash scripts/qbwr-seed.sh files [scale]  첨부 1,000개를 Storage API로 실제로 올린다(SUPABASE_SERVICE_ROLE_KEY, 버킷 msgr)
#       bash scripts/qbwr-seed.sh files-rm       올린 합성 첨부를 Storage API로 지운다(storage.objects SQL 삭제는 쓰지 않는다)
# 합성 계정 비밀번호는 QBWR_SEED_PASSWORD(.env.qbwr). 없으면 만들어 그 파일 끝에 붙이고 이름만 알린다 — 값은 출력하지 않는다.
# 계정은 전부 *@example.test다. 유건님 체험 계정은 만들거나 건드리지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-}"; [ -n "$CMD" ] || { sed -n '2,7p' "$0"; exit 2; }
. scripts/qbwr-env.sh
SCALE="${2:-1}"
OUT="${QBWR_OUT:-artifacts/qbwr}"; mkdir -p "$OUT"
case "$CMD" in
  db)
    if [ -z "${QBWR_SEED_PASSWORD:-}" ]; then
      QBWR_SEED_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
      printf '\nQBWR_SEED_PASSWORD=%s\n' "$QBWR_SEED_PASSWORD" >> "$QBWR_ENV"
      echo "합성 계정 비밀번호를 만들어 ${QBWR_ENV}의 QBWR_SEED_PASSWORD에 넣었습니다(값은 출력하지 않음)"
    fi
    node test/fixtures/msgr2/qbwr-seed.mjs --scale "$SCALE" --manifest "$OUT/attachments.json" > "$OUT/seed.sql"
    # 비밀번호는 표준 입력의 세션 설정으로만 — 인자·파일에 남기지 않는다
    { printf "set argo.seed_pw = '%s';\n" "${QBWR_SEED_PASSWORD//\'/\'\'}"; cat "$OUT/seed.sql"; } | psql "$C" -X -v ON_ERROR_STOP=1 -q -1 -f -
    rm -f "$OUT/seed.sql" ;;
  files|files-rm)
    [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] || { echo "거부  ${QBWR_ENV}에 SUPABASE_SERVICE_ROLE_KEY가 필요합니다"; exit 5; }
    URL="${QBWR_URL:-https://$QBWR_REF.supabase.co}"
    case "$URL" in *"$QBWR_REF"*) ;; *) echo "거부  Storage 주소가 qbwr가 아닙니다"; exit 5 ;; esac
    [ -f "$OUT/attachments.json" ] || node test/fixtures/msgr2/qbwr-seed.mjs --scale "$SCALE" --manifest "$OUT/attachments.json" > /dev/null
    QBWR_STORAGE_URL="$URL" node test/fixtures/msgr2/qbwr-files.mjs "${CMD#files}" "$OUT/attachments.json" ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
