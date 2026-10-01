// 점검 A·B #1 — 조직이 없고 마지막 공간 기록도 없는 사용자의 시작 공간이 null(빈 조직 화면)이 되던 결함.
// 개인 공간에 대화나 친구가 있으면 거기서 시작하고, 아무것도 없는 새 사용자는 "새 조직·초대 코드" 안내(null)를 그대로 본다.
// 조직이 있는 사용자의 기존 규칙(지금 공간 유지 → 마지막 공간 → 첫 조직)은 바꾸지 않는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickStartSpace, needsPersonalProbe } from '../src/start-space.mjs';

const P = '__personal__';
const pick = (o) => pickStartSpace({ personal: P, orgIds: [], last: null, cur: null, personalHasContent: false, ...o });

test('조직 없음 + 마지막 공간 없음 + 개인 공간에 대화·친구가 있으면 개인 공간으로 시작한다', () => {
  assert.equal(pick({ personalHasContent: true }), P);
});

test('조직 없음 + 아무 기록도 없는 새 사용자는 null(새 조직·초대 안내) — 빈 개인 공간으로 보내지 않는다', () => {
  assert.equal(pick({ personalHasContent: false }), null);
});

test('조직이 있으면 개인 공간 내용과 상관없이 기존 규칙 그대로 — 첫 조직', () => {
  assert.equal(pick({ orgIds: ['a', 'b'], personalHasContent: true }), 'a');
});

test('지금 공간이 있으면 유지: 개인 공간·살아 있는 조직', () => {
  assert.equal(pick({ cur: P, orgIds: ['a'] }), P);
  assert.equal(pick({ cur: 'b', orgIds: ['a', 'b'] }), 'b');
});

test('지금 공간이 사라진 조직이면 마지막 공간 → 첫 조직 순으로 물러난다', () => {
  assert.equal(pick({ cur: 'gone', orgIds: ['a', 'b'], last: 'b' }), 'b');
  assert.equal(pick({ cur: 'gone', orgIds: ['a', 'b'], last: 'zzz' }), 'a');
  assert.equal(pick({ cur: 'gone', orgIds: [], last: P }), P);
});

test('마지막 공간이 개인 공간이면 조직이 있어도 거기서 연다(종전 규칙)', () => {
  assert.equal(pick({ orgIds: ['a'], last: P }), P);
});

test('개인 공간 내용 조회는 정말 필요할 때만 — 조직이 없고 마지막 공간이 없고 지금 공간도 없을 때뿐', () => {
  assert.equal(needsPersonalProbe({ cur: null, orgIds: [], last: null }), true);
  assert.equal(needsPersonalProbe({ cur: P, orgIds: [], last: null }), false, '이미 개인 공간');
  assert.equal(needsPersonalProbe({ cur: null, orgIds: ['a'], last: null }), false, '조직이 있다');
  assert.equal(needsPersonalProbe({ cur: null, orgIds: [], last: P }), false, '마지막 공간이 있다');
});

test('마지막 공간이 나간(지금 목록에 없는) 조직이면 기록이 없는 것으로 본다 — 개인 공간 확인 조회를 하고 개인 공간으로 시작한다', () => {
  assert.equal(needsPersonalProbe({ cur: null, orgIds: [], last: 'left-org' }), true);
  assert.equal(pick({ orgIds: [], last: 'left-org', personalHasContent: true }), P);
  assert.equal(pick({ orgIds: [], last: 'left-org', personalHasContent: false }), null, '아무 것도 없으면 새 사용자 안내');
  assert.equal(needsPersonalProbe({ cur: null, orgIds: ['a'], last: 'left-org' }), false, '조직이 있으면 조회 없이 첫 조직');
  assert.equal(pick({ orgIds: ['a'], last: 'left-org' }), 'a');
});
