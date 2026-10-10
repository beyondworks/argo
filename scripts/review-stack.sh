#!/usr/bin/env bash
# 발행 전 로컬 검수 스택 — 본체(:3500) + 메신저 웹(:5191)을 이 맥의 로컬 Supabase(:56321)에 붙여 띄운다.
# 운영 DB·실제 계정·상주 서버(:3001)·실제 데이터(~/.argo)는 건드리지 않는다. 러너는 이 맥의 Claude Code·Codex 로그인을 그대로 쓴다.
#
#   bash scripts/review-stack.sh up [커밋|브랜치]   지정한 코드(기본 origin/main)로 띄운다. 처음이면 예시 데이터도 넣는다
#   bash scripts/review-stack.sh down              이 스택이 띄운 것만 끈다(본체·메신저·로컬 Supabase). 데이터는 남긴다
#   bash scripts/review-stack.sh reset             로컬 DB와 검수 데이터 폴더를 비우고 예시 데이터를 다시 넣는다
#   bash scripts/review-stack.sh status            주소·상태·나간 연결 요약
#   bash scripts/review-stack.sh login             본체 로그인 링크(한 번 쓰임)를 기본 브라우저로 연다
#   bash scripts/review-stack.sh event <분> [제목]  <분>(기본 25) 뒤 시작하는 개인 일정 — 하트비트 '곧 시작' 확인용(일정 확인이 15분 간격)
#
# 값(키·비밀번호)은 출력하지 않는다. Supabase 주소·키는 실행 때 `supabase status -o env`에서 읽는다.
# 바꿀 수 있는 곳: ARGO_REVIEW_HOME(기본 ~/.argo-review) · ARGO_REVIEW_WT(코드 작업 공간) · ARGO_REVIEW_SECRETS(시험 계정 비밀번호 파일)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$(cd "$(git -C "$REPO" rev-parse --git-common-dir)/.." && pwd)"   # 워크트리에서 실행해도 원래 저장소
RH="${ARGO_REVIEW_HOME:-$HOME/.argo-review}"
WT="${ARGO_REVIEW_WT:-$(cd "$MAIN/../.." && pwd)/_worktrees/argo-review}"
SB_DIR="$RH/supabase-project"
DATA="$RH/data"            # 본체 ARGO_ROOT — 실제 ~/.argo와 다른 곳
RUN="$RH/run"
LOGS="$RH/logs"
SECRETS="${ARGO_REVIEW_SECRETS:-$RH/secrets/review-account.secret}"
PROJECT_ID="argo-review"
DB_CONTAINER="supabase_db_$PROJECT_ID"
BODY_PORT=3500
MSGR_PORT=5191
SB_API_PORT=56321
SB_DB_PORT=56322
# 검수에 필요 없는 컨테이너는 띄우지 않는다(도커 메모리). storage(동기화·리스·첨부)·realtime(메신저 즉시 반영)은 켠다.
SB_EXCLUDE="studio,imgproxy,mailpit,logflare,vector,edge-runtime,supavisor,postgres-meta"
BODY_URL="http://localhost:$BODY_PORT"
MSGR_URL="http://127.0.0.1:$MSGR_PORT"

say() { printf '[review] %s\n' "$*"; }
die() { printf '[review] 중단: %s\n' "$*" >&2; exit 1; }

# ── 안전 관문: 검수 데이터 폴더가 실제 Argo 데이터와 겹치면 아무것도 하지 않는다 ──
guard_paths() {
  case "$DATA/" in
    "$HOME/.argo/"*|"$HOME/Library/Application Support/com.beyondworks.argo/"*) die "검수 데이터 폴더가 실제 Argo 데이터 안에 있습니다: $DATA" ;;
  esac
  [ "$DATA" != "$HOME" ] || die "검수 데이터 폴더가 홈입니다"
}
guard_env_files() { # 작업 공간에 .env 파일이 있으면 Next·Vite가 읽어 운영 주소가 섞일 수 있다
  local f
  for f in "$WT"/.env "$WT"/.env.* "$WT"/apps/messenger/.env "$WT"/apps/messenger/.env.*; do
    [ -e "$f" ] || continue
    case "$f" in *.example) continue ;; esac
    die "작업 공간에 환경 파일이 있습니다($f) — 운영 주소가 섞일 수 있어 띄우지 않습니다"
  done
}

# ── 로컬 Supabase ──
sb() { (cd "$SB_DIR" && supabase "$@"); }
sb_running() { docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER"; }
sb_init() {
  [ -f "$SB_DIR/supabase/config.toml" ] && return 0
  mkdir -p "$SB_DIR" && (cd "$SB_DIR" && supabase init --force >/dev/null 2>&1)
  python3 - "$SB_DIR/supabase/config.toml" "$PROJECT_ID" "$BODY_PORT" "$MSGR_PORT" <<'PY'
import re, sys
p, pid, body, msgr = sys.argv[1:5]
s = open(p).read()
s = re.sub(r'^project_id = ".*"', f'project_id = "{pid}"', s, flags=re.M)
for a in ['54320', '54321', '54322', '54323', '54324', '54325', '54326', '54327', '54328', '54329']:
    s = re.sub(rf'(port = ){a}\b', rf'\g<1>56{a[2:]}', s)
s = s.replace('inspector_port = 8083', 'inspector_port = 56383')
s = re.sub(r'^site_url = ".*"', f'site_url = "http://localhost:{body}"', s, flags=re.M)
urls = [f'http://localhost:{body}', f'http://127.0.0.1:{body}', f'http://localhost:{msgr}', f'http://127.0.0.1:{msgr}']
s = re.sub(r'^additional_redirect_urls = \[.*\]', 'additional_redirect_urls = [' + ', '.join(f'"{u}"' for u in urls) + ']', s, flags=re.M)
open(p, 'w').write(s)
PY
  say "로컬 Supabase 설정을 만들었습니다: $SB_DIR (API :$SB_API_PORT, DB :$SB_DB_PORT)"
}
sb_sync_migrations() { # 지정 코드의 마이그레이션을 그대로 복사(없어진 파일은 지운다)
  mkdir -p "$SB_DIR/supabase/migrations"
  local f
  for f in "$SB_DIR"/supabase/migrations/*.sql; do
    [ -e "$f" ] || continue
    [ -e "$WT/supabase/migrations/$(basename "$f")" ] || { say "지정 코드에 없는 마이그레이션: $(basename "$f") — 적용된 DB와 다를 수 있어 reset을 권합니다"; rm -f "$f"; }
  done
  cp "$WT"/supabase/migrations/*.sql "$SB_DIR/supabase/migrations/"
}
sb_up() {
  sb_init
  sb_sync_migrations
  if sb_running; then
    sb migration up --local >"$LOGS/sb-migrate.log" 2>&1 || { tail -20 "$LOGS/sb-migrate.log" >&2; die "마이그레이션 적용 실패(로그: $LOGS/sb-migrate.log)"; }
  else
    sb start -x "$SB_EXCLUDE" >"$LOGS/sb-start.log" 2>&1 || { grep -iE 'error|failed' "$LOGS/sb-start.log" | tail -20 >&2; die "로컬 Supabase 시작 실패(로그: $LOGS/sb-start.log)"; }
    sb migration up --local >"$LOGS/sb-migrate.log" 2>&1 || true
  fi
  sb_check_functions
}
sb_env() { # 실행 때 읽는다 — 화면에 내지 않는다
  local out; out="$(sb status -o env 2>/dev/null)" || die "로컬 Supabase 상태를 읽지 못했습니다"
  SB_URL="$(printf '%s\n' "$out" | sed -n 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1)"
  SB_ANON="$(printf '%s\n' "$out" | sed -n 's/^ANON_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1)"
  SB_SERVICE="$(printf '%s\n' "$out" | sed -n 's/^SERVICE_ROLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' | head -1)"
  [ -n "$SB_URL" ] && [ -n "$SB_ANON" ] && [ -n "$SB_SERVICE" ] || die "로컬 Supabase 주소·키를 읽지 못했습니다"
  case "$SB_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) die "Supabase 주소가 로컬이 아닙니다" ;; esac
}
psql_q() { docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -Atq -v ON_ERROR_STOP=1 "$@"; }
sb_check_functions() { # 마이그레이션 기록과 함께 '함수가 실제로 있는가'로 대조(만들고 지운 순서까지 따라간다)
  local applied files want have missing
  files=$(ls "$SB_DIR"/supabase/migrations/*.sql | wc -l | tr -d ' ')
  applied=$(psql_q -c "select count(*) from supabase_migrations.schema_migrations" 2>/dev/null || echo '?')
  want=$(node -e '
    const fs = require("fs"), path = require("path"); const dir = process.argv[1]; const live = new Set();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
      const s = fs.readFileSync(path.join(dir, f), "utf8").replace(/--[^\n]*/g, "");
      const re = /\b(create(?:\s+or\s+replace)?|drop)\s+function\s+(?:if\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
      for (const m of s.matchAll(re)) { const before = s.slice(Math.max(0, m.index - 40), m.index); if (/\b(storage|auth|cron|extensions|realtime)\.\s*$/i.test(before)) continue; if (m[1].toLowerCase() === "drop") live.delete(m[2].toLowerCase()); else live.add(m[2].toLowerCase()); }
    }
    console.log([...live].sort().join("\n"));' "$SB_DIR/supabase/migrations")
  have=$(psql_q -c "select distinct lower(p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1")
  missing=$(comm -23 <(printf '%s\n' "$want" | sort -u) <(printf '%s\n' "$have" | sort -u) | tr '\n' ' ')
  say "마이그레이션 파일 ${files}개 · 적용 기록 ${applied}개 · 정의된 public 함수 $(printf '%s\n' "$want" | grep -c .)개 중 없는 것: ${missing:-없음}"
  [ -z "$missing" ] || say "주의: 위 함수가 DB에 없습니다 — reset으로 다시 적용하세요"
}

# ── 코드 작업 공간 ──
checkout() {
  local ref="${1:-origin/main}" sha
  git -C "$MAIN" fetch -q origin || say "origin을 가져오지 못했습니다 — 로컬에 있는 것으로 진행"
  if git -C "$MAIN" rev-parse -q --verify "origin/$ref^{commit}" >/dev/null; then sha=$(git -C "$MAIN" rev-parse "origin/$ref^{commit}")
  else sha=$(git -C "$MAIN" rev-parse -q --verify "$ref^{commit}") || die "찾을 수 없는 커밋·브랜치: $ref"; fi
  if [ ! -e "$WT/.git" ]; then
    git -C "$MAIN" worktree add -q --detach "$WT" "$sha"
  else
    [ -z "$(git -C "$WT" status --porcelain --untracked-files=no)" ] || die "작업 공간에 고친 파일이 있습니다($WT) — 커밋하거나 되돌린 뒤 다시"
    git -C "$WT" checkout -q --detach "$sha"
  fi
  printf '%s %s\n' "$sha" "$ref" > "$RUN/ref"
  say "코드: $ref → $(git -C "$WT" log -1 --format='%h %s' | cut -c1-90)"
}
deps() { # 잠금 파일이 바뀐 때만 설치
  local d h
  for d in "$WT" "$WT/apps/messenger"; do
    h=$(shasum "$d/package-lock.json" | cut -d' ' -f1)
    if [ ! -d "$d/node_modules" ] || [ "$(cat "$d/node_modules/.review-lock" 2>/dev/null)" != "$h" ]; then
      say "의존성 설치: ${d#$WT}"; (cd "$d" && npm ci --no-audit --no-fund >"$LOGS/npm-ci.log" 2>&1) || die "npm ci 실패(로그: $LOGS/npm-ci.log)"
      echo "$h" > "$d/node_modules/.review-lock"
    fi
  done
}

# ── 프로세스(본체·메신저) — 새 세션(그룹)으로 띄워 그룹째 끈다 ──
port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true; }
start_detached() { # $1 이름, $2 작업 폴더, 나머지 = 명령
  local name="$1" dir="$2"; shift 2
  # 괄호 안에서 exec — $!가 곧 서버 pid(새 세션의 그룹 대표)가 되고, 부르는 쪽의 출력 파이프를 붙잡지 않는다
  (cd "$dir" && exec nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die' "$@") >"$LOGS/$name.log" 2>&1 </dev/null &
  echo $! > "$RUN/$name.pid"
}
stop_proc() {
  local name="$1" pid
  pid=$(cat "$RUN/$name.pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f "$RUN/$name.pid"
}
base_env() { # 부르는 셸의 환경(운영 주소 등)을 물려받지 않는다 — 필요한 것만 넘긴다
  printf '%s\0' "PATH=$PATH" "HOME=$HOME" "USER=${USER:-$(id -un)}" "LOGNAME=${LOGNAME:-$(id -un)}" "TMPDIR=${TMPDIR:-/tmp}" "LANG=${LANG:-ko_KR.UTF-8}" "SHELL=${SHELL:-/bin/zsh}"
}
start_body() {
  [ -z "$(port_pid $BODY_PORT)" ] || die "포트 ${BODY_PORT}를 다른 프로세스가 쓰고 있습니다(pid $(port_pid $BODY_PORT))"
  mkdir -p "$DATA" "$RH/cache" "$RH/cli-home"
  : >> "$LOGS/egress.log"
  local envs=(); while IFS= read -r -d '' e; do envs+=("$e"); done < <(base_env)
  start_detached body "$WT" env -i "${envs[@]}" \
    ARGO_ROOT="$DATA" ARGO_CACHE_DIR="$RH/cache" ARGO_CLI_HOME="$RH/cli-home" \
    NEXT_PUBLIC_SUPABASE_URL="$SB_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$SB_ANON" \
    REVIEW_EGRESS_LOG="$LOGS/egress.log" NODE_OPTIONS="--import $REPO/scripts/review-stack-egress.mjs" NEXT_TELEMETRY_DISABLED=1 \
    node node_modules/next/dist/bin/next dev -p "$BODY_PORT" -H 127.0.0.1
}
start_msgr() {
  [ -z "$(port_pid $MSGR_PORT)" ] || die "포트 ${MSGR_PORT}를 다른 프로세스가 쓰고 있습니다(pid $(port_pid $MSGR_PORT))"
  local envs=(); while IFS= read -r -d '' e; do envs+=("$e"); done < <(base_env)
  start_detached msgr "$WT/apps/messenger" env -i "${envs[@]}" \
    VITE_SUPABASE_URL="$SB_URL" VITE_SUPABASE_ANON_KEY="$SB_ANON" \
    node node_modules/vite/bin/vite.js --port "$MSGR_PORT" --strictPort --host 127.0.0.1
}
wait_http() { # $1 주소, $2 초
  for _ in $(seq 1 "$2"); do curl -fsS -o /dev/null "$1" 2>/dev/null && return 0; sleep 1; done; return 1
}
seed_node() {
  REVIEW_SB_URL="$SB_URL" REVIEW_SB_ANON="$SB_ANON" REVIEW_SB_SERVICE="$SB_SERVICE" REVIEW_DB_CONTAINER="$DB_CONTAINER" \
  REVIEW_BODY_URL="$BODY_URL" REVIEW_ARGO_ROOT="$DATA" REVIEW_SECRETS="$SECRETS" \
    node "$REPO/scripts/review-stack-seed.mjs" "$@"
}

egress_summary() {
  local f="$LOGS/egress.log"
  [ -s "$f" ] || { say "나간 연결 기록: 아직 없음"; return 0; }
  local prod others
  prod=$(grep -ciE 'supabase\.(co|com|in)' "$f" || true)
  others=$(awk '{print $4}' "$f" | sed 's/:[0-9]*$//' | grep -vE '^(127\.0\.0\.1|localhost|::1|\[::1\])$' | sort | uniq -c | sort -rn | head -8 | awk '{printf "%s(%s) ", $2, $1}')
  say "나간 연결(본체·러너): 운영 Supabase ${prod}건 · 로컬 밖 ${others:-없음}"
}

status() {
  local ref; ref=$(cat "$RUN/ref" 2>/dev/null || echo '-')
  say "코드: ${ref} ($WT)"
  say "본체:   $BODY_URL  pid=$(cat "$RUN/body.pid" 2>/dev/null || echo -) listen=$(port_pid $BODY_PORT) 로그=$LOGS/body.log"
  say "메신저: $MSGR_URL  pid=$(cat "$RUN/msgr.pid" 2>/dev/null || echo -) listen=$(port_pid $MSGR_PORT) 로그=$LOGS/msgr.log"
  say "로컬 Supabase: http://127.0.0.1:$SB_API_PORT (DB :$SB_DB_PORT) 컨테이너 $(docker ps --format '{{.Names}}' | grep -c "_$PROJECT_ID\$" || true)개"
  say "데이터 폴더(ARGO_ROOT): $DATA"
  say "시험 계정: $(sed -n 's/^REVIEW_EMAIL=//p' "$SECRETS" 2>/dev/null || echo '없음') · 비밀번호 파일: $SECRETS"
  egress_summary
}

mkdir -p "$RUN" "$LOGS"
guard_paths
cmd="${1:-status}"; shift || true
case "$cmd" in
  up)
    checkout "${1:-origin/main}"
    guard_env_files
    deps
    sb_up
    sb_env
    stop_proc body; stop_proc msgr
    start_body; start_msgr
    wait_http "$BODY_URL/api/ping" 180 || die "본체가 3분 안에 뜨지 않았습니다(로그: $LOGS/body.log)"
    wait_http "$MSGR_URL/" 60 || die "메신저가 1분 안에 뜨지 않았습니다(로그: $LOGS/msgr.log)"
    if [ ! -f "$RUN/seeded" ]; then seed_node seed && date > "$RUN/seeded"; fi
    status
    ;;
  down)
    stop_proc body; stop_proc msgr
    [ -d "$SB_DIR/supabase" ] && sb_running && { sb stop >/dev/null 2>&1 || say "로컬 Supabase를 끄지 못했습니다"; }
    for p in $BODY_PORT $MSGR_PORT $SB_API_PORT $SB_DB_PORT; do [ -z "$(port_pid "$p")" ] || say "포트 ${p}가 아직 열려 있습니다(pid $(port_pid "$p"))"; done
    say "껐습니다(데이터는 남김: $RH)"
    ;;
  reset)
    [ -e "$WT/.git" ] || die "먼저 up을 실행하세요"
    stop_proc body
    sb_sync_migrations
    sb_running || sb start -x "$SB_EXCLUDE" >"$LOGS/sb-start.log" 2>&1 || die "로컬 Supabase 시작 실패"
    if ! sb db reset --local >"$LOGS/sb-reset.log" 2>&1; then
      # 마이그레이션을 다 적용한 뒤 컨테이너를 다시 띄우는 단계에서 502로 끝나는 경우가 있다(실측 2026-10-10) — 그때는 다 뜰 때까지 기다리고 아래 대조로 판정한다
      grep -q 'Restarting containers' "$LOGS/sb-reset.log" && wait_http "http://127.0.0.1:$SB_API_PORT/auth/v1/health" 90 \
        || { tail -20 "$LOGS/sb-reset.log" >&2; die "DB 초기화 실패(로그: $LOGS/sb-reset.log)"; }
    fi
    docker restart "supabase_rest_$PROJECT_ID" >/dev/null   # 스키마를 새로 만들었으니 REST 스키마 캐시도 새로
    for _ in $(seq 1 60); do case "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$SB_API_PORT/rest/v1/")" in 000|502|503) sleep 1 ;; *) break ;; esac; done
    sb_check_functions
    case "$DATA" in */.argo-review/data|"$RH"/data) rm -rf "$DATA" ;; *) die "데이터 폴더 경로가 예상과 다릅니다: $DATA" ;; esac
    rm -f "$RUN/seeded" "$SECRETS"
    sb_env
    start_body
    wait_http "$BODY_URL/api/ping" 180 || die "본체가 3분 안에 뜨지 않았습니다(로그: $LOGS/body.log)"
    [ -n "$(port_pid $MSGR_PORT)" ] || start_msgr
    seed_node seed && date > "$RUN/seeded"
    status
    ;;
  status) status ;;
  login) sb_env; seed_node login ;;
  event) sb_env; seed_node event "${1:-25}" "${@:2}" ;;
  seed) sb_env; seed_node seed && date > "$RUN/seeded" ;;
  *) sed -n '2,13p' "$0"; exit 2 ;;
esac
