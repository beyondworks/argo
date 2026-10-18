#!/usr/bin/env bash
# 메신저 v2 체험 — 본체(Argo)를 임시 데이터 폴더·별도 포트에서 qbwr에 붙여 띄운다. 메신저 v2 연결(ARGO_AGENT_LINK=1)을 켜고 옛 브리지는 끈다(ARGO_MSGR_LEGACY=off).
# 사용: bash scripts/msgr2-trial-body.sh [--fake] [--port 3310] [--root ~/.argo/msgr2-trial/root]
#   키 파일: ~/.argo/msgr2-trial.env (저장소 밖, msgr2-trial-web.sh와 같은 파일)
#   --fake: qbwr 대신 로컬 하네스 주소(http://127.0.0.1:5297)로 — 본체가 뜨고 로그인 화면이 나오는지만 본다(로그인·에이전트 연결은 안 된다)
# 상주 :3001과 실제 workspaces는 건드리지 않는다: 데이터 폴더는 이름에 msgr2-trial이 든 곳만(관문), 포트는 3310(다른 포트면 --port).
# .env 파일이 있는 체크아웃(본 저장소 루트 등)에서는 멈춘다 — Next가 .env.local을 스스로 읽어 운영 값(서비스 키 등)이 섞이기 때문. 체험용 워크트리에서 실행한다.
# 본체 로그인(기기 등록) 순서: 브라우저로 http://127.0.0.1:<포트> → 로그인 화면에서 이메일 코드(OTP) → 기기 세션이 <데이터 폴더>에 저장되고
#   메신저 v2 연결부가 그 세션으로 qbwr에 기기(runner)를 등록한다(src/devicesession.mjs saveDeviceSession → registerRunnerOnLogin).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
FAKE=0; PORT=3310; ROOT="$HOME/.argo/msgr2-trial/root"
while [ $# -gt 0 ]; do
  case "$1" in
    --fake) FAKE=1 ;;
    --port) PORT="$2"; shift ;;
    --root) ROOT="$2"; shift ;;
    *) echo "usage: $0 [--fake] [--port N] [--root DIR]" >&2; exit 2 ;;
  esac
  shift
done
[ "$PORT" = 3001 ] && { echo "[msgr2-trial] 멈춤: 3001은 상주 본체 포트입니다" >&2; exit 5; }
GUARD_ARGS=(--checkout "$REPO" --root "$ROOT"); [ "$FAKE" = 1 ] && GUARD_ARGS+=(--fake)
VARS="$(node "$REPO/scripts/msgr2-trial-guard.mjs" "${GUARD_ARGS[@]}")" || exit 5
eval "$VARS"
[ -f "$REPO/node_modules/next/dist/bin/next" ] || { echo "[msgr2-trial] 의존이 없습니다 — npm ci(또는 본 저장소 node_modules 링크)" >&2; exit 3; }
mkdir -p "$ROOT"; touch "$ROOT/.msgr2-trial"
echo "[msgr2-trial] 본체: http://127.0.0.1:$PORT (데이터 $ROOT, 서버 $([ "$FAKE" = 1 ] && echo '가짜 하네스' || echo 'qbwr'), 메신저 v2 연결 켜짐·옛 브리지 꺼짐)"
cd "$REPO"
exec env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-ko_KR.UTF-8}" \
  ARGO_ROOT="$ROOT" ARGO_AGENT_LINK=1 ARGO_MSGR_LEGACY=off NEXT_TELEMETRY_DISABLED=1 \
  NEXT_PUBLIC_SUPABASE_URL="$MSGR2_TRIAL_URL" NEXT_PUBLIC_SUPABASE_ANON_KEY="$MSGR2_TRIAL_ANON_KEY" \
  node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p "$PORT"
