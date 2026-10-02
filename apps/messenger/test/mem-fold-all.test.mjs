// 기억 탭 '모두 접기 / 모두 펼치기'(유건 2026-10-02) — 기존 접기 저장 방식(localStorage 'argo-msgr-mem-fold', 키 = 조직 id:폴더) 그대로.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldAll, allFolded } from '../src/collapse-set.mjs';

const keys = ['org:rules', 'ch:c1'];

test('모두 접기 — 이 조직의 보이는 폴더를 전부 접힘으로, 다른 조직 값은 그대로', () => {
  const next = foldAll({ 'o2:org:rules': true }, 'o1', keys, true);
  assert.deepEqual(next, { 'o2:org:rules': true, 'o1:org:rules': true, 'o1:ch:c1': true });
});

test('모두 펼치기 — 이 조직의 보이는 폴더 접힘을 지운다', () => {
  const next = foldAll({ 'o1:org:rules': true, 'o1:ch:c1': true, 'o1:ch:gone': true, 'o2:ch:c1': true }, 'o1', keys, false);
  assert.deepEqual(next, { 'o1:ch:gone': true, 'o2:ch:c1': true });
});

test('버튼 상태 — 보이는 폴더가 전부 접혔을 때만 "모두 펼치기"', () => {
  assert.equal(allFolded({ 'o1:org:rules': true, 'o1:ch:c1': true }, 'o1', keys), true);
  assert.equal(allFolded({ 'o1:org:rules': true }, 'o1', keys), false);
  assert.equal(allFolded({}, 'o1', []), false, '폴더가 없으면 접힘이 아니다');
});

test('원본을 바꾸지 않는다', () => {
  const cur = { 'o1:org:rules': true };
  foldAll(cur, 'o1', keys, false);
  assert.deepEqual(cur, { 'o1:org:rules': true });
});
