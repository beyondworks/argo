#!/usr/bin/env bash
# Argo 서버 설치 — 리눅스(1차). 사용:
#   curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash              # 계정 모드(기본): argo 명령
#   curl -fsSL https://github.com/beyondworks/argo-agent/releases/latest/download/install.sh | bash -s -- --local # 로컬 웹 서버(로그인 없음)
# 계정 모드(2026-09-30 유건 결정 — 새 설치의 기본): 최신 타르볼 설치 → ~/.local/bin/argo 등록 → 실행 확인. 이후 사용자가
#   `argo`로 로그인(같은 계정·같은 회사) → `argo service install`로 24시간 상주(메신저·루틴 실행 담당).
# 로컬 모드(--local, 또는 이미 로컬 웹 서버를 설치해 쓰던 서버의 업데이트): 아래 종전 흐름 그대로 —
#   systemd user 서비스(항상 재시작) → 127.0.0.1:3001 기동 → 신원 검증. 로컬 설치에는 argo 명령을 등록하지 않는다
#   (CLI가 계정 로그인을 하면 같은 데이터 폴더의 로컬 서버가 그 세션을 동기화에 함께 써 세션이 폐기될 수 있다).
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
LOCAL=0
for arg in "$@"; do case "$arg" in --local) LOCAL=1 ;; *) printf '[argo] 모르는 옵션: %s (--local만 있습니다)\n' "$arg" >&2; exit 1 ;; esac; done

say() { printf '\033[1m[argo]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[argo] %s\033[0m\n' "$*" >&2; exit 1; }

# ─── 맥: argo 명령 단독 설치(2026-10-06 유건 승인) — 앱 없이 터미널에서. node를 담은 자산(scripts/stage-cli-dist.mjs)을 해시 확인 뒤
#     ~/.argo-selfhost/app에 두고 ~/.local/bin/argo를 만든다. 데이터는 리눅스 계정 모드와 같이 ~/.argo(앱 폴더와 따로, 동기화 켜짐).
#     데스크톱 앱이 설치돼 있으면 설치하지 않는다 — 앱이 같은 argo 명령을 등록하고, CLI가 둘이면 데이터 폴더가 갈린다.
#     PATH는 고치지 않고 넣을 줄만 안내한다(앱·리눅스와 같은 규칙). 업데이트 = 다시 실행, 제거 = argo uninstall(데이터는 남는다).
install_macos() {
  [ "$LOCAL" = 0 ] || die "맥에서는 --local(로컬 웹 서버)을 지원하지 않습니다 — 데스크톱 앱(dmg)을 쓰세요"
  local arch plat app_dirs d app found_app shim_dir shim in_path skip run_cmd found url sum want got status=0 svc_label svc_plist svc_on=0
  arch=$(uname -m)
  # Rosetta로 실행된 셸은 x86_64로 보인다 — 칩이 Apple Silicon이면 arm64 자산을 쓴다
  if [ "$arch" = x86_64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
  case "$arch" in arm64) plat=macos-arm64 ;; x86_64) plat=macos-x64 ;; *) die "미지원 아키텍처: $arch" ;; esac
  command -v curl >/dev/null || die "curl이 필요합니다"
  command -v tar >/dev/null || die "tar가 필요합니다"
  app_dirs="${ARGO_MAC_APP_DIRS:-/Applications:$HOME/Applications}"
  IFS=: read -r -a dirs <<<"$app_dirs"
  # 이름이 바뀐 사본(argo 2.app 등)도 잡게 번들 id로 본다(검수 #843 L2). 메신저 앱은 id가 달라 해당하지 않는다.
  for d in "${dirs[@]}"; do
    for app in "$d"/*.app; do
      [ -d "$app" ] || continue
      case "$(basename "$app")" in argo.app|Argo.app|ARGO.app) found_app="$app" ;; *) found_app='' ;; esac
      if [ -n "$found_app" ] || grep -q '<string>com\.beyondworks\.argo</string>' "$app/Contents/Info.plist" 2>/dev/null; then
        die "Argo 데스크톱 앱이 설치돼 있습니다($app) — argo 명령은 앱 설정 → 기기·데이터에서 등록하세요(앱과 같은 데이터를 씁니다)"
      fi
    done
  done
  shim_dir="$HOME/.local/bin"; shim="$shim_dir/argo"
  if head -c 512 "$shim" 2>/dev/null | grep -q 'argo-cli-shim v1 com.beyondworks.argo'; then
    die "Argo 데스크톱 앱이 등록한 argo 명령이 있습니다($shim) — 앱의 argo를 그대로 쓰세요"
  fi

  say "최신 릴리스 확인 중…"
  url=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o "\"browser_download_url\": *\"[^\"]*argo-cli-[^\"]*-$plat\.tar\.gz\"" \
    | head -1 | sed 's/.*"\(https[^"]*\)"/\1/' || true)
  [ -n "$url" ] || die "최신 릴리스에 맥용 argo 명령($plat)이 없습니다 — 잠시 뒤 다시 시도하거나 데스크톱 앱을 쓰세요"
  say "다운로드: $url"
  mkdir -p "$BASE_DIR"; chmod 700 "$BASE_DIR"
  TMP=$(mktemp -d "$BASE_DIR/.install.XXXXXX")
  HAD_APP=0; [ ! -d "$APP_DIR" ] || HAD_APP=1
  CHANGED=0; SUCCESS=0
  # argo service install(launchd) 상주 — 교체 동안 멈추고 끝나면 다시 시작한다(리눅스 argo-cli.service와 같은 규칙, 검수 #843 M4).
  # 실행 중인 상주가 바뀌는 폴더에서 새·옛 모듈을 섞어 읽지 않게. 상주는 같은 경로(~/.argo-selfhost/app/node)를 가리키므로 plist는 그대로 둔다.
  svc_label=com.beyondworks.argo-cli; svc_plist="$HOME/Library/LaunchAgents/$svc_label.plist"
  if [ -f "$svc_plist" ] && launchctl print "gui/$(id -u)/$svc_label" >/dev/null 2>&1; then svc_on=1; fi
  mac_cleanup() {
    status=$?
    trap - EXIT
    if [ "$CHANGED" = 1 ] && [ "$SUCCESS" = 0 ]; then
      say "새 설치 확인 실패 — 이전 설치를 복구합니다"
      if [ -d "$TMP/previous-app" ] || [ "$HAD_APP" = 0 ]; then # 이전 앱을 옮겨 둔 뒤에만 지금 폴더를 치운다(리눅스와 같은 안전 조건)
        if [ -d "$APP_DIR" ]; then mv "$APP_DIR" "$TMP/failed-app"; fi
        if [ "$HAD_APP" = 1 ]; then mv "$TMP/previous-app" "$APP_DIR"; fi
      fi
      if [ "$svc_on" = 1 ]; then launchctl bootstrap "gui/$(id -u)" "$svc_plist" >/dev/null 2>&1 || say "상주 argo를 다시 시작하지 못했습니다 — argo service install로 다시 등록하세요"; fi
      say "복구 자료: $TMP"
    else
      rm -rf "$TMP"
    fi
    exit "$status"
  }
  trap mac_cleanup EXIT
  curl -fsSL "$url" -o "$TMP/cli.tar.gz"
  curl -fsSL "$url.sha256" -o "$TMP/cli.sha256" || die "해시 파일(.sha256)을 받지 못해 설치하지 않습니다"
  want=$(awk '{print $1; exit}' "$TMP/cli.sha256")
  if command -v shasum >/dev/null; then got=$(shasum -a 256 "$TMP/cli.tar.gz" | awk '{print $1}'); else got=$(sha256sum "$TMP/cli.tar.gz" | awk '{print $1}'); fi
  [ -n "$want" ] && [ "$want" = "$got" ] || die "내려받은 파일의 해시가 맞지 않아 설치하지 않습니다(기대 ${want:-없음}, 실제 $got)"
  tar -xzf "$TMP/cli.tar.gz" -C "$TMP"
  CANDIDATE="$TMP/argo-cli"
  [ -x "$CANDIDATE/node" ] && [ -f "$CANDIDATE/bin/argo.mjs" ] || die "자산 구조가 예상과 다릅니다(argo-cli/node·bin/argo.mjs 부재)"
  EXPECTED_VERSION=$("$CANDIDATE/node" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1])).version||"")' "$CANDIDATE/package.json")
  # 크루가 답하는 중이면 교체하지 않는다(리눅스 계정 모드와 같은 규칙)
  "$CANDIDATE/node" - "${ARGO_CLI_HOME:-$HOME/.argo}/cli-workspaces" <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
for (const company of entries(root).filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
  for (const file of entries(path.join(root, company.name, 'chats')).filter(e => e.isFile() && e.name.endsWith('.status.json'))) {
    try { const s = JSON.parse(fs.readFileSync(path.join(root, company.name, 'chats', file.name), 'utf8')); if (s.ts && Date.now() - s.ts < 120000) { console.error('[argo] 크루가 답하는 중입니다 — 끝난 뒤 다시 설치하세요'); process.exit(1); } } catch { /* 잔재 */ }
  }
}
NODE
  if [ "$svc_on" = 1 ]; then launchctl bootout "gui/$(id -u)/$svc_label" >/dev/null 2>&1 || die "상주 argo를 멈추지 못해 교체하지 않습니다 — argo service status로 확인하세요"; fi
  CHANGED=1
  if [ "$HAD_APP" = 1 ]; then mv "$APP_DIR" "$TMP/previous-app"; fi
  mv "$CANDIDATE" "$APP_DIR"
  ARGO_CLI_APP=0 "$APP_DIR/node" "$APP_DIR/bin/argo.mjs" status >/dev/null 2>"$TMP/argo-status.err" || { cat "$TMP/argo-status.err" >&2; die "argo 명령 실행 확인 실패 — 이전 설치로 복구합니다"; }
  # argo 명령 등록 — 리눅스 계정 모드와 같은 규칙(표식 있는 우리 파일만 갱신, 남의 argo는 덮지도 가리지도 않는다)
  ours() { head -c 512 "$1" 2>/dev/null | grep -q 'argo-cli-shim'; }
  shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  in_path=''; skip=''
  while IFS= read -r found; do ours "$found" || { in_path="$found"; break; }; done < <(type -aP argo || true)
  if [ -e "$shim" ] || [ -L "$shim" ]; then ours "$shim" || skip="$shim"; else skip="$in_path"; fi
  run_cmd="ARGO_CLI_APP=0 $(shq "$APP_DIR/node") $(shq "$APP_DIR/bin/argo.mjs")"
  if [ -z "$skip" ]; then
    mkdir -p "$shim_dir"
    { printf '#!/bin/sh\n# argo-cli-shim v1 argo-selfhost — Argo 설치 스크립트(install.sh)가 만든 파일입니다. 다시 설치하면 갱신되고, argo uninstall로 지웁니다.\n'
      printf 'N=%s; C=%s\n' "$(shq "$APP_DIR/node")" "$(shq "$APP_DIR/bin/argo.mjs")"
      cat <<'SHIM'
[ -x "$N" ] && [ -f "$C" ] || { echo "argo: Argo 설치를 찾을 수 없습니다 — 설치 명령을 다시 실행하세요 / Argo install not found — run the install command again" >&2; exit 127; }
ARGO_CLI_APP=0 exec "$N" "$C" "$@"
SHIM
    } > "$shim.tmp.$$"
    chmod 755 "$shim.tmp.$$"; mv -f "$shim.tmp.$$" "$shim"
    run_cmd=argo
  fi
  # argo uninstall이 지울 대상 — 이 설치가 만든 것만(데이터는 적지 않는다)
  printf '{"kind":"standalone","platform":"%s","shim":%s}\n' "$plat" "$([ -z "$skip" ] && "$APP_DIR/node" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$shim" || echo null)" > "$APP_DIR/.argo-install.json"
  SUCCESS=1
  if [ "$svc_on" = 1 ]; then # 설치는 끝났다 — 시작 실패는 안내만(리눅스와 같음)
    if launchctl bootstrap "gui/$(id -u)" "$svc_plist" >/dev/null 2>&1; then say "상주 중인 argo를 새 버전으로 다시 시작했습니다"
    else say "상주 argo를 다시 시작하지 못했습니다 — argo service install로 다시 등록하세요(로그: ~/Library/Logs/argo-cli.log)"; fi
  fi
  say "설치 완료 — argo 명령 (버전: $EXPECTED_VERSION)"
  if [ -n "$skip" ]; then
    say "다른 프로그램의 argo 명령이 있어 argo 명령을 등록하지 않았습니다(그 파일은 그대로 둡니다): $skip"
    say "Argo는 이렇게 실행합니다: $run_cmd"
  else
    [ -z "$in_path" ] || say "PATH에 다른 프로그램의 argo도 있습니다: $in_path — PATH에서 먼저 나오는 쪽이 실행됩니다"
    case ":$PATH:" in *":$shim_dir:"*) ;; *)
      case "${SHELL:-}" in */bash) rc='~/.bash_profile' ;; *) rc='~/.zprofile' ;; esac
      say "PATH에 $shim_dir 이 없습니다 — $rc 에 이 줄을 추가한 뒤 터미널을 다시 여세요: export PATH=\"\$PATH:\$HOME/.local/bin\"" ;;
    esac
  fi
  say "다음: $run_cmd  (로그인 — 브라우저가 열립니다)"
  say "업데이트: 설치 명령을 다시 실행   제거: argo uninstall (데이터 ~/.argo는 남습니다)"
}
if [ "$(uname -s)" = Darwin ]; then install_macos; exit 0; fi

# 0) 플랫폼·의존성
[ "$(uname -s)" = "Linux" ] || die "이 스크립트는 리눅스·맥용입니다. 윈도우는 PowerShell에서: irm https://github.com/$REPO/releases/latest/download/install.ps1 | iex"
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
HAD_APP=0; HAD_UNIT=0; WAS_ACTIVE=0; WAS_ENABLED=0; CHANGED=0; SUCCESS=0; CLI_ACTIVE=0
[ ! -d "$APP_DIR" ] || HAD_APP=1
if [ -f "$UNIT" ]; then cp -p "$UNIT" "$TMP/argo.service.old"; HAD_UNIT=1; fi
systemctl --user is-active --quiet argo.service && WAS_ACTIVE=1
systemctl --user is-enabled --quiet argo.service && WAS_ENABLED=1
# 이미 로컬 웹 서버를 쓰던 서버는 그대로 로컬로 업데이트한다 — 업데이트가 기존 사용 방식을 바꾸지 않게
if [ "$HAD_UNIT" = 1 ] && [ "$LOCAL" = 0 ]; then LOCAL=1; say "기존 로컬 웹 서버가 있어 로컬 모드로 업데이트합니다(argo 명령 계정 모드는 설치하지 않습니다)"; fi
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
    if [ "$CLI_ACTIVE" = 1 ]; then systemctl --user start argo-cli.service || true; fi # 계정 모드 교체 전에 멈춘 상주 argo를 이전 앱으로 되살린다
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
# ─── 계정 모드 — argo 명령만 설치(웹 서버 서비스 없음). 실패하면 아래 cleanup이 이전 앱을 복구한다. ───
if [ "$LOCAL" = 0 ]; then
  [ "$NODE_MAJOR" -ge 22 ] || die "argo 명령은 Node.js 22 이상이 필요합니다(기억 색인이 내장 SQLite를 쓴다) — 현재: $(node -v)"
  [ -f "$CANDIDATE/bin/argo.mjs" ] || die "타르볼에 argo 명령이 없습니다(argo-server/bin/argo.mjs 부재) — 이 릴리스는 --local로만 설치할 수 있습니다"
  systemctl --user is-active --quiet argo-cli.service && CLI_ACTIVE=1
  # 상주 중인 CLI가 답하는 중이면 교체하지 않는다(로컬 흐름과 같은 규칙 — 실행 중 턴을 죽이지 않는다)
  node - "${ARGO_CLI_HOME:-$HOME/.argo}/cli-workspaces" <<'NODE'
const fs = require('fs'), path = require('path');
const root = process.argv[2];
const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
for (const company of entries(root).filter(e => e.isDirectory() && !e.name.startsWith('.'))) {
  for (const file of entries(path.join(root, company.name, 'chats')).filter(e => e.isFile() && e.name.endsWith('.status.json'))) {
    try { const s = JSON.parse(fs.readFileSync(path.join(root, company.name, 'chats', file.name), 'utf8')); if (s.ts && Date.now() - s.ts < 120000) { console.error('[argo] 크루가 답하는 중입니다 — 끝난 뒤 다시 설치하세요'); process.exit(1); } } catch { /* 잔재 */ }
  }
}
NODE
  # 교체 전에 멈춘다 — 실행 중인 argo가 바뀌는 중인 앱 폴더에서 새·옛 모듈을 섞어 읽지 않게(#773 검수 L1). 실패하면 cleanup이 다시 시작한다.
  if [ "$CLI_ACTIVE" = 1 ]; then systemctl --user stop argo-cli.service || { systemctl --user start argo-cli.service || true; die "상주 argo를 멈추지 못해 교체하지 않습니다 — journalctl --user -u argo-cli"; }; fi
  CHANGED=1
  if [ "$HAD_APP" = 1 ]; then mv "$APP_DIR" "$TMP/previous-app"; fi
  mv "$CANDIDATE" "$APP_DIR"
  node "$APP_DIR/bin/argo.mjs" status >/dev/null 2>"$TMP/argo-status.err" || { cat "$TMP/argo-status.err" >&2; die "argo 명령 실행 확인 실패 — 이전 설치로 복구합니다"; }
  # argo 명령 등록 — 표식(argo-cli-shim)이 있는 우리 파일만 만들고 갱신한다. 다른 프로그램의 argo(예: Argo Workflows CLI)가
  # 이 자리에 있으면 덮어쓰지 않고, PATH에 있으면 새로 만들어 가리지 않는다 — 건너뛰고 직접 실행하는 방법을 안내한다(검수 M1).
  SHIM_DIR="$HOME/.local/bin"; SHIM="$SHIM_DIR/argo"; NODE_BIN=$(command -v node)
  ours() { head -c 512 "$1" 2>/dev/null | grep -q 'argo-cli-shim'; }
  shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; } # sh 작은따옴표 인용 — 경로의 " \$ \` 공백이 그대로 남는다(검수 L3)
  IN_PATH=''; SKIP=''
  while IFS= read -r found; do ours "$found" || { IN_PATH="$found"; break; }; done < <(type -aP argo || true)
  if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then ours "$SHIM" || SKIP="$SHIM"; else SKIP="$IN_PATH"; fi
  RUN_CMD="$(shq "$NODE_BIN") $(shq "$APP_DIR/bin/argo.mjs")"
  if [ -z "$SKIP" ]; then
    mkdir -p "$SHIM_DIR"
    # 설치 때 확인한 node(22+)를 먼저 쓰고, 그 node가 없어지면(nvm 버전 삭제 등) PATH의 node로 실행한다(검수 L3)
    { printf '#!/bin/sh\n# argo-cli-shim v1 argo-selfhost — Argo 설치 스크립트(install.sh)가 만든 파일입니다. 다시 설치하면 갱신되고, 지워도 됩니다.\n'
      printf 'N=%s; C=%s\n' "$(shq "$NODE_BIN")" "$(shq "$APP_DIR/bin/argo.mjs")"
      cat <<'SHIM'
[ -x "$N" ] || N=$(command -v node) || { echo "argo: Node.js를 찾을 수 없습니다 — Node.js 22 이상을 설치하세요 / Node.js not found — install Node.js 22+" >&2; exit 127; }
[ -f "$C" ] || { echo "argo: Argo 설치를 찾을 수 없습니다 — install.sh를 다시 실행하세요 / Argo install not found — run install.sh again: $C" >&2; exit 127; }
exec "$N" "$C" "$@"
SHIM
    } > "$SHIM.tmp.$$"
    chmod 755 "$SHIM.tmp.$$"; mv -f "$SHIM.tmp.$$" "$SHIM" # 통째로 바꾼다 — 실행을 시작하는 argo가 반쯤 쓴 파일을 읽지 않게
    RUN_CMD=argo
  fi
  printf '{"kind":"standalone","platform":"%s","shim":%s}\n' "$PLAT" "$([ -z "$SKIP" ] && node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$SHIM" || echo null)" > "$APP_DIR/.argo-install.json" # argo uninstall이 지울 대상
  SUCCESS=1
  # 설치는 이미 끝났다 — 시작 실패로 스크립트를 끝내면 cleanup이 백업만 지운 채 오류로 남는다(#773 검수 L3). 안내하고 넘어간다.
  if [ "$CLI_ACTIVE" = 1 ]; then
    if systemctl --user start argo-cli.service; then say "상주 중인 argo를 새 버전으로 다시 시작했습니다"
    else say "상주 argo를 다시 시작하지 못했습니다 — 원인: journalctl --user -u argo-cli   다시 시작: systemctl --user start argo-cli.service"; fi
  fi
  say "설치 완료 — argo 명령 (버전: $EXPECTED_VERSION)"
  if [ -n "$SKIP" ]; then
    say "다른 프로그램의 argo 명령이 있어 argo 명령을 등록하지 않았습니다(그 파일은 그대로 둡니다): $SKIP"
    say "Argo는 이렇게 실행합니다: $RUN_CMD   (자주 쓰면 다른 이름으로 alias를 만들어 두세요)"
  else
    [ -z "$IN_PATH" ] || say "PATH에 다른 프로그램의 argo도 있습니다: $IN_PATH — PATH에서 먼저 나오는 쪽이 실행됩니다"
    case ":$PATH:" in *":$SHIM_DIR:"*) ;; *) say "PATH에 $SHIM_DIR 이 없습니다 — ~/.bashrc 등에 추가하세요: export PATH=\"\$PATH:\$HOME/.local/bin\"" ;; esac
  fi
  say "다음: $RUN_CMD  (로그인 — 서버에 브라우저가 없으면 안내에 나오는 ssh -L 명령을 내 PC에서 먼저 실행)"
  say "그다음: $RUN_CMD service install  (재부팅에도 켜져 메신저·예약 작업에 크루가 답합니다)"
  say "로그인 없는 로컬 웹 서버가 필요하면: 이 스크립트를 --local로 실행"
  exit 0
fi

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
