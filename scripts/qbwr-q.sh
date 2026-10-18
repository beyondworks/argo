#!/usr/bin/env bash
# qbwr 실전 시험 Q1·Q2·Q3·Q5 실행 — test/fixtures/msgr2/qbwr-q.mjs(합성 계정 로그인·기기·Realtime·첨부 서명).
# 사용: bash scripts/qbwr-q.sh [q1 q2 q3 q5 …]   (인자가 없으면 q1·q2·q3. q5는 백필(Q4) 뒤에)
# 필요: .env.qbwr의 접속 정보 + QBWR_ANON_KEY + QBWR_SEED_PASSWORD(qbwr-seed.sh db가 만든다). 결과는 artifacts/qbwr/q-<시각>.jsonl
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/qbwr-env.sh
[ -n "${QBWR_ANON_KEY:-}" ] && [ -n "${QBWR_SEED_PASSWORD:-}" ] || { echo "거부  ${QBWR_ENV}에 QBWR_ANON_KEY·QBWR_SEED_PASSWORD가 필요합니다"; exit 5; }
OUT="${QBWR_OUT:-artifacts/qbwr}"; mkdir -p "$OUT"
F="$OUT/q-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S).jsonl"
node test/fixtures/msgr2/qbwr-q.mjs "$@" | tee "$F"
