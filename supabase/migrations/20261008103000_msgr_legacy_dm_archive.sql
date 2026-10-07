-- 예전 조직 1:1 보관(유건 결정 2026-10-08, 1-②). 사람은 주인 한 명, 에이전트는 그 주인의 에이전트 한 명뿐인 조직 DM을 보관한다.
-- 메신저 0.1.51부터 새 1:1은 개인 공간 방(personal_pair 'crew:<개인 행>')으로 가는데, 그 전에 만든 조직 1:1이 목록에 남아 계속 답했다
-- (같은 에이전트와 방이 둘 — 기기마다 다른 방을 봤다). 글은 지우지 않는다: 보관한 방은 읽기만 되고(msgr_can_write_channel이 archived_at을 본다),
-- 메신저 개인 1:1 위 '이전 대화 보기'가 이 방들을 모두 연다(apps/messenger/src/agent-groups.mjs earlierAgentDms).
--
-- 대상(전부 만족):
--   · 조직 안(org_id NOT NULL)의 kind='dm', 아직 보관 안 됨, personal_pair 없음
--   · 구성원이 정확히 둘 — 사람 1명(U) + 에이전트 1명(K), K.owner_user_id = U, K.org_id = 방 조직, K.hosting = 'local'(Argo 본체 에이전트)
--   · 같은 에이전트(주인·회사 ws_id·slug — 앱 agentKey와 같은 판정)의 활성 개인 행이 있다
--     (메신저 앱·본체 알림이 그 행으로 개인 1:1을 찾거나 만든다 — 없으면 보관 뒤 대화할 곳이 없어진다)
-- 제외: 남이 낀 방(사람 2명 이상)·그룹(구성원 3명 이상)·친구 1:1과 개인 방(org 없음)·외부 봇 방(hosting 'bot' — '페퍼 - v' 같은 VPS 봇은
--   별개 에이전트로 둔다, 결정 1-④)·개인 행이 없는 에이전트(옛 본체 — 0.1.92 전)·이미 보관한 방.
-- 대상 목록(운영 읽기 조회, 2026-10-08 — 저장소 밖 _worktrees/argo-rc/artifacts/rc-0195/legacy-dm-archive-targets.csv, 본문 없음):
--   action=archive 42개(사용자 7명, 글 549개) · 제외 47개(외부 봇 방 21, 개인 행 없음 26).
--   외부 봇 방 21 = 유건 계정 '- v' 쌍둥이 14(결정 1-④) + 다른 사용자 4명의 외부 봇 7(Hermes·코덱스·클로드 코드·로이킴 2·훔니·유정 — 결정 1-④ 밖 — 본체 대화와 합칠 대상이 아니라 같은 기준 hosting='bot'으로 뺐다).
--   유건 계정: 보관 13(Lean-AX — 페퍼 2개 287·13 + 슈리·효일·카맥·비스트·파인만·에드나·다빈치·울프·월터·알프레드·요다) · 제외 14('- v' 쌍둥이 전부).
--   보관 시점 안 읽은 글: 19개 방 54개(사용자 3명, 유건 0 — 52개가 루틴·알림 글, 마지막 2026-10-06 08:11 KST). 서버 안 읽음 수는 보관 방을 세지 않아
--   목록 배지는 사라지고, 메신저(이 PR 이후 버전)의 '이전 대화 보기' 줄에 '안 읽은 글 n개'로 남는다.
--
-- 적용 전 조건(총괄이 유건님께 대상 목록·백업과 함께 보이고 승인받는다):
--   1) 메신저 새 버전(이전 대화 보기가 보관 방을 연다)이 사용자에게 간 뒤. 0.1.50 미만(마지막 발행 0.1.48)은 조직에서 내 에이전트를 누르면
--      보관 방을 건너뛰고 새 조직 1:1을 만든다(msgr_create_channel) — 보관 효과가 그 사용자에게서 되돌려진다. 0.1.50은 이전 대화 보기가 없고, 0.1.51~0.1.52는
--      보관 방을 이전 대화 보기에서 뺀다 — 그 버전에서는 옛 글을 볼 길이 없다(글은 DB에 그대로).
--   2) 본체 새 버전(보관 방이 목적지인 루틴·결재 후속을 개인 1:1로 보낸다)이 간 뒤. 0.1.97 이하는 그런 루틴이 종전 오류로 실패한다.
--   3) 개인 1:1에서는 예약·결재·긴 작업·다른 에이전트에게 맡기기를 아직 쓸 수 없다(src/gateway/msgr-handoff.mjs messengerOrigin, 2026-09-30 개인 공간 1단계).
--      보관하면 그 에이전트와의 1:1에서 이 기능이 없어진다. 대상 42개 중 32개 방(유건 11)은 같은 에이전트·주인이 함께 있는 다른 조직 채널이 남아 거기서는 된다.
--      10개 방(사용자 6명 — 유건은 알프레드·효일 2개)은 메신저에서 요청할 곳이 없다(본체 데스크톱 대화는 그대로). 개인 1:1을 여는 단위를 먼저 내보내거나 이 결과에 대한 승인을 따로 받는다.
--   4) 버전 다시 매기기: scripts/msgr-live-apply.sh는 더 새 버전이 기록돼 있으면 거부한다. 그 사이 다른 마이그레이션이 운영에 적용됐으면 적용 직전에 이 파일 이름의
--      버전만 그때 시각으로 바꾼다(pg 테스트는 이름 끝 _msgr_legacy_dm_archive.sql로 찾는다). 손으로 적용하지 않는다(2026-09-23 사고 경로).
--
-- 백업: 바꾸기 전에 msgr_legacy_dm_archive_backup에 방·조직·주인·에이전트·보관 전 값·이번 보관 시각·글 수를 먼저 적는다(같은 문장 안).
-- 멱등: 다시 돌리면 대상 조건(archived_at IS NULL)에 걸리는 방이 없어 아무것도 바꾸지 않는다(테스트 msgr-legacy-dm-archive-pg).
-- 적용 영향: 대상 행만 msgr_channels 한 번 갱신(42행 안팎). 주기 호출·쓰기 없음. 보관한 방에 대기 중이던 본체 잡은 버려진다(msgr.mjs '채널 삭제·보관 — 잡 폐기')
--   — 본체 루틴·알림의 목적지가 이 방이면 실행 때 같은 에이전트의 개인 1:1로 보낸다(src/gateway/msgr.mjs movedAgentRoom).
--
-- 되돌리기(이 마이그레이션이 보관한 방만 — 그 뒤 사람이 다시 바꾼 방은 건드리지 않는다):
--   update public.msgr_channels c set archived_at = b.prev_archived_at
--     from public.msgr_legacy_dm_archive_backup b
--    where c.id = b.channel_id and c.archived_at = b.archived_at;
-- 백업 표 정리(되돌릴 일이 없어진 뒤 — 예: 적용 30일 뒤): drop table public.msgr_legacy_dm_archive_backup;
-- 이 표는 한 번만 채우고 더 쌓이지 않는다(주기 쓰기 없음).

set local lock_timeout = '5s'; -- msgr_channels는 자주 읽힌다 — 행 잠금을 오래 기다리며 뒤 요청을 줄 세우지 않고 실패한다(다시 실행하면 된다)

create table if not exists public.msgr_legacy_dm_archive_backup (
  channel_id uuid primary key,
  org_id uuid not null,
  owner_user_id uuid not null,
  crew_id uuid not null,
  prev_archived_at timestamptz,          -- 보관 전 값(대상 조건상 NULL)
  archived_at timestamptz not null,      -- 이 마이그레이션이 넣은 값 — 되돌리기는 이 값과 같을 때만
  msg_count integer not null,            -- 삭제 안 된 글 수(보관 시점)
  recorded_at timestamptz not null default now()
);
alter table public.msgr_legacy_dm_archive_backup enable row level security; -- 정책 없음: 운영자(서비스 역할·DB 소유자)만
revoke all on public.msgr_legacy_dm_archive_backup from public, anon, authenticated;

with targets as (
  select c.id as channel_id, c.org_id, u.member_id as owner_user_id, k.id as crew_id,
         (select count(*) from public.msgr_messages m where m.channel_id = c.id and m.deleted_at is null)::int as msg_count
    from public.msgr_channels c
    join public.msgr_channel_members u on u.channel_id = c.id and u.member_kind = 'user'
    join public.msgr_channel_members km on km.channel_id = c.id and km.member_kind = 'crew'
    join public.msgr_crews k on k.id = km.member_id
   where c.kind = 'dm' and c.org_id is not null and c.archived_at is null and c.personal_pair is null
     and (select count(*) from public.msgr_channel_members a where a.channel_id = c.id) = 2 -- 사람 1 + 에이전트 1(위 조인이 하나씩 잡는다)
     and k.owner_user_id = u.member_id and k.org_id = c.org_id and k.hosting = 'local'
     and exists (select 1 from public.msgr_crews p
                  where p.org_id is null and p.owner_user_id = u.member_id and p.ws_id = k.ws_id and p.slug = k.slug
                    and p.status = 'active')
),
saved as (
  insert into public.msgr_legacy_dm_archive_backup (channel_id, org_id, owner_user_id, crew_id, prev_archived_at, archived_at, msg_count)
  select channel_id, org_id, owner_user_id, crew_id, null, now(), msg_count from targets
  on conflict (channel_id) do update -- 되돌린 뒤 다시 적용하는 경우 — 마지막 보관 시각으로 바꿔 둔다(되돌리기가 그 값을 본다)
    set prev_archived_at = excluded.prev_archived_at, archived_at = excluded.archived_at, msg_count = excluded.msg_count, recorded_at = now()
  returning channel_id, archived_at
)
update public.msgr_channels c set archived_at = s.archived_at
  from saved s
 where c.id = s.channel_id and c.archived_at is null;
