#!/bin/bash
# Reproduce the Argo 0.1.89 in-app update on a clean macOS runner (repro branch only; never merged).
# usage: run.sh <variant> <dmg>
#   applications  /Applications/argo.app owned by the runner user (what a normal Finder install looks like)
#   dmg           run straight from the mounted, quarantined dmg (Gatekeeper + App Translocation)
#   external      installed on a second APFS volume (external-drive install)
#   rootowned     /Applications/argo.app owned by root (installed by another account)
set -u
V="$1"; DMG="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${OUT:-$PWD/out}"; mkdir -p "$OUT"
T="$(getconf DARWIN_USER_TEMP_DIR)"
AX() { osascript "$HERE/ax.applescript" "$@" 2>&1; }
note() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$OUT/steps.log"; }
shot() { if screencapture -x "$OUT/$1.png" 2>>"$OUT/steps.log"; then note "shot $1"; else note "screencapture failed ($1)"; fi; }
ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" 2>/dev/null || echo '?'; }
procs() { ps -axo pid=,lstart=,comm= | grep -E 'Contents/MacOS/(app|node)$' || true; }

note "variant=$V dmg=$(basename "$DMG") arch=$(uname -m) macOS=$(sw_vers -productVersion) user=$(id -un) groups=$(id -Gn | tr ' ' ,)"
note "TMPDIR(user)=$T"
ls -ld /Applications "$T" | tee -a "$OUT/steps.log"

# ---------- install like the variant says ----------
if [ "$V" = dmg ]; then
  # what a browser download leaves on the dmg
  xattr -w com.apple.quarantine "0083;$(printf %x "$(date +%s)");Safari;" "$DMG"
fi
hdiutil attach -nobrowse -mountpoint /Volumes/argo-dmg "$DMG" > /dev/null || { note "dmg attach failed"; exit 1; }
SRC="$(ls -d /Volumes/argo-dmg/*.app | head -1)"
note "dmg app: $SRC ($(ver "$SRC"))"
case "$V" in
  applications) ditto "$SRC" /Applications/argo.app; APP=/Applications/argo.app ;;
  rootowned) ditto "$SRC" /Applications/argo.app; sudo chown -R root:wheel /Applications/argo.app; APP=/Applications/argo.app ;;
  external)
    hdiutil create -quiet -size 3g -fs APFS -volname ArgoExt "$RUNNER_TEMP/ext.dmg"
    hdiutil attach -nobrowse -mountpoint /Volumes/ArgoExt "$RUNNER_TEMP/ext.dmg" > /dev/null
    mkdir -p /Volumes/ArgoExt/Applications
    ditto "$SRC" /Volumes/ArgoExt/Applications/argo.app; APP=/Volumes/ArgoExt/Applications/argo.app ;;
  dmg) APP="$SRC" ;;
  *) note "unknown variant"; exit 1 ;;
esac
V0="$(ver "$APP")"
note "APP=$APP version=$V0"
ls -ld "$APP" | tee -a "$OUT/steps.log"
{ echo "xattr:"; xattr "$APP"; mount | grep -E 'argo-dmg|ArgoExt| / '; df -h "$APP" "$T"; } >> "$OUT/steps.log" 2>&1

# ---------- launch through LaunchServices, as a user would ----------
/usr/bin/log stream --style compact --predicate 'process == "app" OR process == "CoreServicesUIAgent" OR process == "syspolicyd"' > "$OUT/oslog.txt" 2>&1 &
LOGS=$!
open --stdout "$OUT/app.stdout" --stderr "$OUT/app.stderr" "$APP" &   # blocks while the Gatekeeper prompt is up
sleep 5

drive() {
  local i D
  for i in $(seq 1 90); do
    if [ "$V" = dmg ] && [ "$i" -le 24 ]; then
      g="$(AX gk-open)"; case "$g" in GK_OPENED*) note "$g"; sleep 3 ;; esac
    fi
    D="$(AX dump)"; printf '%s\n' "$D" > "$OUT/ui-last.txt"
    case "$(AX find Update 업데이트)" in FOUND*) note "topbar update button visible"; return 0 ;; esac
    if printf '%s\n' "$D" | grep -qE 'Start local-only|로컬 전용으로 시작'; then
      note "login screen: $(AX clickc 'Start local-only' '로컬 전용으로 시작')"; sleep 6; continue
    fi
    if printf '%s\n' "$D" | grep -qE 'Create company|회사 만들기'; then
      note "home screen: $(AX type 'Repro Co')"; sleep 10; continue
    fi
    [ $((i % 6)) -eq 0 ] && note "waiting for UI ($i): $(printf '%s\n' "$D" | head -1)"
    sleep 5
  done
  return 1
}

if ! drive; then
  note "could not reach the update button"; shot 99-stuck; cp "$OUT/ui-last.txt" "$OUT/ui-stuck.txt"
  procs | tee -a "$OUT/steps.log"
  kill "$LOGS" 2>/dev/null; exit 1
fi
P0="$(procs | awk '/MacOS\/app$/{print $1}' | head -1)"
note "running app pid=$P0 path=$(ps -o comm= -p "$P0")"
shot 01-company-with-update-badge

# ---------- press Update and watch what the updater does on disk ----------
sudo fs_usage -w -f filesys app > "$OUT/fs_usage.raw" 2>&1 &
FSU=$!
sleep 3
note "press topbar update: $(AX click Update 업데이트)"

seen_installing=0; idle_update=0; result=timeout
for i in $(seq 1 120); do
  sleep 5
  NOW="$(ver "$APP")"
  PNOW="$(procs | awk '/MacOS\/app$/{print $1}' | head -1)"
  D="$(AX dump)"
  st=other
  if printf '%s\n' "$D" | grep -qE 'Installing…|설치 중…'; then st=installing; seen_installing=1; idle_update=0
  elif case "$(AX find Update 업데이트)" in FOUND*) true ;; *) false ;; esac; then st=update-button; idle_update=$((idle_update + 1))
  fi
  note "t=$((i * 5))s disk=$NOW pid=${PNOW:-none} ui=$st"
  [ "$i" -eq 12 ] && shot 02-after-60s
  if [ "$V" = rootowned ] && [ "$i" -eq 12 ]; then
    AX sa-dump > "$OUT/securityagent.txt"; note "securityagent: $(head -3 "$OUT/securityagent.txt" | tr '\n' ' ')"
    shot 02b-admin-prompt
    note "cancel admin prompt: $(AX sa-cancel)"
  fi
  if [ "$NOW" != "$V0" ] && [ -n "$PNOW" ] && [ "$PNOW" != "$P0" ]; then result=installed-and-relaunched; break; fi
  if [ "$st" = update-button ] && { [ "$seen_installing" = 1 ] || [ "$idle_update" -ge 6 ]; }; then result=failed-back-to-update-button; break; fi
done
note "RESULT=$result disk_version=$(ver "$APP")"
sleep 20
shot 03-after-update-attempt
AX dump > "$OUT/ui-after.txt"

# ---------- on failure, reproduce the customer's settings screen ----------
if [ "$result" != installed-and-relaunched ]; then
  note "dismiss update notes: $(AX click 확인했어요 'Got it')"; sleep 2
  note "open settings: $(AX click Settings 설정)"; sleep 8
  note "devices tab: $(AX click 기기·데이터 'Devices & data')"; sleep 6
  shot 04a-devices-tab
  note "settings install button: $(AX clickc 'and restart' '설치 후 재시작')"
  for i in $(seq 1 36); do
    sleep 5
    if AX dump | grep -qE 'Could not check for updates|업데이트를 확인하지 못했어요'; then note "settings card shows the error text (t=$((i * 5))s)"; break; fi
  done
  AX reveal 'Could not check for updates' > /dev/null; sleep 2
  shot 04-settings-card
  AX dump > "$OUT/ui-settings.txt"
fi

# ---------- evidence ----------
sudo kill "$FSU" 2>/dev/null; kill "$LOGS" 2>/dev/null; sleep 1
grep -E ' (rename|renameat|renamex_np|renameatx_np) ' "$OUT/fs_usage.raw" > "$OUT/fs_rename.txt" || true
grep -E 'tauri_(updated|current)_app' "$OUT/fs_usage.raw" | head -60 > "$OUT/fs_tauri_tmp.txt" || true
grep -E '\[ *[0-9]+\]' "$OUT/fs_usage.raw" | grep -vE ' (stat64|lstat64|getattrlist|access|open|openat|readlink|getxattr|listxattr|fstatat64|statfs64) ' | head -200 > "$OUT/fs_errors.txt" || true
gzip -f "$OUT/fs_usage.raw"
{ echo "== procs"; procs; echo "== user tmp"; ls -la "$T" | grep -i -E 'tauri|AppTranslocation' ; echo "== app"; ls -ld "$APP"; codesign -dv "$APP" 2>&1 | grep -E 'Identifier|TeamIdentifier|Timestamp'; } > "$OUT/final.txt" 2>&1
note "final disk version $(ver "$APP") (start $V0)"
note "rename calls: $(wc -l < "$OUT/fs_rename.txt")"
cat "$OUT/fs_rename.txt" | tail -20 | tee -a "$OUT/steps.log"
echo "RESULT=$result" > "$OUT/RESULT"
