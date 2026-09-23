#!/usr/bin/env bash
# 2026-09-23 사고: 백필 재실행으로 다시 들어간 채널 멤버 행을 보여 준다(읽기 전용). 이메일은 앞 3자만.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env.local; set +a
REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://([a-z0-9]+)\.supabase\.co.*#\1#')
export PGPASSWORD="$SUPABASE_DB_PASSWORD"
C="host=aws-1-ap-northeast-2.pooler.supabase.com port=5432 user=postgres.$REF dbname=postgres sslmode=require"
PGOPTIONS='-c default_transaction_read_only=on' psql "$C" -At -F ' | ' <<'SQL'
select m.channel_id, c.name, c.kind, o.name as org, m.member_id, left(u.email, 3) || '***', coalesce(p.display_name, ''),
       (select om.role from public.msgr_org_members om where om.org_id = c.org_id and om.user_id = m.member_id and om.removed_at is null) as org_role,
       (select count(*) from public.msgr_messages x where x.channel_id = c.id and x.author_user_id = m.member_id) as posts,
       m.added_at
  from public.msgr_channel_members m
  join public.msgr_channels c on c.id = m.channel_id
  left join public.msgr_orgs o on o.id = c.org_id
  left join auth.users u on u.id = m.member_id
  left join public.msgr_profiles p on p.user_id = m.member_id
 where m.member_kind = 'user' and m.added_by is null and m.added_at > now() - interval '6 hours';
-- 그 사람이 이 채널을 나간 기록(감사 로그)
select 'audit ' || a.action || ' at=' || a.at from public.msgr_audit_log a
 where a.target_id in (select channel_id::text from public.msgr_channel_members where member_kind = 'user' and added_by is null and added_at > now() - interval '6 hours')
   and a.action ilike '%leave%' order by a.at desc limit 5;
SQL
