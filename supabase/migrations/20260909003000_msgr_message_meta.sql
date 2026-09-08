-- 메시지 부가 정보(meta jsonb) — 크루 답글의 실행 궤적(trace: 사고 과정·도구 단계·경과·모델)을 싣는다.
-- 유건 요청 2026-09-09: 작업 중 상태·진행을 클로드코드·코덱스처럼 '사고 과정'·'도구 사용' 드롭다운으로 실시간·사후 열람.
-- 쓰기 = insert(브리지가 답글과 함께) 또는 작성자 본인 update(기존 정책). 읽기 = 채널 열람과 동일.
alter table public.msgr_messages add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.msgr_messages drop constraint if exists msgr_messages_meta_size;
alter table public.msgr_messages add constraint msgr_messages_meta_size check (pg_column_size(meta) <= 65536);
