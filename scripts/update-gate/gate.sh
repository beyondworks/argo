#!/bin/bash
# 업데이트 경로 관문(발행 전) — 지금 공개된 버전을 깨끗한 맥 러너의 /Applications에 깔고, 앱 안 업데이트로 아직 공개하지 않은 새 빌드를 받아
# 재시작까지 되는지, 재시작한 새 버전이 화면을 띄우고 이전 데이터(본체: 회사)를 그대로 보이는지 확인한다.
# 2026-10-04 유건 지시: "업데이트는 버그를 고치거나 기능 개선을 위한 것 — 그 과정에서 또 다른 오류가 발생하면 안 된다."
#
# 옛 앱의 업데이트 주소(github.com/<repo>/releases/latest/download/latest.json)는 바꿀 수 없으므로 이 러너 안에서만 github.com을
# 로컬 HTTPS 서버(serve.py)로 돌린다. 업데이터(reqwest 0.13 + rustls-platform-verifier)는 macOS 신뢰 설정을 따르므로 임시 인증 기관을 신뢰 등록한다.
# latest.json은 새 빌드의 .sig로 여기서 만든다 — 발행용 latest.json 자체의 정합은 발행 드릴(release-assets.mjs·verify-updater.mjs)이 따로 확인한다.
#
# env: APP(argo|messenger) ARCH(aarch64-apple-darwin|x86_64-apple-darwin) PLATFORM(darwin-aarch64|darwin-x86_64)
#      NEW(새 빌드 산출물 폴더, 기본 ./new) OUT(증거 폴더, 기본 ./out)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$PWD/out}"; NEW="${NEW:-$PWD/new}"; mkdir -p "$OUT"
W="${RUNNER_TEMP:-/tmp}/update-gate"; rm -rf "$W"; mkdir -p "$W"
note() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
verdict() { note "$1: $2"; echo "$1 $2" > "$OUT/RESULT"; }
ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo '?'; }
newer() { python3 -c 'import sys; a, b = [tuple(int(x) for x in v.split(".")) for v in sys.argv[1:3]]; sys.exit(0 if a > b else 1)' "$1" "$2"; }
AX() { osascript "$HERE/ax.applescript" "$@" 2>&1; }
found() { case "$(AX find "$@")" in FOUND*) return 0 ;; *) return 1 ;; esac; }
shot() { if screencapture -x "$OUT/$1.png" 2>>"$OUT/steps.log"; then note "shot $1"; else note "screencapture failed ($1)"; fi; }

case "${APP:-}" in
  argo) REPO=beyondworks/argo-agent; NAME=argo.app; EXE=app; PREFIX=argo; export AX_BUNDLE=com.beyondworks.argo
    case "$ARCH" in aarch64-*) PUB=argo-macos-apple-silicon.dmg ;; *) PUB=argo-macos-intel.dmg ;; esac ;;
  messenger) REPO=beyondworks/argo-messenger; NAME="Argo Messenger.app"; EXE=argo-messenger; PREFIX=argo-messenger; export AX_BUNDLE=com.beyondworks.argo.messenger
    case "$ARCH" in aarch64-*) PUB=argo-messenger-macos-apple-silicon.dmg ;; *) PUB=argo-messenger-macos-intel.dmg ;; esac ;;
  *) echo "APP must be argo or messenger"; exit 2 ;;
esac
procs() { ps -axo pid=,comm= | grep -E "Contents/MacOS/$EXE\$" || true; }
pidnow() { procs | awk '{print $1}' | head -1; }

SRV=""
cleanup() {
  [ -n "$SRV" ] && sudo kill "$SRV" 2>/dev/null
  if [ -f "$W/hosts.bak" ]; then sudo cp "$W/hosts.bak" /etc/hosts; sudo dscacheutil -flushcache; fi
  sudo security delete-certificate -c "Argo update gate CA" /Library/Keychains/System.keychain > /dev/null 2>&1 || true
}
trap cleanup EXIT

# ---------- 새 빌드와 공개 버전 ----------
TGZ="$NEW/$PREFIX-$ARCH.app.tar.gz"
if [ ! -s "$TGZ" ] || [ ! -s "$TGZ.sig" ]; then ls -la "$NEW" | tee -a "$OUT/steps.log"; verdict FAIL "new build artifact missing: $(basename "$TGZ") (+.sig)"; exit 1; fi
mkdir -p "$W/new-app" && tar -xzf "$TGZ" -C "$W/new-app"
NEWV="$(ver "$(ls -d "$W/new-app"/*.app | head -1)")"
# github.com을 돌리기 전에 받는다
PUBV="$(curl -fsSL "https://github.com/$REPO/releases/latest/download/latest.json" | python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])')"
curl -fsSL -o "$W/pub.dmg" "https://github.com/$REPO/releases/latest/download/$PUB" || { verdict FAIL "could not download the public $PUB"; exit 1; }
note "app=$APP arch=$ARCH macOS=$(sw_vers -productVersion) public=$PUBV new=$NEWV"
newer "$NEWV" "$PUBV" || { verdict FAIL "new build $NEWV is not newer than the public $PUBV — nothing to update"; exit 1; }

# ---------- github.com → 로컬 미러 ----------
WWW="$W/www"; REL="$WWW/$REPO/releases"
mkdir -p "$REL/latest/download" "$REL/download/v$NEWV"
cp "$TGZ" "$REL/download/v$NEWV/"
python3 - "$NEWV" "$PLATFORM" "https://github.com/$REPO/releases/download/v$NEWV/$(basename "$TGZ")" "$TGZ.sig" > "$REL/latest/download/latest.json" <<'PY'
import datetime, json, sys
version, platform, url, sig = sys.argv[1:]
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
print(json.dumps({'version': version, 'pub_date': now, 'platforms': {platform: {'url': url, 'signature': open(sig).read().strip()}}}))
PY
cp "$REL/latest/download/latest.json" "$OUT/latest.json"

cat > "$W/ca.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no
[dn]
CN = Argo update gate CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
CNF
printf 'subjectAltName=DNS:github.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' > "$W/leaf.ext"
{ openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -keyout "$W/ca.key" -out "$W/ca.crt" -config "$W/ca.cnf" \
  && openssl req -newkey rsa:2048 -nodes -sha256 -subj "/CN=github.com" -keyout "$W/leaf.key" -out "$W/leaf.csr" \
  && openssl x509 -req -sha256 -days 2 -in "$W/leaf.csr" -CA "$W/ca.crt" -CAkey "$W/ca.key" -CAcreateserial -extfile "$W/leaf.ext" -out "$W/leaf.crt"; } >> "$OUT/steps.log" 2>&1 \
  || { verdict FAIL "could not create the gate certificates"; exit 1; }
# 러너는 신뢰 설정 변경에 사용자 확인 창을 띄울 수 없다 — 이 일회용 VM에서만 확인 없이 허용
sudo security authorizationdb write com.apple.trust-settings.admin allow > /dev/null 2>&1 || true
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$W/ca.crt" >> "$OUT/steps.log" 2>&1 || { verdict FAIL "could not trust the gate CA"; exit 1; }
security verify-cert -c "$W/leaf.crt" -p ssl -s github.com >> "$OUT/steps.log" 2>&1 || { verdict FAIL "macOS does not trust the mirror certificate"; exit 1; }

sudo python3 "$HERE/serve.py" "$WWW" "$W/leaf.crt" "$W/leaf.key" "$OUT/server.log" > "$OUT/server.stderr" 2>&1 &
SRV=$!
sudo cp /etc/hosts "$W/hosts.bak"
printf '127.0.0.1 github.com\n::1 github.com\n' | sudo tee -a /etc/hosts > /dev/null
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder 2> /dev/null || true
sleep 3
if ! curl -fsS --cacert "$W/ca.crt" "https://github.com/$REPO/releases/latest/download/latest.json" | grep -q "\"$NEWV\""; then
  cat "$OUT/server.stderr" >> "$OUT/steps.log"; verdict FAIL "local mirror is not answering for github.com"; exit 1
fi
note "mirror ready: github.com/$REPO latest -> $NEWV"

# ---------- 공개 버전 설치·실행 ----------
hdiutil attach -nobrowse -mountpoint /Volumes/gate-dmg "$W/pub.dmg" > /dev/null || { verdict FAIL "dmg attach failed"; exit 1; }
ditto "$(ls -d /Volumes/gate-dmg/*.app | head -1)" "/Applications/$NAME"
hdiutil detach /Volumes/gate-dmg -quiet || true
APPP="/Applications/$NAME"; V0="$(ver "$APPP")"
note "installed $APPP version=$V0"
[ "$V0" = "$PUBV" ] || note "warning: public dmg is $V0 but latest.json says $PUBV"
open --stdout "$OUT/app.stdout" --stderr "$OUT/app.stderr" "$APPP" &
sleep 8

made=0
reach() {
  local i D
  for i in $(seq 1 90); do
    D="$(AX dump)"; printf '%s\n' "$D" > "$OUT/ui-last.txt"
    if [ "$APP" = argo ]; then
      # 업데이트 뒤에도 남아야 할 데이터(회사)를 먼저 만든다
      if [ "$made" = 1 ] && found Update 업데이트; then return 0; fi
      if printf '%s\n' "$D" | grep -qE 'Start local-only|로컬 전용으로 시작'; then note "login: $(AX clickc 'Start local-only' '로컬 전용으로 시작')"; sleep 6; continue; fi
      if printf '%s\n' "$D" | grep -qE 'Create company|회사 만들기'; then r="$(AX type 'Gate Co')"; note "home: $r"; [ "$r" = TYPED ] && made=1; sleep 10; continue; fi
    else
      found 'Install now' '지금 설치' && return 0
    fi
    [ $((i % 6)) -eq 0 ] && note "waiting for the update offer ($i): $(printf '%s\n' "$D" | head -1)"
    sleep 5
  done
  return 1
}
if ! reach; then shot 99-stuck; cp "$OUT/ui-last.txt" "$OUT/ui-stuck.txt"; verdict FAIL "the public $V0 never offered $NEWV"; exit 1; fi
P0="$(pidnow)"
note "update offered (pid $P0)"
shot 01-offered

# ---------- 업데이트 ----------
if [ "$APP" = argo ]; then note "press topbar update: $(AX click Update 업데이트)"; else note "press install: $(AX click 'Install now' '지금 설치')"; fi
result=timeout
for i in $(seq 1 120); do
  sleep 5
  NOW="$(ver "$APPP")"; PNOW="$(pidnow)"
  note "t=$((i * 5))s disk=$NOW pid=${PNOW:-none}"
  if [ "$APP" = messenger ]; then
    found Restart '다시 시작' && note "restart: $(AX click Restart '다시 시작')" # 메신저 upd.restart(ko '다시 시작')
    if AX dump | grep -qE 'Update failed|업데이트 실패'; then AX dump > "$OUT/ui-error.txt"; result=install-error; break; fi
  fi
  if [ "$NOW" = "$NEWV" ] && [ -n "$PNOW" ] && [ "$PNOW" != "$P0" ]; then result=relaunched; break; fi
done
shot 02-after-update
[ "$result" = relaunched ] || { AX dump > "$OUT/ui-after.txt"; verdict FAIL "update did not complete: result=$result disk=$(ver "$APPP")"; exit 1; }
P1="$(pidnow)"
note "relaunched as $NEWV (pid $P1)"

# ---------- 새 버전 화면·데이터 ----------
if [ "$APP" = argo ]; then mark='Gate Co'; else mark='Continue with Google|Google로 계속하기'; fi
seen=0
for i in $(seq 1 36); do sleep 5; if AX dump | grep -qE "$mark"; then seen=1; break; fi; done
sleep 20
AX dump > "$OUT/ui-new.txt"; shot 03-new-version
alive=0; [ "$(pidnow)" = "$P1" ] && alive=1
# 옛 앱의 업데이터(User-Agent tauri-plugin-updater/x.y.z)가 미러에서 latest.json과 새 묶음을 받았는가 — 자체 점검용 curl 요청은 세지 않는다
served=0; UPD="$(grep 'tauri-plugin-updater/' "$OUT/server.log")"
printf '%s\n' "$UPD" | grep -q 'latest.json HTTP/1.1" 200' && printf '%s\n' "$UPD" | grep -qF "$(basename "$TGZ") HTTP/1.1\" 200" && served=1
ls -t "$HOME/Library/Logs/DiagnosticReports" 2> /dev/null | head -20 > "$OUT/diagnostic-reports.txt"
note "screen=$seen alive=$alive served_from_mirror=$served"
if [ "$seen" = 1 ] && [ "$alive" = 1 ] && [ "$served" = 1 ]; then
  verdict PASS "$V0 -> $NEWV installed from the mirror, relaunched, screen and data ok"
else
  verdict FAIL "screen=$seen alive=$alive served_from_mirror=$served"
fi
cat "$OUT/RESULT"
grep -q '^PASS' "$OUT/RESULT"
