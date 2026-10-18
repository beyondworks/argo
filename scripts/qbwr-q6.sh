#!/usr/bin/env bash
# qbwr 실전 시험 Q6~Q11 실행 — test/fixtures/msgr2/qbwr-q6.mjs(스위치 뒤 목록·검색, 게이트 B 실경로, 푸시 경로, 보존·pg_net, 신고 색인, 작업 창).
# 사용: bash scripts/qbwr-q6.sh [q6 q7 q8 q9 q10 q11]   (인자가 없으면 전부, 백필(Q4)·첨부(Q5) 뒤에. Q11은 합성 계정 p059를 지우므로 맨 마지막)
#       QBWR_IDLE_S=600(기본) — Q7 유휴 구간 초
# 필요: .env.qbwr의 접속 정보 + QBWR_ANON_KEY(JWT ref가 qbwr) + QBWR_SEED_PASSWORD. 결과는 artifacts/qbwr/q6-<시각>.jsonl
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/qbwr-env.sh
[ -n "$Q_ANON" ] && [ -n "$Q_SEED" ] || qbwr_deny "${QBWR_ENV_FILE}에 QBWR_ANON_KEY·QBWR_SEED_PASSWORD가 필요합니다"
printf '%s' "$Q_ANON" | qbwr_key_ok anon || qbwr_deny "QBWR_ANON_KEY가 qbwr의 anon JWT가 아닙니다(값은 출력하지 않음)"
OUT="${QBWR_OUT:-artifacts/qbwr}"; mkdir -p "$OUT"
F="$OUT/q6-$(TZ=Asia/Seoul date +%Y%m%d-%H%M%S).jsonl"
QBWR_URL="$Q_URL" QBWR_ANON_KEY="$Q_ANON" QBWR_SEED_PASSWORD="$Q_SEED" QBWR_IDLE_S="${QBWR_IDLE_S:-600}" node test/fixtures/msgr2/qbwr-q6.mjs "$@" | tee "$F"
