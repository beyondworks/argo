// 채팅 목록 시각 — "월" 한 글자는 무슨 뜻인지 바로 안 읽혔다(2026-09-29 모바일 점검). 카카오톡·라인처럼 오늘=시각, 어제, 그 밖=월·일.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDmWhen } from '../src/list-when.mjs';

const now = new Date(2026, 8, 29, 10, 0).getTime();
const at = (y, mo, d, h = 9, mi = 5) => new Date(y, mo, d, h, mi).getTime();

test('오늘은 대화 글과 같은 시각 표기', () => {
  assert.equal(fmtDmWhen(at(2026, 8, 29, 0, 47), 'ko', now), new Date(at(2026, 8, 29, 0, 47)).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }));
});

test('어제는 "어제", 영어는 Yesterday — 자정 직전도 어제', () => {
  assert.equal(fmtDmWhen(at(2026, 8, 28, 23, 59), 'ko', now), '어제');
  assert.equal(fmtDmWhen(at(2026, 8, 28, 0, 1), 'en', now), 'Yesterday');
});

test('그저께부터는 월·일, 해가 다르면 연도까지', () => {
  assert.equal(fmtDmWhen(at(2026, 8, 27), 'ko', now), '9월 27일');
  assert.equal(fmtDmWhen(at(2026, 8, 27), 'en', now), 'Sep 27');
  assert.equal(fmtDmWhen(at(2025, 11, 31), 'ko', now), '2025. 12. 31.');
});
