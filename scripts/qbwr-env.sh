# qbwr(시험 Supabase) 접속 검문 — 다른 qbwr-*.sh가 source한다. 운영(nvqo)에는 붙지 않는다(계획서 2026-10-18-msgr2-u9-qbwr-plan 1절, D17).
# 운영을 지키는 유일한 검문이라 "qbwr 문자열이 들어 있나"가 아니라 허용 형태만 통과시킨다(#1093 검수: 셸 PG* 변수·서비스 파일·% 인코딩·
# 대문자·conninfo 쿼리·env 파일의 기준값 덮어쓰기·Storage 경로 끼워 넣기로 운영에 닿던 우회). 맥 기본 bash 3.2에서도 돈다.
#
# 읽는 파일: QBWR_ENV(기본 .env.qbwr, 이름이 .env.qbwr로 시작해야 한다). source하지 않고 아래 이름만 KEY=VALUE로 읽는다. 값은 출력하지 않는다.
#   QBWR_DB_URL       postgresql URL 두 형태만: ① 사용자 postgres.<qbwr>, 호스트 aws-N-<지역>.pooler.supabase.com, 포트 5432·6543
#                     ② 사용자 postgres, 호스트 db.<qbwr>.supabase.co, 포트 5432. 둘 다 DB 이름 postgres, 쿼리는 sslmode=require만, % 금지
#   QBWR_DB_PASSWORD(옛 이름 SUPABASE_DB_PASSWORD) + QBWR_POOLER_HOST(aws-N-<지역>.pooler.supabase.com)  — URL 대신
#   QBWR_URL(https://<qbwr>.supabase.co만) · QBWR_ANON_KEY · QBWR_SERVICE_ROLE_KEY(옛 이름 SUPABASE_SERVICE_ROLE_KEY, 이 파일 안에서만) · QBWR_SEED_PASSWORD
# 나가는 값: C(비밀번호 없는 conninfo — 검증한 조각으로 다시 만든다), PGPASSWORD·PGSERVICEFILE·PGPASSFILE(나머지 PG*는 비운다), QBWR_REF,
#   Q_URL·Q_ANON·Q_SERVICE·Q_SEED·QBWR_ENV_FILE(export하지 않는다 — 부르는 쪽이 필요한 것만 명령 앞에 붙인다), qbwr_key_ok. 아니면 exit 5.
readonly QBWR_REF=qbwrlynzvjmphwuqglsx PROD_REF=nvqorpdorlbkhpcvwoty
qbwr_deny() { echo "거부  $1"; exit 5; }

# 1) 셸에서 들어온 PG* 변수(PGHOST·PGHOSTADDR·PGSERVICE·PGUSER·PGOPTIONS…)와 같은 이름의 셸 변수는 쓰지 않는다
for v in $(compgen -e | grep -E '^PG'); do unset "$v"; done
export PGSERVICEFILE=/dev/null PGPASSFILE=/dev/null PGSYSCONFDIR=/dev/null
unset QBWR_DB_URL QBWR_DB_PASSWORD SUPABASE_DB_PASSWORD QBWR_POOLER_HOST QBWR_URL QBWR_ANON_KEY QBWR_SERVICE_ROLE_KEY SUPABASE_SERVICE_ROLE_KEY QBWR_SEED_PASSWORD

# 2) env 파일: 이름 검사 → 허용 목록만 읽는 파서(파일 안의 QBWR_REF·PROD_REF·QBWR_ENV·PATH 같은 줄은 무시된다)
QBWR_ENV_FILE="${QBWR_ENV:-.env.qbwr}"
case "$(basename -- "$QBWR_ENV_FILE")" in .env.qbwr*) ;; *) qbwr_deny "$QBWR_ENV_FILE — env 파일 이름은 .env.qbwr로 시작해야 합니다(운영 env 파일은 읽지 않습니다)" ;; esac
[ -f "$QBWR_ENV_FILE" ] || qbwr_deny "$QBWR_ENV_FILE 없음 — qbwr 접속 정보 파일이 필요합니다(값은 유건님이 파일에 직접)"
readonly QBWR_ENV_FILE
Q_DB_URL=; Q_DB_PW=; Q_POOLER=; Q_URL=; Q_ANON=; Q_SERVICE=; Q_SEED=
_kv='^(export[[:space:]]+)?([A-Z_][A-Z0-9_]*)=(.*)$'; _dq='^"(.*)"$'; _sq="^'(.*)'$"
while IFS= read -r _l || [ -n "$_l" ]; do
  _l="${_l%$'\r'}"
  [[ $_l =~ $_kv ]] || continue
  _k="${BASH_REMATCH[2]}"; _v="${BASH_REMATCH[3]}"
  if [[ $_v =~ $_dq ]] || [[ $_v =~ $_sq ]]; then _v="${BASH_REMATCH[1]}"; fi
  case "$_k" in
    QBWR_DB_URL) Q_DB_URL="$_v" ;;
    QBWR_DB_PASSWORD|SUPABASE_DB_PASSWORD) Q_DB_PW="$_v" ;;
    QBWR_POOLER_HOST) Q_POOLER="$_v" ;;
    QBWR_URL) Q_URL="$_v" ;;
    QBWR_ANON_KEY) Q_ANON="$_v" ;;
    QBWR_SERVICE_ROLE_KEY|SUPABASE_SERVICE_ROLE_KEY) Q_SERVICE="$_v" ;;
    QBWR_SEED_PASSWORD) Q_SEED="$_v" ;;
  esac
done < "$QBWR_ENV_FILE"
unset _l _k _v _kv _dq _sq

# 3) 운영 ref는 대소문자와 상관없이 어느 주소 값에도 있으면 안 된다
for _x in "$Q_DB_URL" "$Q_POOLER" "$Q_URL"; do
  case "$(printf '%s' "$_x" | tr '[:upper:]' '[:lower:]')" in *"$PROD_REF"*) qbwr_deny "접속 정보에 운영 ref가 있습니다" ;; esac
done
unset _x

# 4) DB: 허용 형태만, 조각으로 나눠 conninfo를 다시 만든다(비밀번호는 PGPASSWORD로만 — psql 인자·ps에 남지 않게)
_pooler='^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$'
_url_pool='^postgres(ql)?://postgres\.qbwrlynzvjmphwuqglsx:([^@/?#[:space:]]+)@([a-z0-9.-]+):(5432|6543)/postgres(\?sslmode=require)?$'
_url_direct='^postgres(ql)?://postgres:([^@/?#[:space:]]+)@db\.qbwrlynzvjmphwuqglsx\.supabase\.co:5432/postgres(\?sslmode=require)?$'
if [ -n "$Q_DB_URL" ]; then
  case "$Q_DB_URL" in *%*) qbwr_deny "QBWR_DB_URL에 % 인코딩은 쓰지 않습니다(비밀번호에 특수문자가 있으면 QBWR_DB_PASSWORD + QBWR_POOLER_HOST로)" ;; esac
  if [[ $Q_DB_URL =~ $_url_pool ]]; then
    _user="postgres.$QBWR_REF"; Q_DB_PW="${BASH_REMATCH[2]}"; _host="${BASH_REMATCH[3]}"; _port="${BASH_REMATCH[4]}"
    [[ $_host =~ $_pooler ]] || qbwr_deny "QBWR_DB_URL의 호스트가 Supabase 풀러(aws-N-<지역>.pooler.supabase.com)가 아닙니다"
  elif [[ $Q_DB_URL =~ $_url_direct ]]; then
    _user=postgres; Q_DB_PW="${BASH_REMATCH[2]}"; _host="db.$QBWR_REF.supabase.co"; _port=5432
  else
    qbwr_deny "QBWR_DB_URL이 허용 형태가 아닙니다(qbwr 풀러 또는 db.$QBWR_REF.supabase.co, 소문자, 쿼리는 sslmode=require만)"
  fi
else
  [ -n "$Q_DB_PW" ] && [ -n "$Q_POOLER" ] || qbwr_deny "${QBWR_ENV_FILE}에 QBWR_DB_URL 또는 QBWR_DB_PASSWORD+QBWR_POOLER_HOST가 필요합니다"
  [[ $Q_POOLER =~ $_pooler ]] || qbwr_deny "QBWR_POOLER_HOST가 Supabase 풀러(aws-N-<지역>.pooler.supabase.com)가 아닙니다"
  _user="postgres.$QBWR_REF"; _host="$Q_POOLER"; _port=5432
fi
export PGPASSWORD="$Q_DB_PW"
C="host=$_host port=$_port user=$_user dbname=postgres sslmode=require"
readonly C
unset Q_DB_URL Q_DB_PW Q_POOLER _host _port _user _pooler _url_pool _url_direct

# 5) API 주소는 정확히 qbwr 하나(경로·포트·다른 호스트 금지)
case "$Q_URL" in
  ""|"https://$QBWR_REF.supabase.co"|"https://$QBWR_REF.supabase.co/") Q_URL="https://$QBWR_REF.supabase.co" ;;
  *) qbwr_deny "QBWR_URL은 https://$QBWR_REF.supabase.co만 쓸 수 있습니다" ;;
esac
readonly Q_URL

# 6) 키 확인: JWT 페이로드의 ref가 qbwr이고 역할이 맞는가(키는 표준 입력으로, 값은 출력하지 않는다). 사용: printf %s "$Q_SERVICE" | qbwr_key_ok service_role
qbwr_key_ok() {
  node -e 'let s="";process.stdin.on("data",(d)=>{s+=d}).on("end",()=>{try{const p=JSON.parse(Buffer.from(s.trim().split(".")[1],"base64url"));process.exit(p.ref==="qbwrlynzvjmphwuqglsx"&&p.role===process.argv[1]?0:1)}catch{process.exit(1)}})' "$1"
}
export C QBWR_REF
