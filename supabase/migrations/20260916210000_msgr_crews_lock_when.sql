-- msgr_crews 잠금 트리거에 WHEN 조건 — 하트비트마다 큰 열(commands)을 통째로 다시 쓰던 문제(2026-09-16 실측).
--
-- msgr_lock_cols() 는 to_jsonb(new) 로 행 전체를 풀어 읽는다. 그러면 Postgres 가 TOAST 된 commands(최대 ~6.5KB)까지
-- 새 행으로 다시 저장한다. last_seen 만 바꾸는 하트비트가 14만 회 쌓이며 TOAST 삽입 104만 회, 표 592kB → 817MB,
-- Disk IO 예산 소진·디스크 자동 확장으로 이어졌다(commands 를 실제로 바꾼 갱신은 35회).
--
-- WHEN 절은 트리거 함수를 부르기 전에 열 단위로 평가되므로 행 전체를 풀지 않는다. 잠금 열이 하나도 안 바뀌면
-- 함수는 어차피 new 를 그대로 돌려주므로 동작은 같다. 잠금 열이 바뀌면 지금처럼 함수가 돌아 막는다.
-- 임시 Postgres 재현: 트리거 있음 20회 갱신 TOAST 0.9MB→18MB / WHEN 절 0.9MB→0.9MB, 잠금 열 변경은 여전히 오류.
--
-- 잠금 열 목록은 라이브 정의(org_id, owner_user_id, ws_id, slug, registered_at, hosting)와 같다.
drop trigger if exists msgr_lock_crews on public.msgr_crews;
create trigger msgr_lock_crews before update on public.msgr_crews
  for each row
  when (old.org_id        is distinct from new.org_id
     or old.owner_user_id is distinct from new.owner_user_id
     or old.ws_id         is distinct from new.ws_id
     or old.slug          is distinct from new.slug
     or old.registered_at is distinct from new.registered_at
     or old.hosting       is distinct from new.hosting)
  execute function public.msgr_lock_cols('org_id', 'owner_user_id', 'ws_id', 'slug', 'registered_at', 'hosting');
