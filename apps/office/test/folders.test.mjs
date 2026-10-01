// 폴더 보기(유건 9/30) — 기록 화면 네 개가 쓰는 묶기 규칙. 날짜는 한국(KST) 기준.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUMAN, folderKey, folderize, isoDay, dateBucket, byDate, journalDigest, fileGroup } from '../src/core/folders.js';

// 이유: 서버 시각은 UTC로 온다 — 한국 자정(UTC 15:00)을 기준으로 날짜가 바뀌어야 오늘/어제가 맞다.
test('isoDay: 한국 자정 직전·직후', () => {
  assert.equal(isoDay('2026-09-29T14:59:59Z'), '2026-09-29'); // KST 9/29 23:59:59
  assert.equal(isoDay('2026-09-29T15:00:00Z'), '2026-09-30'); // KST 9/30 00:00:00
  assert.equal(isoDay('2026-09-30T00:10:00+09:00'), '2026-09-30');
  assert.equal(isoDay(null), '');
  assert.equal(isoDay('아무 값'), '');
});

test('dateBucket: 오늘·어제·이번 주·이번 달·그 이전은 월별', () => {
  const today = '2026-09-30'; // 수요일 — 이번 주는 9/28(월)부터
  assert.equal(dateBucket('2026-09-30', today), 'today');
  assert.equal(dateBucket('2026-09-29', today), 'yesterday');
  assert.equal(dateBucket('2026-09-28', today), 'week');
  assert.equal(dateBucket('2026-09-27', today), 'month'); // 지난 일요일 = 이번 달이지만 이번 주는 아님
  assert.equal(dateBucket('2026-09-01', today), 'month');
  assert.equal(dateBucket('2026-08-31', today), 'm:2026-08');
  assert.equal(dateBucket('2025-12-31', today), 'm:2025-12');
});

test('dateBucket: 자정 경계는 isoDay와 맞물린다', () => {
  const today = isoDay('2026-09-29T15:00:00Z'); // KST 9/30 00:00
  assert.equal(dateBucket(isoDay('2026-09-29T14:59:59Z'), today), 'yesterday');
  assert.equal(dateBucket(isoDay('2026-09-29T15:00:00Z'), today), 'today');
});

// 이유: 월 초에는 "어제"·"이번 주"가 지난달에 걸친다 — 구간이 월보다 먼저다.
test('dateBucket: 월 경계', () => {
  assert.equal(dateBucket('2026-09-30', '2026-10-01'), 'yesterday'); // 10/1 목
  assert.equal(dateBucket('2026-09-28', '2026-10-01'), 'week'); // 같은 주 월요일(지난달)
  assert.equal(dateBucket('2026-09-27', '2026-10-01'), 'm:2026-09'); // 지난주 일요일
  assert.equal(dateBucket('2026-09-30', '2026-10-05'), 'm:2026-09'); // 10/5 월 — 이번 주는 오늘부터, 어제(일)가 지남
  assert.equal(dateBucket('2026-10-04', '2026-10-05'), 'yesterday');
  assert.equal(dateBucket('2026-10-03', '2026-10-05'), 'month');
});

test('dateBucket: 날짜를 모르거나 미래(시계 차이)면 오늘', () => {
  assert.equal(dateBucket('', '2026-09-30'), 'today');
  assert.equal(dateBucket('2026-10-01', '2026-09-30'), 'today');
});

test('byDate: 구간은 최근 먼저, 월 구간은 최근 달 먼저, 구간 안 순서는 유지', () => {
  const days = ['2026-07-02', '2026-09-30', '2026-08-15', '2026-09-29', '2026-09-30', '2026-09-10', '2026-09-28'];
  const groups = byDate(days.map((d, i) => ({ d, i })), (x) => x.d, '2026-09-30');
  assert.deepEqual(groups.map((g) => g.key), ['today', 'yesterday', 'week', 'month', 'm:2026-08', 'm:2026-07']);
  assert.deepEqual(groups[0].items.map((x) => x.i), [1, 4]);
});

// 이유: 사람이 붙여 넣은 파일(paste-….png)은 에이전트가 없다 — 한 폴더로 모은다.
test('folderKey: 에이전트 id → 이름만 → 사람', () => {
  assert.equal(folderKey('c1', '루나'), 'c1');
  assert.equal(folderKey(null, '루나'), 'name:루나');
  assert.equal(folderKey(null, ''), HUMAN);
  assert.equal(folderKey(undefined), HUMAN);
});

test('folderize: 건수와 최근 활동순, 에이전트 없는 항목은 사람 폴더', () => {
  const at = (iso) => Date.parse(iso);
  const items = [
    { id: 'a', crew: 'c1', at: '2026-09-30T01:00:00Z' },
    { id: 'b', crew: 'c2', at: '2026-09-30T03:00:00Z' },
    { id: 'c', crew: 'c1', at: '2026-09-29T01:00:00Z' },
    { id: 'd', crew: null, at: '2026-09-30T02:00:00Z' }, // paste-….png
  ];
  const f = folderize(items, (x) => folderKey(x.crew), (x) => at(x.at));
  assert.deepEqual(f.map((x) => [x.id, x.n]), [['c2', 1], [HUMAN, 1], ['c1', 2]]);
  assert.equal(f.find((x) => x.id === 'c1').latest.id, 'a');
});

test('journalDigest: 날짜마다 에이전트별 한 줄, 마지막 내용과 건수', () => {
  const e = (day, time, crew, text) => ({ day, time, crew, name: crew, text });
  const rows = journalDigest([
    e('2026-09-30', '09:00', 'c1', '첫'), e('2026-09-30', '11:00', 'c1', '마지막'), e('2026-09-30', '10:00', 'c2', '오토'),
    e('2026-09-29', '23:00', 'c1', '어제'),
  ], (x) => folderKey(x.crew));
  assert.deepEqual(rows.map((r) => [r.day, r.key, r.n, r.latest.text]), [
    ['2026-09-30', 'c1', 2, '마지막'], ['2026-09-30', 'c2', 1, '오토'], ['2026-09-29', 'c1', 1, '어제'],
  ]);
});

test('fileGroup: 이미지 · 문서 · 기타', () => {
  assert.equal(fileGroup('paste-1727.png'), 'image');
  assert.equal(fileGroup('quote.pdf'), 'doc');
  assert.equal(fileGroup('notes.md'), 'doc');
  assert.equal(fileGroup('pricing.xlsx'), 'doc');
  assert.equal(fileGroup('logo.svg'), 'other'); // svg는 미리보기하지 않는 파일
  assert.equal(fileGroup('build.zip'), 'other');
  assert.equal(fileGroup('x', 'image/jpeg'), 'image');
});
