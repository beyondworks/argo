-- [O2 후속·분리 검수 F7] 유실 대사 쿨다운을 DB로 — 프로세스 메모리 Map은 Fly 머신 N대·재배포마다
-- 리셋돼 같은 사용자가 인스턴스를 갈아타며 LS API를 N배 호출할 수 있었다. entitlements에 시각을
-- 기록해 인스턴스 간 공유 쿨다운으로 바꾼다. 쓰기는 서버(서비스 롤)뿐 — 사용자 정책(own select)은
-- select 전용이라 사용자가 컬럼을 조작해 대사를 유발·차단할 수 없다.
--
-- 컬럼을 둘로 나누는 이유(오류 ≠ 부정 결과):
--  - ls_reconciled_at: 마지막 대사 **시도** 시각. 성패 무관 시도 전에 선점 기록(10분 게이트) —
--    LS 장애 때 연타를 막되, 장애가 걷히면 10분 뒤 재시도돼 유실 결제자가 오래 잠기지 않는다.
--  - ls_reconcile_empty_at: 마지막 "활성 구독 없음" **확정** 시각(24시간 게이트) — 부정 결과 캐싱.
--    활성 구독이 없는 무료 사용자를 10분마다 영구 조회하던 것(실제 호출량의 대부분)을 끊는다.
--    LS 오류 경로는 이 컬럼을 건드리지 않는다(확정이 아니므로).
alter table public.entitlements add column if not exists ls_reconciled_at timestamptz;
alter table public.entitlements add column if not exists ls_reconcile_empty_at timestamptz;
