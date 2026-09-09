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
WORKSPACE_DIR="$DATA_DIR/workspaces"

say() { printf '\033[1m[argo]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[argo] %s\033[0m\n' "$*" >&2; exit 1; }

# 0) 플랫폼·의존성
[ "$(uname -s)" = "Linux" ] || die "1차 지원은 리눅스입니다. 맥은 데스크톱 앱(dmg)을, 윈도는 후속 지원을 이용해 주세요."
# arm64는 CI가 아직 안 만든다(2차 예정) — 광고하면 조용한 404가 되므로 정직하게 거절(검수 MEDIUM)
ARCH=$(uname -m); case "$ARCH" in x86_64) PLAT="linux-x64" ;; aarch64) die "arm64는 후속 지원 예정입니다 — 현재 x86_64만 지원합니다" ;; *) die "미지원 아키텍처: $ARCH" ;; esac
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
  | head -1 | sed 's/.*"\(https[^"]*\)"/\1/' || true)
# ⚠ || true — grep 무매칭이 pipefail로 대입 자체를 죽이면 아래 안내가 영영 안 나온다(검수 MEDIUM 실증)
[ -n "$TARBALL_URL" ] || die "최신 릴리스에 $PLAT 서버 타르볼이 없습니다 — 릴리스 자산을 확인해 주세요"
say "다운로드: $TARBALL_URL"

# 2) 같은 파일시스템에서 준비 — 건강 검사가 끝날 때까지 이전 앱·unit 보존.
mkdir -p "$BASE_DIR" "$DATA_DIR"
chmod 700 "$BASE_DIR"
TMP=$(mktemp -d "$BASE_DIR/.install.XXXXXX")
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/argo.service"
HAD_APP=0; HAD_UNIT=0; WAS_ACTIVE=0; WAS_ENABLED=0; CHANGED=0; SUCCESS=0
[ ! -d "$APP_DIR" ] || HAD_APP=1
if [ -f "$UNIT" ]; then cp -p "$UNIT" "$TMP/argo.service.old"; HAD_UNIT=1; fi
systemctl --user is-active --quiet argo.service && WAS_ACTIVE=1
systemctl --user is-enabled --quiet argo.service && WAS_ENABLED=1
health() {
  curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{try{const p=JSON.parse(s);process.exit(p.argo===true&&p.version===process.argv[1]&&p.buildId===process.argv[2]?0:1)}catch{process.exit(1)}})' "$1" "$2"
}
OLD_VERSION=''; OLD_BUILD=''
cleanup() {
  status=$?
  trap - EXIT
  if [ "$CHANGED" = 1 ] && [ "$SUCCESS" = 0 ]; then
    say "새 서버 검증 실패 — 이전 설치를 복구합니다"
    systemctl --user stop argo.service || true
    if [ -d "$TMP/previous-app" ] || [ "$HAD_APP" = 0 ]; then
      if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$TMP/failed-app"; fi
      if [ "$HAD_APP" = 1 ]; then mv "$TMP/previous-app" "$APP_DIR"; fi
    fi
    if [ "$HAD_UNIT" = 1 ]; then cp -p "$TMP/argo.service.old" "$UNIT"; else rm -f "$UNIT"; fi
    if [ "$WAS_ENABLED" = 0 ]; then systemctl --user disable argo.service >/dev/null 2>&1 || true; fi
    systemctl --user daemon-reload || true
    if [ "$WAS_ACTIVE" = 1 ]; then
      systemctl --user start argo.service || true
      restored=0
      for i in $(seq 1 20); do
        if health "$OLD_VERSION" "$OLD_BUILD"; then restored=1; break; fi
        sleep 1
      done
      if [ "$restored" = 0 ]; then say "이전 서버도 응답하지 않습니다 — 보존된 복구 자료와 서비스 로그를 확인하세요"; fi
    fi
    # 실패 후보와 백업을 진단용으로 보존한다. 사용자 데이터는 교체하지 않는다.
    say "복구 자료: $TMP"
  else
    rm -rf "$TMP"
  fi
  exit "$status"
}
trap cleanup EXIT
if [ "$HAD_APP" = 1 ]; then
  OLD_VERSION=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version)' "$APP_DIR/package.json")
  OLD_BUILD=$(cat "$APP_DIR/.next/BUILD_ID")
fi
curl -fsSL "$TARBALL_URL" -o "$TMP/server.tar.gz"
tar -xzf "$TMP/server.tar.gz" -C "$TMP"
CANDIDATE="$TMP/argo-server"
[ -f "$CANDIDATE/server.js" ] || die "타르볼 구조가 예상과 다릅니다(argo-server/server.js 부재)"
EXPECTED_VERSION=$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));if(!p.version)process.exit(1);process.stdout.write(p.version)' "$CANDIDATE/package.json")
EXPECTED_BUILD=$(cat "$CANDIDATE/.next/BUILD_ID")
[ -n "$EXPECTED_BUILD" ] || die "타르볼에 BUILD_ID가 없습니다"
# 로컬 런타임 설정은 그대로 복사하며 값은 출력하지 않는다.
for name in .env .env.local .env.production .env.production.local; do
  if [ -f "$APP_DIR/$name" ]; then cp -p "$APP_DIR/$name" "$CANDIDATE/$name"; fi
done

# 3) 기존 unit의 추가 설정 보존. 관리 대상 바인딩·경로를 바꾼 unit은 자동 덮어쓰지 않는다.
mkdir -p "$UNIT_DIR"
if [ "$HAD_UNIT" = 1 ]; then
  # 기본 설치의 포트·데이터 루트를 유지한다(환경값 자체는 출력하지 않음).
  PORT=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=[...s.matchAll(/^Environment=PORT=(\d+)$/gm)].at(-1);if(!m)process.exit(1);process.stdout.write(m[1])' "$UNIT")
  grep -Fxq "WorkingDirectory=$APP_DIR" "$UNIT" || die "사용자 지정 서비스 경로입니다 — 기존 unit을 보존하고 중단합니다"
  grep -Fxq 'Environment=HOSTNAME=127.0.0.1' "$UNIT" || die "루프백 전용 서비스가 아닙니다 — 기존 unit을 보존하고 중단합니다"
  WORKSPACE_DIR=$(node -e 'const s=require("fs").readFileSync(process.argv[1],"utf8");const m=[...s.matchAll(/^Environment=ARGO_ROOT=(.+)$/gm)].at(-1);if(!m||!require("path").isAbsolute(m[1]))process.exit(1);process.stdout.write(m[1])' "$UNIT")
  node - "$UNIT" "$TMP/argo.service.new" "$APP_DIR" <<'NODE'
const fs = require('fs');
const old = fs.readFileSync(process.argv[2], 'utf8');
const bind = [...old.matchAll(/^Environment=HOSTNAME=(.+)$/gm)].at(-1)?.[1];
if (bind !== '127.0.0.1' || !old.match(/^ExecStart=(.+)$/m)?.[1].endsWith(` ${process.argv[4]}/server.js`)) throw new Error('사용자 지정 서비스 실행 설정입니다 — 기존 unit을 보존하고 중단합니다');
for (const [, value] of old.matchAll(/^EnvironmentFile=(.+)$/gm)) {
  const optional = value.startsWith('-'), file = (optional ? value.slice(1) : value).replace(/^"(.*)"$/, '$1');
  if (!file.startsWith('/') || /[%*?\\]/.test(file)) throw new Error('사용자 지정 환경 파일 경로입니다 — 기존 unit을 보존하고 중단합니다');
  if (optional && !fs.existsSync(file)) continue;
  if (/\b(?:ARGO_ROOT|CREWBASE_ROOT|HOSTNAME|PORT)\b/.test(fs.readFileSync(file, 'utf8'))) throw new Error('환경 파일의 바인딩/데이터 설정은 자동 갱신할 수 없습니다 — 기존 unit을 보존하고 중단합니다');
}
const proof = 'Environment=ARGO_LOCAL_BIND_PROOF=127.0.0.1';
fs.writeFileSync(process.argv[3], /^Environment=ARGO_LOCAL_BIND_PROOF=.*$/m.test(old)
  ? old.replace(/^Environment=ARGO_LOCAL_BIND_PROOF=.*$/gm, proof) : `${old}\n[Service]\n${proof}\n`);
NODE
else
  cat > "$TMP/argo.service.new" <<EOF
[Unit]
Description=Argo self-host server
After=network.target

[Service]
ExecStart=$(command -v node) $APP_DIR/server.js
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOSTNAME=127.0.0.1
Environment=ARGO_LOCAL_BIND_PROOF=127.0.0.1
Environment=NODE_ENV=production
Environment=ARGO_ROOT=$DATA_DIR/workspaces
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
fi
# 장시간 도구 호출도 30초마다 ts를 갱신한다(turn-status.mjs). 진행 중/대기 중에는 교체하지 않는다.
node - "$WORKSPACE_DIR" <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
let busy = false;
for (const company of entries(root).filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
  const base = path.join(root, company.name);
  for (const file of entries(path.join(base, 'chats')).filter(e => e.isFile() && e.name.endsWith('.status.json'))) {
    const full = path.join(base, 'chats', file.name);
    try { const s = JSON.parse(fs.readFileSync(full, 'utf8')); if (s.ts && Date.now() - s.ts < 120000) busy = true; }
    catch (e) { if (e.code !== 'ENOENT') busy = true; }
  }
  for (const queue of entries(base).filter(e => e.isDirectory() && e.name.startsWith('.gw-queue'))) {
    if (entries(path.join(base, queue.name)).some(e => e.isFile())) busy = true;
  }
}
if (busy) { console.error('[argo] 실행 중이거나 대기 중인 작업이 있습니다 — 작업 종료 후 다시 설치하세요'); process.exit(1); }
NODE
# enable --now는 실행 중인 서비스를 재시작하지 않는다. 교체 전에 명시적으로 멈춘다.
CHANGED=1
if [ "$WAS_ACTIVE" = 1 ]; then systemctl --user stop argo.service; fi
if [ "$HAD_APP" = 1 ]; then mv "$APP_DIR" "$TMP/previous-app"; fi
mv "$CANDIDATE" "$APP_DIR"
cp "$TMP/argo.service.new" "$UNIT"
systemctl --user daemon-reload
systemctl --user enable argo.service
systemctl --user start argo.service

# 4) 다른 Argo 프로세스/옛 빌드의 응답을 성공으로 인정하지 않는다.
say "기동 검증 중…"
for i in $(seq 1 20); do
  if health "$EXPECTED_VERSION" "$EXPECTED_BUILD"; then
    SUCCESS=1
    ME=$(id -un)
    loginctl enable-linger "$ME" 2>/dev/null || say "linger 설정 실패 — 로그아웃 중에도 돌리려면 sudo loginctl enable-linger $ME"
    say "설치 완료 — http://127.0.0.1:$PORT (버전: $EXPECTED_VERSION)"
    say "원격에서 쓰려면: ssh -L $PORT:127.0.0.1:$PORT $ME@이서버"
    say "업데이트: 이 스크립트 재실행. 로그: journalctl --user -u argo -f"
    exit 0
  fi
  sleep 1
done
die "새 서버의 버전·빌드가 확인되지 않아 이전 설치로 복구합니다"
