#!/usr/bin/env bash
# 메신저 v2 체험 — 메신저 데스크톱 앱을 개발 모드(tauri dev)로 qbwr에 붙여 띄운다. 로그인은 이 앱에서만 된다:
# 메신저는 Google·GitHub 로그인을 앱 셸의 루프백 핸드오프(src-tauri pair.rs, src/oauth-handoff.mjs)로만 받고, 일반 브라우저 탭은 'not_app'으로 끝난다.
# 사용: bash scripts/msgr2-trial-app.sh [--fake] [--port 5310]
#   화면 서버는 scripts/msgr2-trial-web.sh(관문 포함)를 이 스크립트가 같이 띄우고, 앱이 끝나면 같이 끈다.
#   identifier를 com.beyondworks.argo.messenger.trial로 바꾼다 — 설치된 Argo Messenger와 웹뷰 저장소(로그인·설정)·창 상태를 나눠 쓰지 않게.
#   (데스크톱 설정에는 딥링크 스킴이 없다 — argo-messenger://는 iOS·Android 설정에만 있고, 맥 로그인 복귀는 127.0.0.1 루프백이라 설치된 앱으로 가지 않는다. 키체인을 쓰는 코드도 없다.)
#   Rust 빌드 결과는 ~/.argo/msgr2-trial/target(저장소 밖, 다음 실행에 다시 쓴다). 첫 빌드는 몇 분 걸린다.
# qbwr 사전 설정: Auth Redirect URLs에 http://127.0.0.1:*/auth/paired, Google·GitHub 공급자 켜기.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FAKE=(); PORT=5310
while [ $# -gt 0 ]; do
  case "$1" in
    --fake) FAKE=(--fake) ;;
    --port) PORT="$2"; shift ;;
    *) echo "usage: $0 [--fake] [--port N]" >&2; exit 2 ;;
  esac
  shift
done
# 관문만 먼저(실패하면 아무것도 띄우지 않는다) — 값은 받지 않는다(화면 서버가 다시 받는다)
GUARD_ARGS=(--checkout "$REPO"); [ ${#FAKE[@]} -gt 0 ] && GUARD_ARGS+=(--fake)
node "$REPO/scripts/msgr2-trial-guard.mjs" "${GUARD_ARGS[@]}" > /dev/null || exit 5
[ -f "$REPO/apps/messenger/node_modules/.bin/tauri" ] || { echo "[msgr2-trial] apps/messenger 의존이 없습니다 — (cd apps/messenger && npm ci)" >&2; exit 3; }
command -v cargo > /dev/null || { echo "[msgr2-trial] cargo가 없습니다(Rust) — rustup으로 설치" >&2; exit 3; }
LOGDIR="$HOME/.argo/msgr2-trial"; mkdir -p "$LOGDIR"
bash "$REPO/scripts/msgr2-trial-web.sh" "${FAKE[@]}" --port "$PORT" > "$LOGDIR/web.log" 2>&1 &
WEB=$!
trap 'kill "$WEB" 2>/dev/null || true' EXIT INT TERM
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; kill -0 "$WEB" 2>/dev/null || { cat "$LOGDIR/web.log" >&2; exit 5; }; sleep 1; done
echo "[msgr2-trial] 메신저 앱(개발 모드, identifier ….trial)을 빌드·실행합니다 — 화면 서버 http://127.0.0.1:$PORT (로그 $LOGDIR/web.log)"
# 업데이터 확인 주소를 닿지 않는 로컬로 — 개발 앱(0.1.x)이 운영 최신판을 "업데이트 있음"으로 띄워 설치하려 들지 않게(실패는 진단에만 남는다)
CONF="$(PORT="$PORT" REPO="$REPO" node -e '
  const c = require(`${process.env.REPO}/apps/messenger/src-tauri/tauri.conf.json`); // 창 설정은 원본에서 읽고 제목만 바꾼다(배열은 통째로 덮이므로 사본을 손으로 두지 않는다)
  const windows = (c.app?.windows ?? []).map((w) => ({ ...w, title: "Argo Messenger Trial (qbwr)" }));
  process.stdout.write(JSON.stringify({ identifier: "com.beyondworks.argo.messenger.trial", productName: "Argo Messenger Trial", app: { windows },
    build: { devUrl: `http://127.0.0.1:${process.env.PORT}`, beforeDevCommand: "" }, plugins: { updater: { endpoints: ["http://127.0.0.1:9/msgr2-trial-no-update.json"] } } }));
' )"
cd "$REPO/apps/messenger"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" CARGO_TARGET_DIR="$HOME/.argo/msgr2-trial/target" \
  node_modules/.bin/tauri dev --no-watch --config "$CONF"
