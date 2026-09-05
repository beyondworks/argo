#!/usr/bin/env bash
# 팀 메신저 개발·E2E용 로컬 Supabase 스택 — Docker + supabase CLI. 실 프로젝트 무접촉.
# 사용: bash scripts/msgr-local-stack.sh start|reset|stop|status   (기본 디렉터리 ~/.argo/msgr-local-stack, ARGO_SB_DIR로 변경)
# start: 프로젝트 초기화(최초) + 레포 마이그레이션 복사 + 핵심 서비스만 기동(db·auth·rest·realtime — storage 등은 제외, 첨부 E2E는 후속)
# reset: 레포 마이그레이션을 다시 복사하고 db reset(스키마 변경 뒤)  ·  stop: 컨테이너 종료(데이터 폐기)
# 이후: E2E_SB_DIR=~/.argo/msgr-local-stack node scripts/e2e-msgr-bridge.mjs / node scripts/msgr-dev-seed.mjs
#       메신저 앱: `supabase status -o env`의 API_URL·ANON_KEY를 apps/messenger/.env.local(VITE_SUPABASE_URL/ANON_KEY)에.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="${ARGO_SB_DIR:-$HOME/.argo/msgr-local-stack}"
EXCLUDE="studio,imgproxy,inbucket,mailpit,logflare,vector,edge-runtime,supavisor,pgbouncer,storage-api"
cmd="${1:-start}"
case "$cmd" in
  start)
    mkdir -p "$DIR" && cd "$DIR"
    [ -f supabase/config.toml ] || supabase init >/dev/null
    mkdir -p supabase/migrations && cp "$REPO"/supabase/migrations/*.sql supabase/migrations/
    supabase start -x "$EXCLUDE"
    ;;
  reset)
    cd "$DIR" && cp "$REPO"/supabase/migrations/*.sql supabase/migrations/ && supabase db reset
    ;;
  stop) cd "$DIR" && supabase stop --no-backup ;;
  status) cd "$DIR" && supabase status ;;
  *) echo "usage: $0 start|reset|stop|status" >&2; exit 2 ;;
esac
