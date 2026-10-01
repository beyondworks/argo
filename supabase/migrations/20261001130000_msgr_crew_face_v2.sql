-- 에이전트 얼굴 v2(유건 확정 시안 2026-10-01: 도형 12종·색 12색·표정) — msgr_crews.face의 check를 "옛 형태 또는 v2 형태"로 넓힌다.
-- 운영 행은 고쳐 쓰지 않는다: 옛 형태({shape 0~5, color 0~9, eyes 0~2}, 키 v 없음)는 그대로 두고 클라이언트(apps/messenger/src/crew-face.mjs
-- faceFromStored)가 그릴 때 대응표로 새 번호에 옮긴다. 새로 저장하는 값만 v2 형태 {v:2, shape 0~11, color 0~11}(faceToStore)다.
-- 두 형태 모두 잉여 키 금지(위장 페이로드 방지)는 그대로. 정수 판정은 jsonb 숫자 + 글자 모양(정규식)으로 한다 — ::int 형변환은 1.5·1e20 같은
-- 값에서 check 위반 대신 형변환 오류를 내 제약 이름 없이 실패했다. 옛 check가 받던 값(형변환 가능한 0~5 등)은 모두 정수 글자라 그대로 통과한다.
-- 쓰기 경로·권한은 바뀌지 않는다: 소유자 update 정책(msgr_crews_update_owner)과 관리자 정책의 face 보호(20260924170000)는 손대지 않는다.
-- 잠금 트리거(msgr_lock_crews)의 WHEN 절은 face를 보지 않으므로 이 제약 교체가 트리거·하트비트 쓰기량을 늘리지 않는다.

-- 제약 교체는 ACCESS EXCLUSIVE 잠금이다 — 하트비트·폴링이 잡고 있으면 5초 안에 포기하고 실패한다(대기열에 쌓여 msgr_crews 전체를 막지 않게, 검수 #789).
-- msgr-live-apply.sh는 psql -1(한 트랜잭션)로 적용하므로 set local이 이 파일 안에서만 유효하다. 실패하면 한가할 때 다시 적용한다.
set local lock_timeout = '5s';

alter table public.msgr_crews drop constraint if exists msgr_crews_face_shape;
alter table public.msgr_crews add constraint msgr_crews_face_shape check (
  face is null or case when jsonb_typeof(face) <> 'object' then false else coalesce( -- 객체가 아니면 먼저 거절 — CASE가 순서를 보장한다(그냥 and로 묶으면 '"face"' 같은 스칼라에서 face - 'shape'가 제약 위반 대신 'cannot delete from scalar' 오류를 냈다, PG 드릴 실측).
    -- 열쇠가 하나라도 없으면 비교가 NULL이 되고, coalesce 없이는 Postgres가 NULL을 통과시킨다(옛 마이그레이션 실측: eyes 누락이 통과했다)
    ( -- 옛 형태(2026-09-24) — 운영에 남아 있는 행
      jsonb_typeof(face -> 'shape') = 'number' and (face ->> 'shape') ~ '^[0-5]$' and
      jsonb_typeof(face -> 'color') = 'number' and (face ->> 'color') ~ '^[0-9]$' and
      jsonb_typeof(face -> 'eyes')  = 'number' and (face ->> 'eyes')  ~ '^[0-2]$' and
      (face - 'shape' - 'color' - 'eyes') = '{}'::jsonb
    ) or ( -- v2 형태(2026-10-01) — 도형 12 · 색 12
      jsonb_typeof(face -> 'v')     = 'number' and (face ->> 'v') = '2' and
      jsonb_typeof(face -> 'shape') = 'number' and (face ->> 'shape') ~ '^([0-9]|1[01])$' and
      jsonb_typeof(face -> 'color') = 'number' and (face ->> 'color') ~ '^([0-9]|1[01])$' and
      (face - 'v' - 'shape' - 'color') = '{}'::jsonb
    ),
    false
  ) end
);

comment on column public.msgr_crews.face is '소유자가 고른 얼굴 — v2 {v:2, shape:0-11, color:0-11} 또는 옛 형태 {shape:0-5, color:0-9, eyes:0-2}(클라이언트가 대응표로 그린다). null이면 crew-face.mjs가 id로 무작위 고정값을 쓴다.';
