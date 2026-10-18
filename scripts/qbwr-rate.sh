#!/usr/bin/env bash
# qbwr 요청·쓰기 측정(읽기 전용) — scripts/db-rate.sh의 qbwr 판. 단계 전후 스냅샷의 차이로 Q7(게이트 B 실측)·유휴를 잰다.
# 사용: bash scripts/qbwr-rate.sh snap <파일>          누적 통계 한 장(표별 쓰기·문장별 호출·realtime.messages·net 응답 행 수)
#       bash scripts/qbwr-rate.sh diff <앞> <뒤>       두 장의 차이(표별 쓰기·호출 상위 25, 합계)
#       bash scripts/qbwr-rate.sh idle [초, 기본 600]  지금부터 N초 동안의 차이(분당 환산)
# 접속은 scripts/qbwr-env.sh(대상이 qbwr가 아니면 exit 5). 운영 .env.local은 읽지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-}"; [ -n "$CMD" ] || { sed -n '2,6p' "$0"; exit 2; }

snap() {
  # 읽기 전용은 세션 첫 문장 set으로 건다 — 풀러는 시작 옵션(PGOPTIONS)을 버린다(db-rate.sh와 같은 이유)
  psql "$C" -X -At -q -F '|' <<'SQL'
set default_transaction_read_only = on;
select 't:'||schemaname||'.'||relname, n_tup_ins+n_tup_upd+n_tup_del, '' from pg_stat_all_tables where schemaname in ('public','storage','auth','realtime','net','cron');
select 'q:'||queryid, calls, left(regexp_replace(query,'\s+',' ','g'),120) from pg_stat_statements where queryid is not null;
select 'r:realtime.messages', count(*), '' from realtime.messages;
select 'r:net._http_response', count(*), '' from net._http_response where to_regclass('net._http_response') is not null;
select 'd:xact', xact_commit + xact_rollback, '' from pg_stat_database where datname = current_database();
SQL
}

diff_snaps() {
  python3 - "$1" "$2" "${3:-}" <<'PY'
import sys
def parse(p):
    d = {}
    for l in open(p, encoding='utf-8'):
        x = l.rstrip('\n').split('|', 2)
        if len(x) >= 2 and x[1].lstrip('-').isdigit(): d[x[0]] = (int(x[1]), x[2] if len(x) > 2 else '')
    return d
a, b = parse(sys.argv[1]), parse(sys.argv[2]); secs = float(sys.argv[3]) if sys.argv[3] else 0
rows = [(v - a.get(k, (0, ''))[0], k, x) for k, (v, x) in b.items()]
rows = [r for r in rows if r[0] != 0]
writes = sum(r[0] for r in rows if r[1].startswith('t:'))
calls = sum(r[0] for r in rows if r[1].startswith('q:') and 'pg_stat' not in r[2])
per = (lambda n: f'  (분당 {n * 60 / secs:.1f})') if secs else (lambda n: '')
print(f'# 합계  표 쓰기 {writes}{per(writes)}  문장 호출 {calls}{per(calls)}')
for k in ('r:realtime.messages', 'r:net._http_response', 'd:xact'):
    if k in b: print(f'# {k[2:]}  {b[k][0] - a.get(k, (0, ""))[0]:+d}')
for kind, title in (('t:', '표별 쓰기'), ('q:', '문장별 호출(측정 질의 포함)')):
    print(f'## {title}')
    for dv, k, x in sorted((r for r in rows if r[1].startswith(kind)), reverse=True)[:25]: print(f'{dv:10d}  {k[2:60] if kind == "t:" else x[:110]}')
PY
}

case "$CMD" in
  snap) . scripts/qbwr-env.sh; snap > "${2:?파일}"; echo "스냅샷 $2 ($(grep -c . "$2")줄, $(TZ=Asia/Seoul date '+%H:%M:%S KST'))" ;;
  diff) diff_snaps "${2:?앞}" "${3:?뒤}" ;;
  idle)
    . scripts/qbwr-env.sh; S=${2:-600}; A=$(mktemp); B=$(mktemp); trap 'rm -f "$A" "$B"' EXIT
    snap > "$A"; sleep "$S"; snap > "$B"; echo "# ${S}초 유휴"; diff_snaps "$A" "$B" "$S" ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
