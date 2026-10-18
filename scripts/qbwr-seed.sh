#!/usr/bin/env bash
# qbwr 합성 데이터 넣기·빼기 — 볼트 2026-10-18-msgr2-u9-qbwr-plan 3절(생성기 test/fixtures/msgr2/qbwr-seed.mjs).
# 사용: bash scripts/qbwr-seed.sh db [scale]     합성 옛 메신저 데이터(사람 60·조직 6·채널 300·글 20만·첨부 행 1,000·결재 130)를 넣는다
#       bash scripts/qbwr-seed.sh files [scale]  첨부 1,000개를 Storage API로 실제로 올린다(버킷 msgr). QBWR_SERVICE_ROLE_KEY(JWT ref = qbwr)가 있으면 그 키로,
#                                                없으면 백필 뒤 글쓴이 합성 계정의 토큰(QBWR_ANON_KEY·QBWR_SEED_PASSWORD)으로 — 실제 사용자 경로와 같다
#       bash scripts/qbwr-seed.sh files-rm       올린 합성 첨부를 Storage API로 지운다(storage.objects SQL 삭제는 쓰지 않는다). 사용자 토큰 방식에서
#                                                정책상 못 지운 것은 artifacts/qbwr/storage-leftover.json에 남기고 서비스 키가 생긴 뒤 다시 지운다
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
    # 옛 합성 데이터가 있으면 멈춘다 — 생성기는 on conflict do nothing이라 새 값이 반영되지 않는다. 지우지는 않는다(계획서 6절 되돌리기 뒤 다시)
    old=$(psql "$C" -X -At -q -c "select (select count(*) from auth.users where email ~ '^p[0-9]{3}@example[.]test$') + (select count(*) from public.msgr_orgs where slug like 'qbwr-org-%')" 2>/dev/null || true)
    if [ "${old:-0}" -gt 0 ] 2>/dev/null; then
      echo "멈춤  qbwr에 옛 합성 데이터가 ${old}행 있습니다 — 새 값이 반영되지 않으니 계획서 6절(되돌리기)로 비운 뒤 다시 넣으세요(이 스크립트는 지우지 않습니다)"; exit 3
    fi
    if [ -z "$Q_SEED" ]; then
      Q_SEED=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
      printf '\nQBWR_SEED_PASSWORD=%s\n' "$Q_SEED" >> "$QBWR_ENV_FILE" # 검문이 고정한 파일(파일 안의 QBWR_ENV 줄로 바뀌지 않는다)
      echo "합성 계정 비밀번호를 만들어 ${QBWR_ENV_FILE}의 QBWR_SEED_PASSWORD에 넣었습니다(값은 출력하지 않음)"
    fi
    node test/fixtures/msgr2/qbwr-seed.mjs --scale "$SCALE" --manifest "$OUT/attachments.json" > "$OUT/seed.sql"
    # 비밀번호는 표준 입력의 세션 설정으로만 — 인자·파일에 남기지 않는다. set 문장은 pg_stat_statements에 원문으로 남아 select set_config로 넣는다(상수가 $1로 정규화된다)
    { printf "select set_config('argo.seed_pw', '%s', false);\n" "$(printf '%s' "$Q_SEED" | sed "s/'/''/g")"; cat "$OUT/seed.sql"; } | psql "$C" -X -v ON_ERROR_STOP=1 -q -1 -f - >/dev/null
    rm -f "$OUT/seed.sql" ;;
  files|files-rm)
    [ -f "$OUT/attachments.json" ] || node test/fixtures/msgr2/qbwr-seed.mjs --scale "$SCALE" --manifest "$OUT/attachments.json" > /dev/null
    if [ -n "$Q_SERVICE" ]; then # 서비스 키 방식
      printf '%s' "$Q_SERVICE" | qbwr_key_ok service_role || qbwr_deny "서비스 키가 qbwr의 service_role JWT가 아닙니다(ref·역할 확인, 값은 출력하지 않음)"
      QBWR_STORAGE_URL="$Q_URL" QBWR_SERVICE_ROLE_KEY="$Q_SERVICE" node test/fixtures/msgr2/qbwr-files.mjs "${CMD#files}" "$OUT/attachments.json"
    else # 사용자 토큰 방식(백필 뒤): 글쓴이 합성 계정의 권한으로. 못 한 것은 $OUT/storage-leftover.json
      [ -n "$Q_ANON" ] && [ -n "$Q_SEED" ] || qbwr_deny "${QBWR_ENV_FILE}에 QBWR_SERVICE_ROLE_KEY, 또는 QBWR_ANON_KEY·QBWR_SEED_PASSWORD가 필요합니다"
      printf '%s' "$Q_ANON" | qbwr_key_ok anon || qbwr_deny "QBWR_ANON_KEY가 qbwr의 anon JWT가 아닙니다(값은 출력하지 않음)"
      QBWR_ANON_KEY="$Q_ANON" QBWR_SEED_PASSWORD="$Q_SEED" QBWR_LEFTOVER="$OUT/storage-leftover.json" node test/fixtures/msgr2/qbwr-files.mjs "${CMD#files}" "$OUT/attachments.json"
    fi ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
