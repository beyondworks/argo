#!/usr/bin/env bash
# qbwr(시험 Supabase)에 저장소 마이그레이션을 버전 순으로 적용한다 — 메신저 v2 U9 실전 시험(볼트 2026-10-18-msgr2-u9-qbwr-plan 2절).
# 사용: bash scripts/qbwr-apply.sh plan            남은 파일 목록만(쓰기 0)
#       bash scripts/qbwr-apply.sh run [버전]      남은 파일을 차례로 적용(버전을 주면 그 버전까지). 실패한 파일에서 멈춘다
#       bash scripts/qbwr-apply.sh buckets         Storage 버킷 msgr·companies(비공개)가 없으면 만든다(운영은 대시보드로 만들어 마이그레이션에 없다)
# 운영 적용(scripts/msgr-live-apply.sh, 맥 one 전용)과 다른 점: 대상이 qbwr일 때만 돈다(scripts/qbwr-env.sh 검문, 아니면 exit 5).
# qbwr는 운영 데이터가 없는 시험 프로젝트라 main 병합 여부를 따지지 않고 이 체크아웃의 파일을 쓴다(messenger-v2 시험).
# 각 파일과 기록(supabase_migrations.schema_migrations)은 한 트랜잭션이다. 기록된 버전은 다시 적용하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
CMD="${1:-}"; [ -n "$CMD" ] || { sed -n '2,8p' "$0"; exit 2; }
. scripts/qbwr-env.sh
q() { psql "$C" -X -v ON_ERROR_STOP=1 -At -c "$1"; }

applied() { q "select version from supabase_migrations.schema_migrations" 2>/dev/null || true; }
pending() {
  local done; done=$(applied)
  for f in supabase/migrations/*.sql; do
    local b; b=$(basename "$f" .sql); local v=${b%%_*}
    grep -qx "$v" <<<"$done" || echo "$b"
  done
}

case "$CMD" in
  plan)
    P=$(pending); echo "남은 파일 $(grep -c . <<<"$P" || true)개"; echo "$P" ;;
  run)
    UNTIL="${2:-99999999999999}"
    # 준비: 운영에 켜져 있는 확장(pg_cron은 Supabase 안내대로 pg_catalog에), 기록 표. pg_net은 마이그레이션(20260912150000)이 켠다
    psql "$C" -X -v ON_ERROR_STOP=1 -q <<'SQL'
set client_min_messages = warning;
do $$ begin if exists (select 1 from pg_available_extensions where name = 'pg_cron') then create extension if not exists pg_cron with schema pg_catalog; end if; end $$;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
SQL
    n=0
    for b in $(pending); do
      v=${b%%_*}; [ "$v" -le "$UNTIL" ] || break
      # 파일 + 기록을 표준 입력으로 한 트랜잭션에(-1). 잠금은 5초만 기다린다
      { echo "set lock_timeout = '5s'; set statement_timeout = 0; set client_min_messages = warning;"; cat "supabase/migrations/$b.sql"; echo; echo "insert into supabase_migrations.schema_migrations (version, name) values ('$v', '${b#*_}');"; } \
        | psql "$C" -X -q -v ON_ERROR_STOP=1 -1 -f - >/dev/null || { echo "멈춤  $b — 위 오류. 이 파일은 되돌아갔고 앞 ${n}개는 적용됐다"; exit 3; }
      n=$((n + 1)); echo "적용  $b"
    done
    echo "끝  ${n}개 적용, 마지막 기록 버전 $(q "select max(version) from supabase_migrations.schema_migrations"), $(TZ=Asia/Seoul date '+%Y-%m-%d(%a) %H:%M KST')" ;;
  buckets)
    q "insert into storage.buckets (id, name, public) values ('msgr', 'msgr', false), ('companies', 'companies', false) on conflict (id) do nothing returning id"
    q "select id || ' public=' || public from storage.buckets order by id" ;;
  *) echo "모르는 명령: $CMD"; exit 2 ;;
esac
