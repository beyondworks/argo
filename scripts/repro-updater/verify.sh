#!/bin/bash
# Verify the install-location fix (PR #823) on a clean macOS runner with a real, notarized build (test branch only; never merged).
# The build under test is bumped below the latest public release, so its updater offers the public version.
# usage: verify.sh <app: argo|msgr> <variant> <dmg>
#   applications  /Applications, owned by the runner user  -> the update installs and relaunches (no regression on the normal path)
#   dmg           straight from the mounted, quarantined dmg -> no install attempt, "move to Applications" guidance
#   external      a second APFS volume                       -> no install attempt, "move to Applications" guidance
#   rootowned     /Applications owned by root                -> install offered with the admin note; cancelling the prompt shows the reason
set -u
A="$1"; V="$2"; DMG="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$PWD/out}"; mkdir -p "$OUT"
T="$(getconf DARWIN_USER_TEMP_DIR)"
case "$A" in
  argo) export AX_BUNDLE=com.beyondworks.argo; NAME=argo.app; EXE=app ;;
  msgr) export AX_BUNDLE=com.beyondworks.argo.messenger; NAME="Argo Messenger.app"; EXE=argo-messenger ;;
  *) echo "unknown app $A"; exit 2 ;;
esac
AX() { osascript "$HERE/ax.applescript" "$@" 2>&1; }
note() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
shot() { if screencapture -x "$OUT/$1.png" 2>>"$OUT/steps.log"; then note "shot $1"; else note "screencapture failed ($1)"; fi; }
ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo '?'; }
procs() { ps -axo pid=,lstart=,comm= | grep -E "Contents/MacOS/$EXE\$" || true; }
pidnow() { procs | awk '{print $1}' | head -1; }
dump() { AX dump > "$OUT/ui-$1.txt"; cat "$OUT/ui-$1.txt"; }
found() { case "$(AX find "$@")" in FOUND*) return 0 ;; *) return 1 ;; esac; }
verdict() { note "$1: $2"; echo "$1 $2" > "$OUT/RESULT"; }

note "app=$A variant=$V dmg=$(basename "$DMG") arch=$(uname -m) macOS=$(sw_vers -productVersion) user=$(id -un)"
note "TMPDIR(user)=$T"

# ---------- install like the variant says (same as run.sh) ----------
[ "$V" = dmg ] && xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;" "$DMG"
hdiutil attach -nobrowse -mountpoint /Volumes/argo-dmg "$DMG" > /dev/null || { verdict FAIL "dmg attach failed"; exit 1; }
SRC="$(ls -d /Volumes/argo-dmg/*.app | head -1)"
note "dmg app: $SRC ($(ver "$SRC"))"
case "$V" in
  applications) ditto "$SRC" "/Applications/$NAME"; APP="/Applications/$NAME" ;;
  rootowned) ditto "$SRC" "/Applications/$NAME"; sudo chown -R root:wheel "/Applications/$NAME"; APP="/Applications/$NAME" ;;
  external)
    hdiutil create -quiet -size 3g -fs APFS -volname ArgoExt "$RUNNER_TEMP/ext.dmg"
    hdiutil attach -nobrowse -mountpoint /Volumes/ArgoExt "$RUNNER_TEMP/ext.dmg" > /dev/null
    mkdir -p /Volumes/ArgoExt/Applications
    ditto "$SRC" "/Volumes/ArgoExt/Applications/$NAME"; APP="/Volumes/ArgoExt/Applications/$NAME" ;;
  dmg) APP="$SRC" ;;
  *) verdict FAIL "unknown variant"; exit 1 ;;
esac
V0="$(ver "$APP")"
note "APP=$APP version=$V0"
ls -ld "$APP" | tee -a "$OUT/steps.log"

/usr/bin/log stream --style compact --predicate "process == \"$EXE\" OR process == \"CoreServicesUIAgent\" OR process == \"syspolicyd\"" > "$OUT/oslog.txt" 2>&1 &
LOGS=$!
open --stdout "$OUT/app.stdout" --stderr "$OUT/app.stderr" "$APP" &
sleep 5

# ---------- reach the screen that offers the update ----------
gk() { if [ "$V" = dmg ]; then g="$(AX gk-open)"; case "$g" in GK_OPENED*) note "$g"; sleep 3 ;; esac; fi; }
reach() {
  local i D
  for i in $(seq 1 90); do
    [ "$i" -le 24 ] && gk
    D="$(AX dump)"; printf '%s\n' "$D" > "$OUT/ui-last.txt"
    if [ "$A" = argo ]; then
      found Update 업데이트 && { note "topbar update button visible"; return 0; }
      if printf '%s\n' "$D" | grep -qE 'Start local-only|로컬 전용으로 시작'; then note "login: $(AX clickc 'Start local-only' '로컬 전용으로 시작')"; sleep 6; continue; fi
      if printf '%s\n' "$D" | grep -qE 'Create company|회사 만들기'; then note "home: $(AX type 'Verify Co')"; sleep 10; continue; fi
    else
      found 'Install now' '지금 설치' 'Latest installer' '최신 설치 파일' && { note "update bar visible"; return 0; }
    fi
    [ $((i % 6)) -eq 0 ] && note "waiting for UI ($i): $(printf '%s\n' "$D" | head -1)"
    sleep 5
  done
  return 1
}
if ! reach; then shot 99-stuck; procs | tee -a "$OUT/steps.log"; kill "$LOGS" 2>/dev/null; verdict FAIL "could not reach the update offer"; exit 1; fi
P0="$(pidnow)"
note "running pid=$P0"
shot 01-update-offered
dump 01 > /dev/null

sudo fs_usage -w -f filesys "$EXE" > "$OUT/fs_usage.raw" 2>&1 &
FSU=$!
sleep 3

# ---------- the check for this variant ----------
case "$A:$V" in
  argo:applications|msgr:applications)
    if [ "$A" = argo ]; then note "press topbar update: $(AX click Update 업데이트)"; else note "press install: $(AX click 'Install now' '지금 설치')"; fi
    result=timeout
    for i in $(seq 1 120); do
      sleep 5
      NOW="$(ver "$APP")"; PNOW="$(pidnow)"
      note "t=$((i * 5))s disk=$NOW pid=${PNOW:-none}"
      [ "$i" -eq 12 ] && shot 02-after-60s
      # the messenger installs, then waits for "Restart"
      if [ "$A" = msgr ] && found Restart 재시작; then note "ready: $(AX click Restart 재시작)"; fi
      if [ "$A" = msgr ] && dump loop | grep -qE 'Update failed|업데이트 실패'; then result=install-error; break; fi
      if [ "$NOW" != "$V0" ] && [ -n "$PNOW" ] && [ "$PNOW" != "$P0" ]; then result=installed-and-relaunched; break; fi
    done
    sleep 15; shot 03-after; dump after > /dev/null
    if [ "$result" = installed-and-relaunched ]; then verdict PASS "updated $V0 -> $(ver "$APP") and relaunched"; else verdict FAIL "result=$result disk=$(ver "$APP")"; fi
    ;;

  argo:dmg|argo:external)
    note "press topbar update: $(AX click Update 업데이트)"
    ok=0
    for i in $(seq 1 12); do sleep 5; dump move | grep -qE 'Move Argo to Applications to update|응용 프로그램.*폴더로 옮겨야' && { ok=1; break; }; done
    sleep 2; shot 02-move-guidance; D="$(dump move)"
    link=0; found 'Download the latest installer' '최신 설치 파일 받기' && link=1
    if [ "$V" = dmg ]; then why='opened straight from the installer|read-only location|설치 파일\(dmg\) 창|읽기 전용 위치'; else why='on another disk|다른 디스크'; fi
    reason=0; printf '%s\n' "$D" | grep -qE "$why" && reason=1
    sleep 45
    NOW="$(ver "$APP")"; PNOW="$(pidnow)"
    note "guidance=$ok link=$link reason=$reason disk=$NOW pid=${PNOW:-none} (start $V0 / $P0)"
    if [ "$ok" = 1 ] && [ "$link" = 1 ] && [ "$reason" = 1 ] && [ "$NOW" = "$V0" ] && [ "$PNOW" = "$P0" ]; then verdict PASS "move guidance shown, no install attempted"; else verdict FAIL "guidance=$ok link=$link reason=$reason disk=$NOW pid=$PNOW"; fi
    ;;

  msgr:dmg|msgr:external)
    D="$(dump move)"; shot 02-move-guidance
    link=0; found 'Latest installer' '최신 설치 파일' && link=1
    inst=0; found 'Install now' '지금 설치' && inst=1
    if [ "$V" = dmg ]; then why='opened straight from the installer|read-only location|설치 파일\(dmg\) 창|읽기 전용 위치'; else why='on another disk|다른 디스크'; fi
    reason=0; printf '%s\n' "$D" | grep -qE "$why" && reason=1
    sleep 45
    NOW="$(ver "$APP")"; PNOW="$(pidnow)"
    note "link=$link install_button=$inst reason=$reason disk=$NOW pid=${PNOW:-none} (start $V0 / $P0)"
    if [ "$link" = 1 ] && [ "$inst" = 0 ] && [ "$reason" = 1 ] && [ "$NOW" = "$V0" ] && [ "$PNOW" = "$P0" ]; then verdict PASS "move guidance shown, no install button"; else verdict FAIL "link=$link install_button=$inst reason=$reason disk=$NOW pid=$PNOW"; fi
    ;;

  argo:rootowned|msgr:rootowned)
    if [ "$A" = msgr ]; then
      adminNote=0; dump before | grep -qE 'may ask for an administrator password|관리자 암호를 물을 수' && adminNote=1
      note "press install: $(AX click 'Install now' '지금 설치')"
    else
      note "press topbar update: $(AX click Update 업데이트)"
    fi
    for i in $(seq 1 24); do sleep 5; [ "$(AX sa-dump | head -1)" != NO_SECURITYAGENT ] && break; done
    AX sa-dump > "$OUT/securityagent.txt"; note "securityagent: $(head -3 "$OUT/securityagent.txt" | tr '\n' ' ')"
    shot 02-admin-prompt
    note "cancel admin prompt: $(AX sa-cancel)"
    sleep 15
    if [ "$A" = argo ]; then
      note "dismiss notes: $(AX click 확인했어요 'Got it')"; sleep 2
      note "open settings: $(AX click Settings 설정)"; sleep 8
      note "devices tab: $(AX click 기기·데이터 'Devices & data')"; sleep 6
      AX reveal 'Could not install the update' > /dev/null; sleep 2
      D="$(dump after)"
      adminNote=0; printf '%s\n' "$D" | grep -qE 'Updating may ask for an administrator password|관리자 암호를 물을 수' && adminNote=1
      failText=0; printf '%s\n' "$D" | grep -qE 'Could not install the update|업데이트를 설치하지 못했어요' && failText=1
    else
      D="$(dump after)"
      failText=0; printf '%s\n' "$D" | grep -qE 'Update failed|업데이트 실패' && failText=1
    fi
    reason=0; printf '%s\n' "$D" | grep -qE 'administrator prompt was cancelled|관리자 암호 입력을 취소' && reason=1
    shot 03-after-cancel
    note "adminNote=$adminNote failText=$failText reason=$reason disk=$(ver "$APP")"
    if [ "$adminNote" = 1 ] && [ "$failText" = 1 ] && [ "$reason" = 1 ]; then verdict PASS "admin note shown; cancelled prompt explained"; else verdict FAIL "adminNote=$adminNote failText=$failText reason=$reason"; fi
    ;;
esac

# ---------- evidence ----------
sudo kill "$FSU" 2>/dev/null; kill "$LOGS" 2>/dev/null; sleep 1
grep -E ' (rename|renameat|renamex_np|renameatx_np) ' "$OUT/fs_usage.raw" > "$OUT/fs_rename.txt" || true
grep -E 'tauri_(updated|current)_app' "$OUT/fs_usage.raw" | head -60 > "$OUT/fs_tauri_tmp.txt" || true
gzip -f "$OUT/fs_usage.raw"
note "rename calls: $(wc -l < "$OUT/fs_rename.txt") tauri temp lines: $(wc -l < "$OUT/fs_tauri_tmp.txt")"
note "final disk version $(ver "$APP") (start $V0)"
cat "$OUT/RESULT"
grep -q '^PASS' "$OUT/RESULT"
