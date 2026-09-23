#!/usr/bin/env bash
# 2026-09-23 사고 진단(읽기 전용) — msgr-live-apply.sh가 기록 없던 옛 마이그레이션 7개를 재적용한 영향을 잰다.
# 쓰기 없음: 모든 문장이 select이고 세션을 read only로 연다. 사용: 레포 루트에서 `bash scripts/incident-2026-09-23-diagnose.sh`
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGOPTIONS='-c default_transaction_read_only=on' psql "$C" -At <<'SQL'
select '적용 시각(새 마이그레이션 표 생성 기준): ' || coalesce((select min(created_at)::text from public.msgr_server_links), '행 없음');
-- 1) 재실행 백필로 다시 들어간 채널 멤버(added_by 없음, 최근 3시간)
select 'members_readded kind=' || member_kind || ' n=' || count(*) || ' first=' || min(added_at) || ' last=' || max(added_at)
  from public.msgr_channel_members where added_by is null and added_at > now() - interval '3 hours' group by member_kind;
-- 2) 최근 3시간에 생긴 친구 행
select 'friends_recent status=' || status || ' n=' || count(*) from public.msgr_friends where created_at > now() - interval '3 hours' group by status;
-- 3) allowed → approval로 바뀐 채널(감사 기록)
select 'personal_crews_changed n=' || count(*) from public.msgr_audit_log where action = 'channel.personal_crews' and at > now() - interval '3 hours';
select 'personal_crews_detail ' || target_id || ' ' || meta::text || ' at=' || at from public.msgr_audit_log where action = 'channel.personal_crews' and at > now() - interval '3 hours' limit 50;
-- 4) 함수가 옛 본문으로 덮였는지(차단 반영 여부 등 표지 문자열)
select 'fn ' || p.proname || ' blocks=' || (p.prosrc like '%msgr_user_blocks%' or p.prosrc like '%msgr_blocked%')::text || ' len=' || length(p.prosrc)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('msgr_unread','msgr_push_recipients','msgr_crew_join','msgr_crew_join_decide','msgr_instruct_check','msgr_is_channel_host',
   'msgr_message_fill','msgr_message_broadcast','msgr_can_manage_channel','msgr_can_write_channel','msgr_leave_dm','msgr_channel_journal')
 order by 1;
-- 5) 크루 잠금 트리거에 WHEN 절이 남아 있는지(TOAST 재기록 방지)
select 'trigger ' || tgname || ': ' || pg_get_triggerdef(t.oid) from pg_trigger t where tgname = 'msgr_lock_crews' and not tgisinternal;
SQL
