#!/usr/bin/env bash
# DB 쓰기·호출 속도(읽기 전용) — 누적 통계를 N초 간격으로 두 번 떠서 차이를 본다. 사용: bash scripts/db-rate.sh [초, 기본 120]
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD" PGOPTIONS='-c default_transaction_read_only=on'
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
snap() { psql "$C" -At -F '|' <<'SQL'
select 't:'||schemaname||'.'||relname, n_tup_ins+n_tup_upd+n_tup_del, n_tup_upd from pg_stat_all_tables where schemaname in ('public','storage','auth','realtime','net','cron');
select 'q:'||md5(query), calls, left(regexp_replace(query,'\s+',' ','g'),120) from pg_stat_statements where calls > 1000;
select 'd:db', xact_rollback, xact_commit from pg_stat_database where datname=current_database();
SQL
}
S=${1:-120}
A=$(snap); sleep "$S"; B=$(snap)
python3 - "$S" <<PY
import sys
S=float(sys.argv[1])
def parse(t):
    d={}
    for l in t.splitlines():
        p=l.split('|',2)
        if len(p)>=2: d[p[0]]=(int(p[1]), p[2] if len(p)>2 else '')
    return d
a=parse("""$A"""); b=parse("""$B""")
rows=[]
for k,(v,x) in b.items():
    if k in a and v-a[k][0]>0: rows.append((v-a[k][0],k,x))
rows.sort(reverse=True)
print(f"# {S:.0f}초 동안 변화(분당 환산)")
for dv,k,x in rows[:25]: print(f"{dv*60/S:10.0f}/분  {k[:60]}  {x[:110]}")
PY
