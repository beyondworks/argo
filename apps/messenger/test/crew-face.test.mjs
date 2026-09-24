// 에이전트 얼굴(유건 확정 2026-09-24: 평면 단색 도형 + 작은 눈, 입 없음, 모양·색은 무작위로 한 번 정해 유지, 메신저에만.
// 살아 있는 얼굴 — 대기 중 움직임(CSS만, faceMotion), 졸음, 놀람(멘션·수신 1초), 소유자가 고른 모양·색 저장(override)).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faceOf, faceGeometry, crewFaceState, nextDoneIn, nextSurpriseIn, faceMotion, FACE_COLORS, FACE_SHAPES, FACE_EYES, DONE_MS, SURPRISE_MS, faceToStore } from '../src/crew-face.mjs';

test('무작위지만 고정 — 얼굴은 크루 id만으로 정해진다(보는 사람·목록·파견·해고와 무관, 검수 #698 H-1)', () => {
  assert.deepEqual(faceOf('crew-a'), faceOf('crew-a'));
  const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(new Set(ids.map((id) => faceOf(id).color)).size, FACE_COLORS.length, '색 10가지가 모두 나온다(무작위 분포)');
  assert.equal(new Set(ids.map((id) => faceOf(id).shape)).size, FACE_SHAPES.length, '도형 6가지가 모두 나온다');
});

test('소유자가 고른 얼굴(override) — 저장값이 있으면 쓰고 없으면 id 무작위, 범위 밖은 무시', () => {
  const id = 'crew-picked';
  const rand = faceOf(id);
  assert.deepEqual(faceOf(id, null), rand, 'override 없음 → 무작위 고정값');
  assert.deepEqual(faceOf(id, { shape: 3, color: 7, eyes: 1 }), { ...rand, shape: 3, color: 7, eyes: 1 }, '자리(spot)는 그대로, 모양·색·눈만 override');
  for (const bad of [{ shape: -1, color: 0, eyes: 0 }, { shape: 6, color: 0, eyes: 0 }, { shape: 0, color: 10, eyes: 0 }, { shape: 0, color: 0, eyes: 3 }, { shape: 1.5, color: 0, eyes: 0 }, { shape: '1', color: 0, eyes: 0 }])
    assert.deepEqual(faceOf(id, bad), rand, `범위 밖 override는 무시: ${JSON.stringify(bad)}`);
});

test('얼굴 자리는 모든 조합에서 도형 안 — 알약·말풍선·캡슐 제한', () => {
  for (let shape = 0; shape < FACE_SHAPES.length; shape++) for (let spot = 0; spot < 6; spot++) {
    const g = faceGeometry({ color: 0, shape, eyes: 0, spot });
    assert.ok(g.L - 5 >= 6 && g.R + 5 <= 94, `가로 ${shape}/${spot}: ${g.L}~${g.R}`);
    if (shape === 3) assert.ok(g.cy >= 44 && g.cy <= 72, `알약 세로 ${spot}: ${g.cy}`);
    if (shape === 5) assert.ok(g.cy <= 60, `말풍선 꼬리 위 ${spot}: ${g.cy}`);
    if (shape === 1) assert.ok(g.L >= 30 && g.R <= 70, `캡슐 폭 ${spot}: ${g.L}~${g.R}`);
  }
});

test('상태 우선순위 — 준비 중 > 결재 대기 > 놀람(멘션·수신 1초) > 완료(답 뒤 2초) > 오프라인 > 쉼', () => {
  const now = 1_000_000, live = { last_seen_at: new Date(now - 10_000).toISOString() }, away = { last_seen_at: new Date(now - 200_000).toISOString() };
  assert.equal(crewFaceState({ crew: live, now }), 'idle');
  assert.equal(crewFaceState({ crew: away, now }), 'off');
  assert.equal(crewFaceState({ crew: null, now }), 'idle', '크루 정보가 없으면 오프라인으로 단정하지 않는다');
  assert.equal(crewFaceState({ crew: away, working: true, now }), 'work', '일하는 중이면 하트비트가 늦어도 준비 중');
  assert.equal(crewFaceState({ crew: live, asking: true, working: true, now }), 'work');
  assert.equal(crewFaceState({ crew: live, asking: true, surprisedAt: now, now }), 'ask', '결재 대기가 놀람보다 앞선다');
  assert.equal(crewFaceState({ crew: live, surprisedAt: now, doneAt: now, now }), 'surprise', '놀람이 완료보다 앞선다');
  assert.equal(crewFaceState({ crew: away, surprisedAt: now - SURPRISE_MS + 1, now }), 'surprise', '1초가 지나기 전');
  assert.equal(crewFaceState({ crew: away, surprisedAt: now - SURPRISE_MS, now }), 'off', '정확히 1초면 끝');
  assert.equal(crewFaceState({ crew: live, asking: true, doneAt: now, now }), 'ask');
  assert.equal(crewFaceState({ crew: away, doneAt: now - DONE_MS + 1, now }), 'done');
  assert.equal(crewFaceState({ crew: live, doneAt: now - DONE_MS, now }), 'idle', '2초가 지나면 쉼');
});

test('완료 타이머 — 가장 먼저 끝나는 크루 기준이라 뒤에 답한 크루가 앞 크루의 완료를 늘리지 않는다(검수 L-2)', () => {
  assert.equal(nextDoneIn({}, 5000), null);
  assert.equal(nextDoneIn({ a: 0, b: 1900 }, 1000), 1000, 'a는 1초 남음 — b(2.9초)를 기다리지 않는다');
  assert.equal(nextDoneIn({ a: 0 }, DONE_MS), null, '정확히 2초면 끝');
});

test('놀람 타이머 — doneAt과 같은 모양·같은 만료 로직(App.jsx가 같은 effect를 재사용)', () => {
  assert.equal(nextSurpriseIn({}, 5000), null);
  assert.equal(nextSurpriseIn({ a: 0, b: 900 }, 500), 500, 'a가 먼저 끝난다');
  assert.equal(nextSurpriseIn({ a: 0 }, SURPRISE_MS), null, '정확히 1초면 끝');
});

test('대기 애니메이션 변수 — 크루마다 결정적이고, 대체로 서로 달라 동시에 움직이지 않는다(faceMotion)', () => {
  const ids = Array.from({ length: 60 }, (_, i) => `crew-motion-${i}`);
  const motions = ids.map((id) => faceMotion(id));
  assert.deepEqual(faceMotion('crew-motion-0'), faceMotion('crew-motion-0'), '같은 id는 같은 박자');
  for (const m of motions) {
    const dur = Number.parseFloat(m.duration); assert.ok(dur >= 4 && dur <= 12, `주기는 4~12초: ${m.duration}`);
    const delay = Number.parseFloat(m.delay); assert.ok(delay <= 0 && delay >= -dur, `시작 위치는 음수 delay(0~-주기): ${m.delay}`);
    assert.ok(['a', 'b', 'c'].includes(m.variant), `keyframes 세 벌 중 하나: ${m.variant}`);
  }
  assert.ok(new Set(motions.map((m) => m.duration)).size > 1, '크루마다 주기가 갈린다');
  assert.ok(new Set(motions.map((m) => m.variant)).size > 1, '크루마다 keyframes 묶음도 갈린다');
});

test('배선 — 사진이 있으면 사진, 없으면 얼굴 / 배지 유지 / 크루 id가 있는 자리는 모두 id로', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const av = src.slice(src.indexOf('function Av('), src.indexOf('/** 프로필 이미지 정규화'));
  assert.match(av, /url \? <img[^:]*: crew \? <CrewFace/, '사진 → 얼굴 → 첫 글자 순서');
  assert.match(av, /className="star"/, '등급 배지 유지');
  assert.match(src, /<AvatarEdit name=\{crew\.display_name\} crew crewId=\{crew\.id\}/, '크루 카드 편집 줄(id 없이 그리면 이름 해시로 다른 색이 나왔다 — 실측)');
  assert.match(src, /crew=\{isCrew\} crewId=\{isCrew \? m\.crew_id : null\}/, '목록 밖 크루의 옛 글도 id로(검수 L-1)');
  assert.doesNotMatch(src, /assignFaces/, '목록 기반 배정은 없앴다');
});

test('저장값은 서버 check가 허용하는 세 키뿐 — 얼굴 자리(spot)를 보내면 라이브 DB가 거절한다(화면 확인 중 발견)', () => {
  assert.deepEqual(Object.keys(faceToStore(faceOf('crew-x'))).sort(), ['color', 'eyes', 'shape']);
  const mig = readFileSync(new URL('../../../supabase/migrations/20260924170000_msgr_crew_face.sql', import.meta.url), 'utf8');
  assert.match(mig, /face - 'shape' - 'color' - 'eyes'/, '서버가 세 키 외에는 거절한다는 전제');
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /onSave\(faceToStore\(draft\)\)/, '고르기 저장은 faceToStore를 거친다');
});

test('서버 check 범위 = 클라이언트 배열 길이 — 도형·색·눈을 늘리거나 줄이면 마이그레이션도 같이 바꿔야 한다(검수 #704)', () => {
  const sql = readFileSync(new URL('../../../supabase/migrations/20260924170000_msgr_crew_face.sql', import.meta.url), 'utf8');
  const upper = (k) => Number(sql.match(new RegExp(`'${k}'\\)::int between 0 and (\\d+)`))?.[1]);
  assert.equal(upper('shape'), FACE_SHAPES.length - 1);
  assert.equal(upper('color'), FACE_COLORS.length - 1);
  assert.equal(upper('eyes'), FACE_EYES.length - 1);
});
