#!/usr/bin/env bash
# DB 위생 점검(읽기 전용) — 용량 상위 테이블·죽은 행·누적형 시스템 테이블(pg_net·pg_cron·realtime·auth)·호출 상위 쿼리·쓰기 상위 쿼리·안 쓰는 인덱스·롤백/교착.
# 2026-09-23 유건 지시: 호출 오류로 2GB 중 90%를 점유한 사고가 다시 없도록. 사용: bash scripts/db-health.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD" PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=60000'
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
psql "$C" -At -F ' | ' <<'SQL'
select '# db_size=' || pg_size_pretty(pg_database_size(current_database()));
select '# tables';
select n.nspname||'.'||c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) total, pg_size_pretty(pg_relation_size(c.oid)) heap,
       'live='||coalesce(s.n_live_tup,0), 'dead='||coalesce(s.n_dead_tup,0), 'ins='||coalesce(s.n_tup_ins,0), 'upd='||coalesce(s.n_tup_upd,0), 'del='||coalesce(s.n_tup_del,0),
       'autovac='||coalesce(to_char(greatest(s.last_autovacuum,s.last_vacuum),'MM-DD HH24:MI'),'-')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace left join pg_stat_all_tables s on s.relid=c.oid
 where c.relkind in ('r','p','m') and n.nspname not in ('pg_catalog','information_schema','pg_toast')
 order by pg_total_relation_size(c.oid) desc limit 25;
select '# storage_buckets';
select bucket_id, count(*), pg_size_pretty(sum(coalesce((metadata->>'size')::bigint,0))) from storage.objects group by 1 order by sum(coalesce((metadata->>'size')::bigint,0)) desc;
select '# stats_reset=' || coalesce(stats_reset::text,'?') from pg_stat_statements_info;
select '# top_calls';
select calls, round(mean_exec_time::numeric,1)||'ms', round((total_exec_time/60000)::numeric,1)||'min', rows, left(regexp_replace(query,'\s+',' ','g'),110)
  from pg_stat_statements where query not ilike '%pg_stat%' order by calls desc limit 15;
select '# top_rows_written';
select calls, rows, round(mean_exec_time::numeric,1)||'ms', left(regexp_replace(query,'\s+',' ','g'),110)
  from pg_stat_statements where query ~* '^\s*(update|insert|delete)' order by rows desc limit 12;
select '# db_stats';
select 'commit='||xact_commit, 'rollback='||xact_rollback, 'deadlocks='||deadlocks, 'conflicts='||conflicts, 'temp_files='||temp_files, 'temp='||pg_size_pretty(temp_bytes) from pg_stat_database where datname=current_database();
select '# unused_indexes(>1MB)';
select s.schemaname||'.'||s.indexrelname, pg_size_pretty(pg_relation_size(s.indexrelid)), 'scans='||s.idx_scan from pg_stat_user_indexes s join pg_index i on i.indexrelid=s.indexrelid
 where s.idx_scan=0 and not i.indisunique and not i.indisprimary and pg_relation_size(s.indexrelid)>1048576 order by pg_relation_size(s.indexrelid) desc limit 15;
select '# cron_jobs';
select jobid, schedule, left(command,90), active from cron.job order by jobid;
SQL
