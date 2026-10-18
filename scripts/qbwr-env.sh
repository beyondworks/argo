# qbwr(시험 Supabase) 접속 — 다른 qbwr-*.sh가 source한다. 운영(nvqo)에는 붙지 않는다(계획서 2026-10-18-msgr2-u9-qbwr-plan 1절, D17).
# 읽는 파일: QBWR_ENV(기본 .env.qbwr, gitignore `.env*`). 값은 출력하지 않는다.
#   QBWR_DB_URL                                  session pooler 접속 문자열, 또는
#   SUPABASE_DB_PASSWORD + QBWR_POOLER_HOST      비밀번호와 풀러 호스트(ap-southeast-1)
# 나가는 값: C(psql 접속 문자열), QBWR_REF. 접속 대상이 qbwr가 아니면 exit 5.
QBWR_REF=qbwrlynzvjmphwuqglsx
PROD_REF=nvqorpdorlbkhpcvwoty
QBWR_ENV="${QBWR_ENV:-.env.qbwr}"
case "$QBWR_ENV" in *.env.local|*.env) echo "거부  $QBWR_ENV — 운영 env 파일은 읽지 않습니다"; exit 5 ;; esac
[ -f "$QBWR_ENV" ] || { echo "거부  $QBWR_ENV 없음 — qbwr 접속 정보 파일이 필요합니다(값은 유건님이 파일에 직접)"; exit 5; }
set -a; . "$QBWR_ENV"; set +a
if [ -n "${QBWR_DB_URL:-}" ]; then
  C="$QBWR_DB_URL"
else
  [ -n "${SUPABASE_DB_PASSWORD:-}" ] && [ -n "${QBWR_POOLER_HOST:-}" ] || { echo "거부  ${QBWR_ENV}에 QBWR_DB_URL 또는 SUPABASE_DB_PASSWORD+QBWR_POOLER_HOST가 필요합니다"; exit 5; }
  export PGPASSWORD="$SUPABASE_DB_PASSWORD"
  C="host=$QBWR_POOLER_HOST port=5432 user=postgres.$QBWR_REF dbname=postgres sslmode=require"
fi
# 대상 검문: 접속 문자열과 (있으면) API 주소가 qbwr여야 하고 운영 ref가 어디에도 없어야 한다
case "$C" in *"$PROD_REF"*) echo "거부  접속 문자열에 운영 ref가 있습니다"; exit 5 ;; *"$QBWR_REF"*) ;; *) echo "거부  접속 문자열이 qbwr($QBWR_REF)가 아닙니다"; exit 5 ;; esac
for v in NEXT_PUBLIC_SUPABASE_URL SUPABASE_URL QBWR_URL; do
  u="${!v:-}"; [ -z "$u" ] && continue
  case "$u" in *"$QBWR_REF"*) ;; *) echo "거부  ${v}가 qbwr 주소가 아닙니다"; exit 5 ;; esac
done
export C QBWR_REF
