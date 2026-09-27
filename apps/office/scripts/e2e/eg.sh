#!/bin/zsh
# ego-browser 실행 — 창이 숨으면 캡처가 멈춘다(메모 argo-msgr-qa-sweep-shell) — 실행 직전에 보이게 한다(앞으로 가져오지는 않음).
osascript -e 'tell application "System Events" to set visible of (first process whose name is "ego lite") to true' >/dev/null 2>&1
exec ego-browser nodejs
