#!/usr/bin/env bash
# 게이트 A(CLAUDE.md 회귀 게이트 3) — 새 코드 + 배포본 시험을 임시 워크트리에서 돌리고, 배포본 코드 + 배포본 시험(기준선)의 실패와 비교한다.
# 사용: bash scripts/gate-a.sh <배포본 ref> <새 코드 ref> <결과 폴더>
#   예: bash scripts/gate-a.sh origin/main origin/messenger-v2 /tmp/gate-a
# 두 워크트리:
#   base = 배포본 코드 + 배포본 시험(그대로)
#   new  = 새 코드 + 배포본 시험(test/·apps/messenger/test를 배포본 것으로 바꾼다 — 새 코드의 새 시험은 쓰지 않는다)
# 돌리는 것(각 워크트리): node --test test/*.test.mjs · apps/messenger의 node --test test/*.test.mjs · PG 드릴(scripts/billing-pg-drill.sh, 인자 없음 = test/*pg* 전부)
#   PG 드릴은 새 코드 쪽에서도 드릴 스크립트를 배포본 것으로 쓴다(드릴 자체가 바뀌어 결과가 달라지지 않게).
# 결과: <결과 폴더>/{base,new}-{node,msgr,pg}.tap, 실패 목록 {base,new}-fail.txt, 새 실패 new-only.txt(기준선에 없고 새 판에만 있는 실패), 고쳐진 것 base-only.txt
# 실패 이름 = "<파일> :: <시험 이름>"(TAP의 not ok 줄과 그 위 # Subtest 파일 머리로 만든다). 판정(a~d)은 사람이 new-only.txt를 보고 문서로 남긴다.
# 워크트리는 끝나면 지운다(trap). 데이터·실행 중 서버는 건드리지 않는다(시험은 임시 ARGO_ROOT·임시 PG만 쓴다).
set -euo pipefail
BASE_REF="${1:?배포본 ref}"; NEW_REF="${2:?새 코드 ref}"; OUT="${3:?결과 폴더}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$OUT"
WT="$(mktemp -d)"
cleanup() { git -C "$ROOT" worktree remove --force "$WT/base" >/dev/null 2>&1 || true; git -C "$ROOT" worktree remove --force "$WT/new" >/dev/null 2>&1 || true; rm -rf "$WT"; }
trap cleanup EXIT

git -C "$ROOT" worktree add -q --detach "$WT/base" "$BASE_REF"
git -C "$ROOT" worktree add -q --detach "$WT/new" "$NEW_REF"
# 새 코드에 배포본 시험을 놓는다(시험 폴더를 통째로 바꾼다 — 새 판에만 있는 시험 파일은 빠진다)
for d in test apps/messenger/test; do
  rm -rf "${WT:?}/new/$d"; mkdir -p "$WT/new/$d"
  git -C "$ROOT" archive "$BASE_REF" "$d" | tar -x -C "$WT/new"
done
git -C "$ROOT" show "$BASE_REF:scripts/billing-pg-drill.sh" > "$WT/new/scripts/billing-pg-drill.sh"
for side in base new; do
  ln -s "$ROOT/node_modules" "$WT/$side/node_modules"
  echo "[gate-a] $side: $(git -C "$WT/$side" rev-parse --short HEAD)" | tee -a "$OUT/refs.txt"
done

run() { # side → TAP 셋
  local side="$1" dir="$WT/$1"
  ( cd "$dir" && env -i PATH="$PATH" HOME="$HOME" node --test --test-force-exit --test-reporter=tap test/*.test.mjs > "$OUT/$side-node.tap" 2>&1 ) || true
  ( cd "$dir/apps/messenger" && env -i PATH="$PATH" HOME="$HOME" node --test --test-force-exit --test-reporter=tap test/*.test.mjs > "$OUT/$side-msgr.tap" 2>&1 ) || true
  ( cd "$dir" && bash scripts/billing-pg-drill.sh > "$OUT/$side-pg.tap" 2>&1 ) || true
}
run base
run new

# 실패 이름 뽑기: 최상위 "# Subtest: <파일>" 아래의 not ok 줄(들여쓰기 무관). 드릴은 "[drill] <파일> → db" 줄이 파일 머리다.
fails() {
  awk '
    /^\[drill\] test\// { split($2, a, " "); file = a[1]; next }
    /^# Subtest: / && !/^ / { if ($3 ~ /\.test\.mjs$/) file = $3 }
    /^ *not ok [0-9]+ - / { name = $0; sub(/^ *not ok [0-9]+ - /, "", name); sub(/ # .*$/, "", name); print FILENAME_TAG " " file " :: " name }
  ' FILENAME_TAG="$1" "$2"
}
for side in base new; do
  : > "$OUT/$side-fail.txt"
  for k in node msgr pg; do fails "$k" "$OUT/$side-$k.tap" >> "$OUT/$side-fail.txt"; done
  sort -u -o "$OUT/$side-fail.txt" "$OUT/$side-fail.txt"
done
comm -13 "$OUT/base-fail.txt" "$OUT/new-fail.txt" > "$OUT/new-only.txt"
comm -23 "$OUT/base-fail.txt" "$OUT/new-fail.txt" > "$OUT/base-only.txt"
for side in base new; do for k in node msgr pg; do
  printf '[gate-a] %s-%s: ' "$side" "$k"; grep -E '^# (tests|pass|fail|skipped) ' "$OUT/$side-$k.tap" | awk '{printf "%s %s · ", $2, $3}'; echo
done; done | tee -a "$OUT/summary.txt"
echo "[gate-a] 기준선 실패 $(wc -l < "$OUT/base-fail.txt") · 새 판 실패 $(wc -l < "$OUT/new-fail.txt") · 새 실패 $(wc -l < "$OUT/new-only.txt") · 고쳐짐 $(wc -l < "$OUT/base-only.txt")" | tee -a "$OUT/summary.txt"
