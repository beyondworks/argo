#!/usr/bin/env bash
# Argo 셀프호스트 설치 — 리눅스(1차). 사용:
#   curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash
# 하는 일: 최신 서버 타르볼 설치 → systemd user 서비스(항상 재시작) → 127.0.0.1:3001 기동 → 신원 검증.
# 보안 기본값(변경 금지 권장): 루프백 바인딩 + 로컬 모드(무인증 단일 사용자).
#   외부에서 쓰려면 SSH 터널: ssh -L 3001:127.0.0.1:3001 user@서버   (포트를 공개로 열지 말 것 —
#   무인증 공개 = 회사 전체 노출. 인증 모드 셀프호스트는 후속 문서 참조)
# 업데이트 = 이 스크립트 재실행(데이터·설정은 ~/.argo-selfhost/data 에 보존).
set -euo pipefail

REPO="beyondworks/argo-agent"
BASE_DIR="${ARGO_HOME:-$HOME/.argo-selfhost}"
APP_DIR="$BASE_DIR/app"
DATA_DIR="$BASE_DIR/data"
PORT="${ARGO_PORT:-3001}"

say() { printf '\033[1m[argo]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[argo] %s\033[0m\n' "$*" >&2; exit 1; }

# 0) 플랫폼·의존성
[ "$(uname -s)" = "Linux" ] || die "1차 지원은 리눅스입니다. 맥은 데스크톱 앱(dmg)을, 윈도는 후속 지원을 이용해 주세요."
ARCH=$(uname -m); case "$ARCH" in x86_64) PLAT="linux-x64" ;; aarch64) PLAT="linux-arm64" ;; *) die "미지원 아키텍처: $ARCH" ;; esac
command -v curl >/dev/null || die "curl이 필요합니다"
command -v tar >/dev/null || die "tar가 필요합니다"
command -v systemctl >/dev/null || die "systemd가 필요합니다(systemctl 부재)"
if ! command -v node >/dev/null; then
  die "Node.js 20+가 필요합니다. 설치 후 재실행: https://nodejs.org 또는 'sudo apt install nodejs' / nvm"
fi
NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20 이상이 필요합니다 (현재: $(node -v))"

# 1) 최신 서버 타르볼 URL 확인
say "최신 릴리스 확인 중…"
TARBALL_URL=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -o "\"browser_download_url\": *\"[^\"]*argo-server-[^\"]*-$PLAT\.tar\.gz\"" \
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$TARBALL_URL" ] || die "최신 릴리스에 $PLAT 서버 타르볼이 없습니다 — 릴리스 자산을 확인해 주세요"
say "다운로드: $TARBALL_URL"

# 2) 설치(원자적 교체 — 실패해도 기존 설치 보존)
mkdir -p "$BASE_DIR" "$DATA_DIR"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$TARBALL_URL" -o "$TMP/server.tar.gz"
tar -xzf "$TMP/server.tar.gz" -C "$TMP"
[ -f "$TMP/argo-server/server.js" ] || die "타르볼 구조가 예상과 다릅니다(argo-server/server.js 부재)"
rm -rf "$APP_DIR.new" && mv "$TMP/argo-server" "$APP_DIR.new"
if [ -d "$APP_DIR" ]; then rm -rf "$APP_DIR.old" && mv "$APP_DIR" "$APP_DIR.old"; fi
mv "$APP_DIR.new" "$APP_DIR" && rm -rf "$APP_DIR.old"

# 3) systemd user 서비스(배포 규칙: Restart=always + linger)
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/argo.service" <<EOF
[Unit]
Description=Argo self-host server
After=network.target

[Service]
ExecStart=$(command -v node) $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOSTNAME=127.0.0.1
Environment=NODE_ENV=production
Environment=ARGO_ROOT=$DATA_DIR/workspaces
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now argo.service
loginctl enable-linger "$USER" 2>/dev/null || say "linger 설정 실패(sudo 필요할 수 있음) — 로그아웃 시 서비스가 멈출 수 있습니다: sudo loginctl enable-linger $USER"

# 4) 검증(배포 규칙: 기동 후 엔드포인트 응답 확인) — /api/ping 신원 마커
say "기동 검증 중…"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/ping" 2>/dev/null | grep -q '"argo":true'; then
    say "설치 완료 — http://127.0.0.1:$PORT (버전: $(curl -fsS http://127.0.0.1:$PORT/api/ping | sed 's/.*version":"\([^"]*\)".*/\1/'))"
    say "원격에서 쓰려면(보안 기본): ssh -L $PORT:127.0.0.1:$PORT $USER@이서버"
    say "업데이트: 이 스크립트를 다시 실행하면 됩니다. 로그: journalctl --user -u argo -f"
    exit 0
  fi
  sleep 1
done
journalctl --user -u argo --no-pager -n 20 || true
die "서버가 ${PORT}에서 응답하지 않습니다 — 위 로그를 확인해 주세요"
