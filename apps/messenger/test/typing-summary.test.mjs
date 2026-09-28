// '입력 중' 요약(순수) — 유건 확정 2026-09-29: 1명 단독 문구 / 2명 이상은 가장 먼저 시작한 이름 + 외 N명,
// 스레드 말풍선은 3명까지 개별·4명부터 얼굴 4개로 묶은 말풍선 하나.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderByStart, typingSummary, typingLabelParams, shouldGroupTypingBubbles, typingBubbleFaces, BUBBLE_GROUP_THRESHOLD, BUBBLE_GROUP_FACES } from '../src/typing-summary.mjs';

const c = (id, startedAt, name = id) => ({ id, startedAt, name });

test('orderByStart — startedAt 오름차순, 동률이면 id순', () => {
  const ids = (l) => orderByStart(l).map((x) => x.id).join('');
  assert.equal(ids([c('b', 200), c('a', 100), c('c', 300)]), 'abc');
  assert.equal(ids([c('z', 100), c('a', 100)]), 'az', '동시 시작은 id 사전순');
});

test('typingSummary — 1명은 단독, 2명 이상은 첫 시작자 + 나머지 인원', () => {
  assert.deepEqual(typingSummary([c('오길비', 100)]), { first: c('오길비', 100), othersCount: 0 });
  const many = [c('B', 200), c('오길비', 100), ...Array.from({ length: 12 }, (_, i) => c(`x${i}`, 300 + i))];
  const s = typingSummary(many);
  assert.equal(s.first.id, '오길비', '가장 먼저 시작한 크루가 first');
  assert.equal(s.othersCount, 13, '14명 중 첫 1명 뺀 나머지');
  assert.deepEqual(typingSummary([]), { first: null, othersCount: 0 });
});

test('typingLabelParams — 단독은 msg.typing, 2명 이상은 msg.typing.others', () => {
  assert.deepEqual(typingLabelParams({ first: null, othersCount: 0 }), null);
  assert.deepEqual(typingLabelParams({ first: { name: '오길비' }, othersCount: 0 }), { key: 'msg.typing', vars: { name: '오길비' } });
  assert.deepEqual(typingLabelParams({ first: { name: '오길비' }, othersCount: 13 }), { key: 'msg.typing.others', vars: { name: '오길비', n: 13 } });
});

test('shouldGroupTypingBubbles — 3명까지 개별, 4명부터 그룹(BUBBLE_GROUP_THRESHOLD=4)', () => {
  assert.equal(BUBBLE_GROUP_THRESHOLD, 4);
  assert.equal(shouldGroupTypingBubbles(1), false);
  assert.equal(shouldGroupTypingBubbles(3), false);
  assert.equal(shouldGroupTypingBubbles(4), true);
  assert.equal(shouldGroupTypingBubbles(20), true);
});

test('typingBubbleFaces — 시작 순서대로 최대 4개(5명이어도 4개까지만, 유건 확정)', () => {
  assert.equal(BUBBLE_GROUP_FACES, 4);
  const five = [c('e', 500), c('a', 100), c('c', 300), c('b', 200), c('d', 400)];
  assert.deepEqual(typingBubbleFaces(five).map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(typingBubbleFaces([c('a', 1)]).map((x) => x.id), ['a']);
});

// 배선 — App.jsx가 실제로 이 모듈을 쓰는지(구현 뒤 이 블록만 통과하면 배선 완료)
test('배선 — Composer 상태줄·스레드 말풍선이 typing-summary를 쓴다, i18n 두 언어', () => {
  const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/typing-summary\.mjs'/, 'typing-summary import');
  assert.match(src, /typingLabelParams\(/, '요약 라벨 계산');
  assert.match(src, /shouldGroupTypingBubbles\(/, '그룹 여부 판정');
  assert.match(src, /typingBubbleFaces\(/, '그룹 말풍선 얼굴');
  const dict = readFileSync(new URL('../src/i18n.js', import.meta.url), 'utf8');
  assert.match(dict, /'msg\.typing\.others': \[["'][^"']+["'], ["'][^"']+["']\]/, 'msg.typing.others ko/en');
});
