#!/usr/bin/env bash
# 팀 메신저 라이브 Supabase 배선 — **인자로 준 마이그레이션만** 적용하고 schema_migrations에 기록한다.
# 사용: 레포 루트에서 `bash scripts/msgr-live-apply.sh 20260923120000_msgr_server_links` (.env.local의 SUPABASE_DB_PASSWORD·NEXT_PUBLIC_SUPABASE_URL 사용, 값은 출력하지 않는다)
# 접속 = 서울 풀러 aws-1-ap-northeast-2(직결 호스트는 IPv6 전용이라 맥에서 안 붙는다 — 2026-09-09 실측).
# 각 파일은 한 트랜잭션(-1)이며 ON_ERROR_STOP — 실패한 파일에서 멈추고 그 앞까지만 적용된다.
# 2026-09-23 사고: 예전에는 고정 목록 전체를 돌며 "기록 없음 = 미적용"으로 보고 적용했다. 라이브에 이미 들어갔지만 기록이 없던
# 옛 파일 7개가 다시 실행돼 뒤 마이그레이션의 함수·정책을 옛 정의로 덮고 백필을 재실행했다(복구: scripts/incident-2026-09-23-*).
# 그래서 목록을 없애고 인자로만 받으며, 더 새 버전이 이미 기록돼 있으면 옛 파일은 적용하지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
# 검문(2026-09-24) — 라이브에는 main에 병합된 것과 **똑같은** 파일만 적용한다. 옛 브랜치에 남은 옛 적용 스크립트·수정 중인 마이그레이션이
# 라이브 함수를 덮는 사고(9/23)를 구조로 막는다. 접속 정보를 읽기 전에 거른다.
[ $# -gt 0 ] || { echo "적용할 마이그레이션 이름을 인자로 주세요 (예: 20260923120000_msgr_server_links)"; exit 2; }
set -- "${@%.sql}" # 확장자를 붙여 줘도 같은 이름으로
# main을 명시적으로 가져온다 — fetch 대상 설정이 좁으면 `git fetch origin main`이 origin/main을 갱신하지 않아 낡은 main과 비교된다
git fetch -q origin +refs/heads/main:refs/remotes/origin/main || { echo "거부  origin/main을 가져오지 못했습니다 — 네트워크 확인 뒤 다시"; exit 4; }
MAINTMP=$(mktemp); trap 'rm -f "$MAINTMP"' EXIT
same_as_main() { git show "origin/main:$1" > "$MAINTMP" 2>/dev/null || return 1; cmp -s "$MAINTMP" "$1"; } # git show 실패를 빈 파일 비교로 삼키지 않는다
same_as_main scripts/msgr-live-apply.sh || { echo "거부  이 적용 스크립트가 main 최신과 다릅니다 — main 최신 체크아웃에서 실행하세요"; exit 4; }
for f in "$@"; do
  git cat-file -e "origin/main:supabase/migrations/$f.sql" 2>/dev/null || { echo "거부  $f — main에 병합되지 않은 파일"; exit 4; }
  same_as_main "supabase/migrations/$f.sql" || { echo "거부  $f — main 병합본과 내용이 다릅니다"; exit 4; }
done
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
FILES=("$@")
for f in "${FILES[@]}"; do
  V=${f%%_*}
  if [ "$(psql "$C" -At -c "select count(*) from supabase_migrations.schema_migrations where version = '$V'")" = "1" ]; then echo "skip  $f (이미 기록됨)"; continue; fi
  [ -f "supabase/migrations/$f.sql" ] || { echo "없는 파일: $f"; exit 2; }
  NEWER=$(psql "$C" -At -c "select count(*) from supabase_migrations.schema_migrations where version > '$V'")
  if [ "$NEWER" != "0" ]; then echo "거부  $f — 더 새 버전 ${NEWER}개가 이미 기록됨(옛 정의로 덮을 수 있다). 그 파일이 정말 빠졌는지 정의 대조 뒤 손으로 적용하세요."; exit 3; fi
  # 실패하면 여기서 멈춘다 — 종전 `| grep -v NOTICE || true`는 SQL 실패를 삼키고 아래에서 적용됨으로 기록했다(2026-09-17 발견). NOTICE는 PGOPTIONS로 끈다.
  # 잠금을 오래 기다리지 않는다(2026-10-06 #846 검수) — alter policy·create trigger는 표에 강한 잠금(ACCESS EXCLUSIVE)을 건다. 그 표에 긴 쿼리가 있으면
  # 기다리는 동안 뒤따르는 모든 읽기·쓰기가 줄을 선다. 못 얻으면 이 파일은 통째로 되돌려지고(-1) 여기서 멈춘다 — 같은 명령으로 다시 실행하면 된다.
  # 기본 5초, ARGO_APPLY_LOCK_TIMEOUT으로 바꾼다. 사용자가 준 PGOPTIONS는 덮지 않고 이어 붙인다.
  # 선잠금(2026-10-08 실측): 이 Supabase의 supautils는 트리거·정책 DDL(drop trigger·create/alter/drop policy)을 실행하는 순간
  # auth·storage·realtime 표 23개를 ACCESS EXCLUSIVE로 잠근다. 메신저·동기화가 storage.objects를 읽은 채 auth.users를 기다리고 있으면
  # 교착이 나고(10/8 0.1.99 적용 세 번 연속), 교착이 안 나도 그 사이 로그인·파일 요청이 줄을 선다. 그런 파일은 트랜잭션 첫 문장에서
  # 그 표들을 NOWAIT로 먼저 잠근다 — 못 얻으면 아무도 기다리게 하지 않고 바로 실패해 통째로 되돌려지고, 1초 뒤 다시 한다(최대 ARGO_APPLY_TRIES, 기본 30).
  # 함수만 바꾸는 파일은 선잠금하지 않는다(그 표들을 잠그지 않는다 — 같은 날 실측).
  WRAP=$(mktemp); ERR=$(mktemp)
  if grep -qiE '(create|alter|drop)[[:space:]]+policy|drop[[:space:]]+trigger' "supabase/migrations/$f.sql"; then
    cat > "$WRAP" <<'PRELOCK'
do $prelock$ declare t text; begin
  foreach t in array array['storage.objects','storage.buckets','storage.buckets_analytics','storage.s3_multipart_uploads','storage.s3_multipart_uploads_parts',
    'realtime.messages','realtime.subscription','auth.users','auth.identities','auth.sessions','auth.refresh_tokens','auth.mfa_factors','auth.mfa_challenges',
    'auth.mfa_amr_claims','auth.one_time_tokens','auth.flow_state','auth.audit_log_entries','auth.instances','auth.sso_providers','auth.sso_domains',
    'auth.saml_providers','auth.saml_relay_states','auth.oauth_clients'] loop
    if to_regclass(t) is not null then execute 'lock table ' || t || ' in access exclusive mode nowait'; end if;
  end loop;
end $prelock$;
PRELOCK
  fi
  echo "\\i supabase/migrations/$f.sql" >> "$WRAP"
  for try in $(seq 1 "${ARGO_APPLY_TRIES:-30}"); do
    if PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning -c lock_timeout=${ARGO_APPLY_LOCK_TIMEOUT:-5s}" psql "$C" -v ON_ERROR_STOP=1 -1 -q -f "$WRAP" 2> "$ERR"; then break; fi
    if grep -qE 'could not obtain lock|deadlock detected' "$ERR" && [ "$try" -lt "${ARGO_APPLY_TRIES:-30}" ]; then echo "잠금 대기 — $try회째 되돌림, 1초 뒤 다시"; sleep 1; continue; fi
    cat "$ERR" >&2; rm -f "$WRAP" "$ERR"; exit 1
  done
  rm -f "$WRAP" "$ERR"
  psql "$C" -q -c "insert into supabase_migrations.schema_migrations (version, name, statements) values ('$V', '${f#*_}', array[]::text[]) on conflict (version) do nothing"
  echo "OK    $f"
done
echo "--- 검증"
psql "$C" -At <<'SQL'
select 'tables='||count(*) from pg_tables where schemaname='public' and tablename like 'msgr_%';
select 'buckets='||string_agg(id, ',') from storage.buckets;
select 'fn='||count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'msgr_%';
select 'crews_active='||count(*) filter (where status='active')||' available='||count(*) filter (where status='available') from public.msgr_crews;
SQL
