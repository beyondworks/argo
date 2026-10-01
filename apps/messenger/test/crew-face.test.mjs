// 에이전트 얼굴 v2(유건 확정 시안 2026-10-01: 도형 12종·색 12색·표정 · 상태 6종 + 놀람 · 쉼 몸짓 8종).
// 모양·색은 크루 id에서 무작위로 정해 유지, 소유자가 고르면 msgr_crews.face에 {v:2, shape, color}로 저장.
// 옛 저장값({shape 0~5, color 0~9, eyes 0~2})은 운영 행을 고쳐 쓰지 않고 대응표로 그린다(시안 5절).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  faceOf, faceFromStored, faceToStore, faceInner, faceStill, crewFaceState, nextDoneIn, nextSurpriseIn, nextErrorIn, failedReplyCrew,
  gestureAt, gesturePhase, GESTURES, GESTURE_MS, GESTURE_GAP, FACE_COLORS, FACE_SHAPES, FACE_STATES, FACE_VERSION,
  LEGACY_SHAPE, LEGACY_COLOR, DONE_MS, SURPRISE_MS, ERROR_MS, FAILED_FRESH_MS,
} from '../src/crew-face.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('시안 정의 그대로 — 도형 12종·색 12색(레퍼런스 픽셀 값)', () => {
  assert.equal(FACE_SHAPES.length, 12);
  assert.deepEqual(FACE_COLORS, ['#FEA1CD', '#FE76B8', '#9F66C7', '#AE85D3', '#02A3FE', '#0061F0', '#02883F', '#02A552', '#FB5501', '#FD7400', '#FF9A00', '#FDB602']);
  assert.deepEqual(FACE_SHAPES.map((s) => s.color), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], '캐릭터 n의 기본 색 = 색 n');
  assert.deepEqual(FACE_SHAPES.map((s) => s.expr), ['smile', 'grin', 'soft', 'calm', 'calm', 'front', 'up', 'happy', 'half', 'peek', 'rest', 'side']);
  assert.deepEqual(FACE_STATES.sort(), ['ask', 'done', 'error', 'idle', 'off', 'surprise', 'work'], '상태 6종 + 놀람');
});

test('무작위지만 고정 — 얼굴은 크루 id만으로 정해지고 12도형·12색이 모두 나온다(검수 #698 H-1)', () => {
  assert.deepEqual(faceOf('crew-a'), faceOf('crew-a'));
  const ids = Array.from({ length: 600 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  assert.equal(new Set(ids.map((id) => faceOf(id).color)).size, FACE_COLORS.length, '색 12가지');
  assert.equal(new Set(ids.map((id) => faceOf(id).shape)).size, FACE_SHAPES.length, '도형 12가지');
  for (const id of ids.slice(0, 50)) assert.deepEqual(Object.keys(faceOf(id)).sort(), ['color', 'shape']);
});

test('옛 저장값 대응표 — 시안 5절(shape 0→0,1→2,2→4,3→10,4→8,5→3 / color 0→6,1→0,2→8,3→11,4→5,5→4,6→2,7→4,8→10,9→1), 옛 눈은 버린다', () => {
  assert.deepEqual(LEGACY_SHAPE, [0, 2, 4, 10, 8, 3]);
  assert.deepEqual(LEGACY_COLOR, [6, 0, 8, 11, 5, 4, 2, 4, 10, 1]);
  for (let s = 0; s < 6; s++) for (let c = 0; c < 10; c++) for (let e = 0; e < 3; e++)
    assert.deepEqual(faceFromStored({ shape: s, color: c, eyes: e }), { shape: LEGACY_SHAPE[s], color: LEGACY_COLOR[c] }, `옛 ${s}/${c}/${e}`);
  assert.ok(LEGACY_SHAPE.every((n) => n < FACE_SHAPES.length) && LEGACY_COLOR.every((n) => n < FACE_COLORS.length), '대응 결과는 새 범위 안');
  // 운영 12행 같은 옛 값은 그릴 때만 바뀐다 — faceOf가 같은 결과
  assert.deepEqual(faceOf('crew-old', { shape: 5, color: 9, eyes: 2 }), { shape: 3, color: 1 });
});

test('v2 저장값 — {v:2, shape 0~11, color 0~11}만 읽고, 못 읽으면 id 무작위로', () => {
  assert.deepEqual(faceFromStored({ v: 2, shape: 11, color: 0 }), { shape: 11, color: 0 });
  assert.deepEqual(faceFromStored({ v: 2, shape: 0, color: 11 }), { shape: 0, color: 11 });
  const id = 'crew-picked', rand = faceOf(id);
  for (const bad of [null, undefined, 'x', [], [1, 2], { v: 2, shape: 12, color: 0 }, { v: 2, shape: 0, color: 12 }, { v: 2, shape: -1, color: 0 }, { v: 2, shape: 1.5, color: 0 },
    { v: 2, shape: '1', color: 0 }, { v: 1, shape: 0, color: 0 }, { v: '2', shape: 0, color: 0 }, { v: 2, shape: 0 }, { shape: 6, color: 0, eyes: 0 }, { shape: 0, color: 10, eyes: 0 }]) {
    assert.equal(faceFromStored(bad), null, `못 읽는 값: ${JSON.stringify(bad)}`);
    assert.deepEqual(faceOf(id, bad), rand, `무작위 고정값으로: ${JSON.stringify(bad)}`);
  }
});

test('저장 모양 = v2 세 키 — 고르기 저장은 faceToStore를 거친다', () => {
  assert.deepEqual(faceToStore({ shape: 7, color: 3, eyes: 1, extra: 1 }), { v: FACE_VERSION, shape: 7, color: 3 });
  assert.equal(FACE_VERSION, 2);
  assert.match(read('../src/App.jsx'), /onSave\(faceToStore\(draft\)\)/);
});

test('서버 check 범위 = 클라이언트 배열 길이(20261001130000) — 도형·색을 늘리거나 줄이면 마이그레이션도 같이', () => {
  const sql = read('../../../supabase/migrations/20261001130000_msgr_crew_face_v2.sql');
  const v2 = sql.slice(sql.indexOf(') or ( -- v2'));
  const pat = (k, src) => new RegExp(src.match(new RegExp(`\\(face ->> '${k}'\\) ~ '([^']+)'`))[1]);
  const accepted = (re) => Array.from({ length: 30 }, (_, n) => n).filter((n) => re.test(String(n)));
  assert.deepEqual(accepted(pat('shape', v2)), [...FACE_SHAPES.keys()], 'v2 shape');
  assert.deepEqual(accepted(pat('color', v2)), [...FACE_COLORS.keys()], 'v2 color');
  assert.deepEqual(accepted(pat('shape', sql)), [...LEGACY_SHAPE.keys()], '옛 shape');
  assert.deepEqual(accepted(pat('color', sql)), [...LEGACY_COLOR.keys()], '옛 color');
  assert.match(v2, /face - 'v' - 'shape' - 'color'\) = '\{\}'::jsonb/, 'v2 잉여 키 금지');
  assert.match(sql, /face - 'shape' - 'color' - 'eyes'\) = '\{\}'::jsonb/, '옛 형태 잉여 키 금지');
  assert.doesNotMatch(sql, /update\s+public\.msgr_crews\s+set/i, '운영 행을 고쳐 쓰지 않는다');
});

test('상태 우선순위 — 준비 중 > 결재 대기 > 놀람(1초) > 오류(8초) > 완료(2초) > 오프라인 > 쉼', () => {
  const now = 1_000_000, live = { last_seen_at: new Date(now - 10_000).toISOString() }, away = { last_seen_at: new Date(now - 200_000).toISOString() };
  assert.equal(crewFaceState({ crew: live, now }), 'idle');
  assert.equal(crewFaceState({ crew: away, now }), 'off');
  assert.equal(crewFaceState({ crew: null, now }), 'idle', '크루 정보가 없으면 오프라인으로 단정하지 않는다');
  assert.equal(crewFaceState({ crew: away, working: true, erroredAt: now, now }), 'work', '다시 일을 시작하면 오류보다 준비 중');
  assert.equal(crewFaceState({ crew: live, asking: true, working: true, now }), 'work');
  assert.equal(crewFaceState({ crew: live, asking: true, surprisedAt: now, now }), 'ask');
  assert.equal(crewFaceState({ crew: live, surprisedAt: now, erroredAt: now, now }), 'surprise', '놀람이 오류보다 앞선다');
  assert.equal(crewFaceState({ crew: live, erroredAt: now, doneAt: now, now }), 'error', '오류가 완료보다 앞선다(실패한 답도 답이라 doneAt이 같이 찍힌다)');
  assert.equal(crewFaceState({ crew: away, erroredAt: now - ERROR_MS + 1, now }), 'error');
  assert.equal(crewFaceState({ crew: away, erroredAt: now - ERROR_MS, now }), 'off', '정확히 8초면 끝');
  assert.equal(crewFaceState({ crew: away, surprisedAt: now - SURPRISE_MS, now }), 'off');
  assert.equal(crewFaceState({ crew: away, doneAt: now - DONE_MS + 1, now }), 'done');
  assert.equal(crewFaceState({ crew: live, doneAt: now - DONE_MS, now }), 'idle');
});

test('완료·놀람·오류 타이머 — 가장 먼저 끝나는 크루 기준(검수 L-2), 같은 모양', () => {
  assert.equal(nextDoneIn({}, 5000), null);
  assert.equal(nextDoneIn({ a: 0, b: 1900 }, 1000), 1000);
  assert.equal(nextDoneIn({ a: 0 }, DONE_MS), null);
  assert.equal(nextSurpriseIn({ a: 0, b: 900 }, 500), 500);
  assert.equal(nextSurpriseIn({ a: 0 }, SURPRISE_MS), null);
  assert.equal(nextErrorIn({}, 1), null);
  assert.equal(nextErrorIn({ a: 0, b: 5000 }, 6000), ERROR_MS - 6000);
  assert.equal(nextErrorIn({ a: 0 }, ERROR_MS), null);
});

test('오류 판정 — 크루의 실패한 답(meta.failed)만, 사람이 누른 중단(stopped)·사람 글·묵은 글은 아님', () => {
  const now = Date.parse('2026-10-01T05:00:00Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const row = { author_kind: 'crew', crew_id: 'c1', meta: { failed: true }, created_at: at(1000) };
  assert.equal(failedReplyCrew(row, now), 'c1');
  assert.equal(failedReplyCrew({ ...row, meta: { stopped: true } }, now), null, '중단');
  assert.equal(failedReplyCrew({ ...row, meta: { failed: 'true' } }, now), null, '불리언만');
  assert.equal(failedReplyCrew({ ...row, author_kind: 'user' }, now), null);
  assert.equal(failedReplyCrew({ ...row, crew_id: null }, now), null);
  assert.equal(failedReplyCrew({ ...row, meta: null }, now), null);
  assert.equal(failedReplyCrew({ ...row, created_at: at(FAILED_FRESH_MS) }, now), null, '1분 지난 글');
  assert.equal(failedReplyCrew({ ...row, created_at: 'x' }, now), null);
  assert.equal(failedReplyCrew(null, now), null);
  // 게이트웨이가 실제로 이 표지를 남긴다 — 표지 이름이 바뀌면 오류 얼굴이 조용히 사라진다
  assert.match(read('../../../src/gateway/msgr.mjs'), /failed \? \{ failed: true \}/);
});

test('그림(faceInner) — 모든 도형·상태·크기에서 상수로만 만든 SVG, 몸짓 부품은 쉼에만', () => {
  for (let shape = 0; shape < 12; shape++) for (const state of FACE_STATES) for (const px of [20, 28, 40, 56, 96]) {
    const s = faceInner({ shape, color: (shape + 3) % 12 }, { state, px });
    assert.ok(s.startsWith('<g class="rig"><path class="body" d="') && s.endsWith('</g></g></g>'), `${shape}/${state}/${px}`);
    assert.ok(s.includes(`fill="${FACE_COLORS[(shape + 3) % 12]}"`), '몸 색');
    assert.doesNotMatch(s, /undefined|NaN|null/, `${shape}/${state}/${px}`);
    assert.equal(s.includes('class="grin"') && s.includes('class="yawn"'), state === 'idle', '웃음 짓기·하품 입은 쉼 얼굴에만');
  }
  assert.match(faceInner({ shape: 1, color: 1 }, { state: 'ask', px: 96 }), /class="swirl".*stroke="#FF6A13".*class="q"/, '결재 대기 = 소용돌이 + ?');
  assert.match(faceInner({ shape: 1, color: 1 }, { state: 'off', px: 32 }), /class="zzz"[^>]*opacity="0"[^>]*font-size="20"/, '오프라인 z, 작은 크기에서 글자 20');
  assert.match(faceInner({ shape: 0, color: 0 }, { px: 96 }), /stroke-width="3\.4"/);
  assert.match(faceInner({ shape: 0, color: 0 }, { px: 40 }), /stroke-width="5"/, '29~44px');
  assert.match(faceInner({ shape: 0, color: 0 }, { px: 22 }), /stroke-width="5\.8"/, '28px 이하');
  assert.equal(faceInner({ shape: 4, color: 2 }, { px: 28 }), faceInner({ shape: 4, color: 2 }, { px: 28 }), '같은 입력은 같은 문자열(메모)');
  assert.equal(faceInner({ shape: 99, color: 'x' }), faceInner({ shape: 0, color: 0 }), '범위 밖은 0번 캐릭터 기본값');
});

test('몸짓 계획 — 결정적, 간격 2~5초, 같은 몸짓 연속 없음, 8종 모두 나옴, 첫 시작 0.4~3.4초', () => {
  assert.deepEqual(GESTURES.map((g) => g.k), ['blink', 'look', 'tilt', 'bounce', 'wiggle', 'yawn', 'roll', 'smile']);
  assert.deepEqual(GESTURE_GAP, [2000, 5000]);
  const seen = new Set();
  let gaps = 0, minGap = Infinity, maxGap = 0;
  for (let c = 0; c < 80; c++) {
    const id = `crew-${c}`;
    assert.deepEqual(gestureAt(id, 3, 'blink'), gestureAt(id, 3, 'blink'), '같은 id·n·직전 → 같은 계획');
    const ph = gesturePhase(id); assert.ok(ph >= 400 && ph < 3400, `첫 시작 ${ph}`);
    let prev = null;
    for (let n = 0; n < 200; n++) {
      const { g, gap } = gestureAt(id, n, prev);
      assert.ok(g in GESTURE_MS, g);
      assert.notEqual(g, prev, `${id} n=${n} 같은 몸짓 연속`);
      assert.ok(gap >= 2000 && gap <= 5000, `간격 ${gap}`);
      assert.ok(gap > GESTURE_MS[g], '다음 몸짓 전에 지금 몸짓이 끝난다');
      minGap = Math.min(minGap, gap); maxGap = Math.max(maxGap, gap); gaps++;
      seen.add(g); prev = g;
    }
  }
  assert.equal(seen.size, 8, '8종 모두');
  assert.ok(minGap < 2100 && maxGap > 4900, `간격이 범위 전체에 퍼진다(${minGap}~${maxGap}, ${gaps}회)`);
  assert.notDeepEqual([0, 1, 2, 3, 4].map((n) => gestureAt('crew-a', n).g), [0, 1, 2, 3, 4].map((n) => gestureAt('crew-b', n).g), '크루마다 순서가 다르다');
});

test('CSS — 몸짓 8종 규칙이 모두 있고, 얼굴 애니메이션은 transform·opacity만, 동작 줄이기면 정지', () => {
  const css = read('../src/styles.css');
  for (const g of GESTURES) assert.match(css, new RegExp(`\\.msgr-face\\.s-idle\\[data-g="${g.k}"\\]`), g.k);
  const frames = [...css.matchAll(/@keyframes (msgr-face-[\w-]+) \{([\s\S]*?)\}\s*\}/g)];
  assert.ok(frames.length >= 20, `얼굴 keyframes ${frames.length}개`);
  for (const [, name, body] of frames) {
    const props = new Set([...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]));
    for (const p of props) assert.ok(p === 'transform' || p === 'opacity', `${name}: ${p}`);
  }
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.msgr-face, \.msgr-face \* \{ animation: none !important;/);
  assert.doesNotMatch(css, /\.msgr-face\.s-idle[^{]*\{[^}]*infinite/, '쉼 얼굴에 무한 반복 애니메이션 없음(몸짓은 data-g 동안 1회)');
  assert.doesNotMatch(css, /\.msgr-face(?:\.s-idle)?(?:\.idle-[abc])? \.[\w-]+ \{[^}]*var\(--face-dur/, '옛 CSS만의 상시 대기 애니메이션 제거');
});

test('배선 — 사진 → 얼굴 → 첫 글자, 배지 유지, 크루 id로, 몸짓은 앱 전체 스케줄러 하나', () => {
  const src = read('../src/App.jsx');
  const av = src.slice(src.indexOf('function Av('), src.indexOf('/** 프로필 이미지 정규화'));
  assert.match(av, /url \? <img[^:]*: crew \? <CrewFace/, '사진 → 얼굴 → 첫 글자 순서');
  assert.match(av, /className="star"/, '등급 배지 유지');
  assert.match(src, /<AvatarEdit name=\{crew\.display_name\} crew crewId=\{crew\.id\}/);
  assert.match(src, /crew=\{isCrew\} crewId=\{isCrew \? m\.crew_id : null\}/, '목록 밖 크루의 옛 글도 id로(검수 L-1)');
  assert.doesNotMatch(src, /assignFaces|faceGeometry|faceMotion|FACE_EYES|crew\.face\.eyes/, '옛 API·눈 고르기 제거');
  assert.match(src, /faceGestures\(\)/, '공유 스케줄러');
  assert.doesNotMatch(src, /createGestureScheduler|new IntersectionObserver\([^)]*face/i, '얼굴마다 관찰자·타이머를 만들지 않는다');
  const i18n = read('../src/i18n.js');
  assert.doesNotMatch(i18n, /'crew\.face\.eyes/, '눈 고르기 문구 제거');
});

test('오피스 — 같은 그림의 정지 얼굴(faceStill), 몸짓·상태 없음', () => {
  for (let shape = 0; shape < 12; shape++) for (const px of [12, 20, 32, 56]) {
    const still = faceStill({ shape, color: shape }, { px });
    assert.equal(still, faceInner({ shape, color: shape }, { px }).replace(/<g class="grin".*?<\/g><ellipse class="yawn"[^>]*\/>/, ''), `몸짓 부품만 뺀 같은 그림 ${shape}/${px}`);
    assert.doesNotMatch(still, /class="(grin|yawn)"/);
  }
  const face = read('../../office/src/ui/Face.jsx');
  assert.match(face, /faceStill\(face, \{ px: size \}\)/, '쉼 표정 하나');
  assert.doesNotMatch(face, /face-gestures|faceGestures|state:/, '몸짓·상태 표정 없음');
});
