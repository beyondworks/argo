-- 되돌림: supabase/migrations/20261025130000_msgr2_agent_look.sql의 저장 입구만 걷어 낸다(마이그레이션이 아니다 — 바로 실행하는 파일).
-- 하는 일: msgr2_agent_set_profile을 지운다(메신저 얼굴·사진·직무·소개 저장이 다시 v2_unsupported가 된다).
-- 남기는 것(#1163 엄격 검수 B3):
--   · msgr2_agent_sync의 새 본문 — 본체가 얼굴을 null로 보내도 저장한 얼굴을, 사람이 고친 직무를 지킨다. 종전 본문으로 되돌리면 다음 동기화가 사람이 고른 얼굴을 지운다(기억 데이터 보호).
--   · msgr2_agents.avatar_path·bio·role_by_user 칸과 그 값(사람이 고른 사진 경로·소개 — 지우면 사라진다. 칸이 남아도 옛 코드는 읽지 않는다).
-- 실행: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/rollback/20261025130000_msgr2_agent_look.down.sql   (파일 안의 begin/commit — -1 없이)
begin;
set local lock_timeout = '5s';
drop function if exists public.msgr2_agent_set_profile(uuid, jsonb);
commit;
