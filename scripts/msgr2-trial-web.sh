#!/usr/bin/env bash
# 메신저 v2 체험 — 메신저 웹(apps/messenger)을 qbwr에 붙여 띄운다(유건님이 이 맥 브라우저에서 가입·공간·방·초대·에이전트 일 시키기를 해 본다).
# 사용: bash scripts/msgr2-trial-web.sh [--fake] [--port 5310]
#   키 파일: ~/.argo/msgr2-trial.env (저장소 밖) — MSGR2_TRIAL_URL=https://qbwrlynzvjmphwuqglsx.supabase.co, MSGR2_TRIAL_ANON_KEY=<qbwr 공개 키>
#   --fake: qbwr 대신 v2 셸 가짜 서버(test/v2-shell.supabase.mjs)로 — 스크립트가 뜨는지만 본다. 화면은 /test/v2-shell.fixture.html
# 관문(scripts/msgr2-trial-guard.mjs)이 걸리면 아무것도 띄우지 않는다(exit 5): qbwr 아닌 주소, 공개 키 아님, 체크아웃에 .env 파일.
# 환경은 비우고(env -i) 필요한 값만 넣는다 — 셸에 남은 운영 변수가 섞이지 않게. 키 값은 화면에 찍지 않는다.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FAKE=0; PORT=5310
while [ $# -gt 0 ]; do
  case "$1" in
    --fake) FAKE=1 ;;
    --port) PORT="$2"; shift ;;
    *) echo "usage: $0 [--fake] [--port N]" >&2; exit 2 ;;
  esac
  shift
done
GUARD_ARGS=(--checkout "$REPO"); [ "$FAKE" = 1 ] && GUARD_ARGS+=(--fake)
VARS="$(node "$REPO/scripts/msgr2-trial-guard.mjs" "${GUARD_ARGS[@]}")" || exit 5
eval "$VARS"
[ -x "$REPO/apps/messenger/node_modules/vite/bin/vite.js" ] || [ -f "$REPO/apps/messenger/node_modules/vite/bin/vite.js" ] || { echo "[msgr2-trial] apps/messenger 의존이 없습니다 — (cd apps/messenger && npm ci)" >&2; exit 3; }
PAGE="http://127.0.0.1:$PORT/"; [ "$FAKE" = 1 ] && PAGE="http://127.0.0.1:$PORT/test/v2-shell.fixture.html?lang=ko"
echo "[msgr2-trial] 메신저 웹: $PAGE (서버 $([ "$FAKE" = 1 ] && echo '가짜 하네스' || echo 'qbwr'), v2 켜짐)"
cd "$REPO/apps/messenger"
exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  VITE_SUPABASE_URL="$MSGR2_TRIAL_URL" VITE_SUPABASE_ANON_KEY="$MSGR2_TRIAL_ANON_KEY" VITE_MSGR_V2=1 \
  MSGR2_TRIAL_FAKE="$FAKE" MSGR2_TRIAL_WEB_PORT="$PORT" \
  node node_modules/vite/bin/vite.js --config scripts/msgr2-trial.config.mjs
