#!/usr/bin/env bash
# qbwr 실전 시험 Q1·Q2·Q3·Q5 실행 — test/fixtures/msgr2/qbwr-q.mjs(합성 계정 로그인·기기·Realtime·첨부 서명).
# 사용: bash scripts/qbwr-q.sh [q1 q2 q3 q5 …]   (인자가 없으면 q1·q2·q3. q5는 백필(Q4) 뒤에)
# 필요: .env.qbwr의 접속 정보 + QBWR_ANON_KEY(JWT ref가 qbwr) + QBWR_SEED_PASSWORD(qbwr-seed.sh db가 만든다). 결과는 artifacts/qbwr/q-<시각>.jsonl
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/qbwr-env.sh
[ -n "$Q_ANON" ] && [ -n "$Q_SEED" ] || qbwr_deny "${QBWR_ENV_FILE}에 QBWR_ANON_KEY·QBWR_SEED_PASSWORD가 필요합니다"
printf '%s' "$Q_ANON" | qbwr_key_ok anon || qbwr_deny "QBWR_ANON_KEY가 qbwr의 anon JWT가 아닙니다(값은 출력하지 않음)"
OUT="${QBWR_OUT:-artifacts/qbwr}"; mkdir -p "$OUT"
F="$OUT/q-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S).jsonl"
QBWR_URL="$Q_URL" QBWR_ANON_KEY="$Q_ANON" QBWR_SEED_PASSWORD="$Q_SEED" node test/fixtures/msgr2/qbwr-q.mjs "$@" | tee "$F"
