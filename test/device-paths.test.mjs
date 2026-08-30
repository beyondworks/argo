// 기기 종속 절대경로 감지 — 루틴 이식성 안내(윈도 실기기 관찰 2026-08-30)의 판정 함수를 잠근다.
// 안내는 비차단이라 오탐이 더 해롭다(늑대 소년화) — 비감지 케이스를 감지만큼 촘촘히 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDevicePaths } from '../src/device-paths.mjs';

test('감지 — 맥·리눅스·윈도 드라이브·UNC 절대경로', () => {
  assert.deepEqual(detectDevicePaths('매일 /Users/yoogeon/scripts/notion_reminders.py 실행'), ['/Users/yoogeon/scripts/notion_reminders.py']);
  assert.equal(detectDevicePaths('cat /home/kim/data.csv 후 요약')[0], '/home/kim/data.csv');
  assert.equal(detectDevicePaths('read C:\\Users\\beyon\\Desktop\\todo.txt')[0], 'C:\\Users\\beyon\\Desktop\\todo.txt');
  assert.equal(detectDevicePaths('\\\\nas\\share\\report.xlsx 열기')[0], '\\\\nas\\share\\report.xlsx');
  assert.equal(detectDevicePaths('외장 /Volumes/Backup/db.sqlite 점검')[0], '/Volumes/Backup/db.sqlite');
});

test('비감지 — URL·상대경로·회사 폴더 경로·일반 문장 (오탐 = 늑대 소년)', () => {
  assert.deepEqual(detectDevicePaths('https://example.com/Users/docs/guide 참고'), [], 'URL 속 /Users/는 경로가 아니다');
  assert.deepEqual(detectDevicePaths('https://drive.example.com/view?path=/Users/leak/file 를 열어'), [], 'URL 쿼리(=) 속 경로도 오탐 금지 — 전처리의 실효 케이스');
  assert.deepEqual(detectDevicePaths('notes/주간 보고.md 를 갱신하고 vault/journal 에 기록'), []);
  assert.deepEqual(detectDevicePaths('산출물은 skills/captain-rules.md 형식으로'), []);
  assert.deepEqual(detectDevicePaths('오늘 뉴스 3건을 요약해줘'), []);
  assert.deepEqual(detectDevicePaths(''), []);
  assert.deepEqual(detectDevicePaths(null), []);
});

test('여러 개 — 중복 제거·최대 3개 예시', () => {
  const r = detectDevicePaths('/Users/a/x 그리고 /Users/a/x 또 /home/b/y, C:\\c\\z, /Volumes/d/w');
  assert.equal(r.length, 3);
  assert.deepEqual(r.slice(0, 2), ['/Users/a/x', '/home/b/y']);
});

test('경계 — 인용부호·괄호·등호 뒤의 경로도 잡는다', () => {
  assert.equal(detectDevicePaths('script="/Users/me/run.sh" 실행')[0], '/Users/me/run.sh');
  assert.equal(detectDevicePaths('(C:\\tools\\run.bat)')[0], 'C:\\tools\\run.bat');
});
