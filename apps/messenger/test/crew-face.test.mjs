// 에이전트 얼굴(유건 확정 2026-09-24: 평면 단색 도형 + 작은 눈, 입 없음, 모양·색은 무작위로 한 번 정해 유지, 메신저에만).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { faceOf, faceGeometry, crewFaceState, nextDoneIn, FACE_COLORS, FACE_SHAPES, DONE_MS } from '../src/crew-face.mjs';

test('무작위지만 고정 — 얼굴은 크루 id만으로 정해진다(보는 사람·목록·파견·해고와 무관, 검수 #698 H-1)', () => {
  assert.deepEqual(faceOf('crew-a'), faceOf('crew-a'));
  assert.equal(faceOf.length, 1, '목록 같은 두 번째 입력을 받지 않는다 — 목록이 달라져도 얼굴이 바뀔 길이 없다');
  const ids = Array.from({ length: 400 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(new Set(ids.map((id) => faceOf(id).color)).size, FACE_COLORS.length, '색 10가지가 모두 나온다(무작위 분포)');
  assert.equal(new Set(ids.map((id) => faceOf(id).shape)).size, FACE_SHAPES.length, '도형 6가지가 모두 나온다');
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

test('상태 우선순위 — 준비 중 > 결재 대기 > 완료(답 뒤 2초) > 오프라인 > 쉼', () => {
  const now = 1_000_000, live = { last_seen_at: new Date(now - 10_000).toISOString() }, away = { last_seen_at: new Date(now - 200_000).toISOString() };
  assert.equal(crewFaceState({ crew: live, now }), 'idle');
  assert.equal(crewFaceState({ crew: away, now }), 'off');
  assert.equal(crewFaceState({ crew: null, now }), 'idle', '크루 정보가 없으면 오프라인으로 단정하지 않는다');
  assert.equal(crewFaceState({ crew: away, working: true, now }), 'work', '일하는 중이면 하트비트가 늦어도 준비 중');
  assert.equal(crewFaceState({ crew: live, asking: true, working: true, now }), 'work');
  assert.equal(crewFaceState({ crew: live, asking: true, doneAt: now, now }), 'ask');
  assert.equal(crewFaceState({ crew: away, doneAt: now - DONE_MS + 1, now }), 'done');
  assert.equal(crewFaceState({ crew: live, doneAt: now - DONE_MS, now }), 'idle', '2초가 지나면 쉼');
});

test('완료 타이머 — 가장 먼저 끝나는 크루 기준이라 뒤에 답한 크루가 앞 크루의 완료를 늘리지 않는다(검수 L-2)', () => {
  assert.equal(nextDoneIn({}, 5000), null);
  assert.equal(nextDoneIn({ a: 0, b: 1900 }, 1000), 1000, 'a는 1초 남음 — b(2.9초)를 기다리지 않는다');
  assert.equal(nextDoneIn({ a: 0 }, DONE_MS), null, '정확히 2초면 끝');
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
