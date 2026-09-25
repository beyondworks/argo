// 메시지 보낸 시각 표시(피드백 4, 2026-09-21 요청 — 2026-09-24 재검수 LOW: 작년 날짜엔 연도 표기).
//
// fmtMsgTime은 순수 함수(React 훅·JSX 의존 없음)라 실제로 호출해 값을 확인한다(app/i18n.jsx는
// 'use client' JSX 파일이라 plain node ESM이 .jsx를 못 읽으므로, 함수 소스만 정규식으로 뽑아
// new Function으로 격리 실행 — 문자열 매칭이 아니라 진짜 실행 결과를 단언한다).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const i18nSrc = readFileSync(join(ROOT, 'app/i18n.jsx'), 'utf8');
const m = /export function fmtMsgTime\(lang, ts\) \{[\s\S]*?\n\}/.exec(i18nSrc);
assert.ok(m, 'fmtMsgTime 함수를 소스에서 못 찾음 — 이름·시그니처가 바뀌었을 수 있다');
const fnSrc = m[0].replace(/^export /, '');
// eslint-disable-next-line no-new-func
const fmtMsgTime = new Function(`${fnSrc}\nreturn fmtMsgTime;`)();

test('오늘 날짜는 시:분만(날짜 없음)', () => {
  const now = new Date();
  const out = fmtMsgTime('ko', now.getTime());
  assert.doesNotMatch(out, /\d{4}/, '오늘이면 연도 숫자가 없어야 한다');
  assert.match(out, /\d{1,2}:\d{2}/, '시:분 형태');
});

test('올해의 다른 날짜는 월·일만(연도 없음)', () => {
  const now = new Date();
  const jan2 = new Date(now.getFullYear(), 0, 2, 15, 30);
  if (jan2.toDateString() === now.toDateString()) return; // 1/2 실행 회피(현실적으로 발생 안 함)
  const out = fmtMsgTime('ko', jan2.getTime());
  assert.doesNotMatch(out, new RegExp(String(now.getFullYear())), '올해면 연도를 안 붙인다');
});

test('작년 날짜는 연도를 붙인다(재검수 LOW)', () => {
  const now = new Date();
  const lastYear = new Date(now.getFullYear() - 1, 5, 15, 9, 5);
  const out = fmtMsgTime('ko', lastYear.getTime());
  assert.match(out, new RegExp(String(now.getFullYear() - 1)), `작년(${now.getFullYear() - 1})이 표시에 있어야 한다(실제: ${out})`);
});

test('영어 로캘은 쉼표로 날짜·시간을 구분한다(오늘이 아닐 때)', () => {
  const now = new Date();
  const lastYear = new Date(now.getFullYear() - 1, 2, 3, 14, 0);
  const out = fmtMsgTime('en', lastYear.getTime());
  assert.match(out, /,/, '영어 표시는 날짜와 시간 사이 쉼표');
  assert.match(out, new RegExp(String(now.getFullYear() - 1)));
});

test('ts가 없으면 빈 문자열(렌더 조건 {m.ts && …}과 짝) — 잘못된 값도 조용히 빈 문자열', () => {
  assert.equal(fmtMsgTime('ko', 0), '');
  assert.equal(fmtMsgTime('ko', null), '');
  assert.equal(fmtMsgTime('ko', NaN), '');
});
