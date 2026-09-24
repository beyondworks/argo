// 에이전트 얼굴(유건 확정 2026-09-24: 평면 단색 도형 + 작은 눈, 입 없음, 모양·색은 무작위로 한 번 정해 유지, 메신저에만).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assignFaces, faceOf, crewFaceState, FACE_COLORS, FACE_SHAPES, DONE_MS } from '../src/crew-face.mjs';

const crew = (id, at) => ({ id, created_at: `2026-09-${String(at).padStart(2, '0')}T00:00:00Z` });
const org = Array.from({ length: 10 }, (_, i) => crew(`c${i}-${'x'.repeat(i)}`, i + 1));

test('무작위지만 고정 — 같은 크루는 언제 그려도 같은 얼굴(매번 바뀌면 누가 누군지 모른다)', () => {
  const a = assignFaces(org), b = assignFaces([...org].reverse());
  for (const c of org) assert.deepEqual(a[c.id], b[c.id], '입력 순서와 무관');
  assert.deepEqual(faceOf('없는-크루', {}), faceOf('없는-크루', {}), '목록 밖 크루도 id로 고정');
});

test('같은 조직 안에서는 색이 겹치지 않는다(10명까지) — 초안에서 셋이 같은 색이던 문제', () => {
  const f = assignFaces(org);
  assert.equal(new Set(org.map((c) => f[c.id].color)).size, FACE_COLORS.length);
  const six = assignFaces(org.slice(0, 6));
  assert.equal(new Set(Object.values(six).map((x) => x.shape)).size, Math.min(6, FACE_SHAPES.length), '도형도 6명까지는 서로 다르다');
});

test('새 크루가 들어와도 기존 크루 얼굴은 그대로 — 먼저 만든 크루부터 배정', () => {
  const before = assignFaces(org.slice(0, 5));
  const after = assignFaces([...org.slice(0, 5), crew('newcomer', 30)]);
  for (const c of org.slice(0, 5)) assert.deepEqual(after[c.id], before[c.id]);
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

test('배선 — 사진이 있으면 사진, 없으면 얼굴 / 배지 유지 / 사람은 그대로', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const av = src.slice(src.indexOf('function Av('), src.indexOf('/** 프로필 이미지 정규화'));
  assert.match(av, /url \? <img/, '사진 우선');
  assert.match(av, /crew \? <CrewFace/, '사진 없는 크루는 얼굴');
  assert.match(av, /className="star"/, '등급 배지 유지');
  assert.match(src, /assignFaces\(\[\.\.\.crews, \.\.\.myAvailable\]\)/, '조직 크루 전체(파견 전 포함)로 한 번 배정');
  assert.match(src, /<AvatarEdit name=\{crew\.display_name\} crew crewId=\{crew\.id\}/, '크루 카드의 편집 줄도 같은 얼굴(id 없이 그리면 이름 해시로 다른 색이 나왔다 — 실측)');
});
