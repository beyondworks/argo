-- 즐겨찾기 순서(끌어서 정렬)와 채널 그룹(사용자별 폴더) — 유건 지시 2026-09-12 "고정 목록은 드래그로 순서, 그룹도".
alter table public.msgr_channel_prefs add column if not exists pin_pos integer, add column if not exists folder text;
