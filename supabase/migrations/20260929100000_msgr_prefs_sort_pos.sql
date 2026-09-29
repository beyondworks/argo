-- 채팅 탭(DM)·"내 에이전트" 레일의 '직접 배치' 순서 — 유건 확정 2026-09-29.
-- 기존 pin_pos(즐겨찾기 전용 순서)와 별개로, 목록 전체를 사용자가 끌어서 정한 순서(sort_pos)를 저장한다.
-- 새 RLS 정책은 필요 없다 — 두 테이블 모두 이미 "본인 행만"(user_id = auth.uid()) 정책이 select/insert/update를 덮는다.
alter table public.msgr_channel_prefs add column if not exists sort_pos integer;
alter table public.msgr_target_prefs add column if not exists sort_pos integer;
