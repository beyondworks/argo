-- 내 에이전트 그룹(유건 지시 2026-09-09 "그룹 만들 수 있게 하여 구분하여 볼 수 있도록"): 소유자가 자기 에이전트에 붙이는 폴더 이름. 레일이 이걸로 묶어 보인다.
-- 소유자만 바꾼다(기존 RLS msgr_crews_update_owner). 봇도 소유자(만든 관리자)가 붙일 수 있다.
alter table public.msgr_crews add column if not exists folder text check (folder is null or (length(folder) between 1 and 40 and folder !~ '[\n\r]'));
-- 레일 '추가순' 정렬용 — 기존 행은 마이그레이션 시각으로 채워진다(정확한 옛 순서는 남아 있지 않다).
alter table public.msgr_crews add column if not exists created_at timestamptz not null default now();
