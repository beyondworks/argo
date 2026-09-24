-- 에이전트 얼굴 모양·색 고르기(유건 확정 2026-09-24: "살아 있는 얼굴" + 소유자가 모양·색을 바꿀 수 있게).
-- 기본은 크루 id로 정하는 무작위 고정값(apps/messenger/src/crew-face.mjs faceOf) — 소유자가 이 열에 값을 저장하면
-- 조직 전원에게 같은 얼굴로 보인다. 값 자체(hex 색·svg path)는 서버에 없다 — 클라이언트 상수(FACE_SHAPES/FACE_COLORS/
-- FACE_EYES) 배열 인덱스만 저장·검증한다. 쓰기는 기존 소유자 update 정책(msgr_crews_update_owner, 20260903120000)을
-- 그대로 쓴다 — RPC를 새로 만들지 않는다. 잠금 트리거(msgr_lock_crews, 20260916210000)의 WHEN 절은 org_id·
-- owner_user_id·ws_id·slug·registered_at·hosting만 보므로 face 갱신은 건드리지 않는다(트리거 함수가 아예 안 돈다) —
-- 하트비트마다 commands를 통째로 다시 쓰던 TOAST-churn(2026-09-16)과 같은 함정이 없다.

alter table public.msgr_crews add column if not exists face jsonb;

alter table public.msgr_crews drop constraint if exists msgr_crews_face_shape;
alter table public.msgr_crews add constraint msgr_crews_face_shape check (
  face is null or coalesce( -- 열쇠 하나라도 없으면 위 비교가 NULL이 되고, coalesce 없이는 Postgres가 NULL을 통과시킨다(실측: eyes 누락이 통과했다)
    jsonb_typeof(face -> 'shape') = 'number' and (face ->> 'shape')::int between 0 and 5 and
    jsonb_typeof(face -> 'color') = 'number' and (face ->> 'color')::int between 0 and 9 and
    jsonb_typeof(face -> 'eyes')  = 'number' and (face ->> 'eyes')::int between 0 and 2 and
    (face - 'shape' - 'color' - 'eyes') = '{}'::jsonb, -- 잉여 키 금지(위장 페이로드 방지) — check 제약은 서브쿼리를 못 쓴다
    false
  )
);

comment on column public.msgr_crews.face is '소유자가 고른 얼굴 — {shape:0-5, color:0-9, eyes:0-2}(정수 인덱스). null이면 crew-face.mjs가 id로 무작위 고정값을 쓴다.';
