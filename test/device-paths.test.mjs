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
  // 등호 **단독** 경계(검수 LOW-7: 인용부호가 겹치면 = 단언이 죽은 커버리지였다)
  assert.equal(detectDevicePaths('path=/Users/me/run.sh 실행')[0], '/Users/me/run.sh');
  // 줄 시작(개행 뒤) 불릿 경로 — 경계의 \s가 개행을 커버한다(잉여 m 플래그 제거의 근거)
  assert.equal(detectDevicePaths('할 일:\nC:\\jobs\\daily.bat 실행')[0], 'C:\\jobs\\daily.bat');
});

test('검수 반영 — file:// 는 경로로 살리고, C:/ 표기 감지, 정규식 표기(\\d+)는 UNC 오탐 아님', () => {
  assert.equal(detectDevicePaths('file:///Users/me/report.md 열어')[0], '/Users/me/report.md', 'file://는 가장 확실한 기기 종속 경로');
  assert.equal(detectDevicePaths('read C:/Users/beyon/Desktop/todo.txt')[0], 'C:/Users/beyon/Desktop/todo.txt', '윈도 정방향 슬래시 표기');
  // 재검수 지적 2: 리터럴 역슬래시 1개는 옛 패턴에도 안 걸리던 죽은 단언 — 런타임 역슬래시 2개로 오탐을 실재현
  assert.deepEqual(detectDevicePaths('숫자는 정규식 "\\\\d+" 로 뽑아줘'), [], '역슬래시 정규식 표기는 UNC가 아니다');
  assert.deepEqual(detectDevicePaths('줄바꿈은 \\\\n 으로 표기'), []);
  assert.equal(detectDevicePaths('\\\\nas\\share\\report.xlsx')[0], '\\\\nas\\share\\report.xlsx', '진짜 UNC(호스트\\공유)는 여전히 감지');
  // 재검수 지적 3·4: 드라이브형 file:// 감지 + 원격 URL 쿼리 속 file://는 URL째 제거(쪼개짐 오탐 금지)
  assert.equal(detectDevicePaths('file:///C:/Users/beyon/todo.txt 열어')[0], 'C:/Users/beyon/todo.txt', '드라이브형 로컬 파일 URL도 기기 종속 경로');
  assert.deepEqual(detectDevicePaths('https://x.com/r?u=file:///Users/leak/secret 열어'), [], '원격 URL 속 file://는 경로가 아니다 — 전처리 순서의 실효 케이스');
});

test('성능 방어 — 무공백 영숫자 블롭에서 이차식 폭주 없음(검수 MEDIUM-1 계열)', () => {
  const blob = 'a3f9-c2-'.repeat(3750); // 30KB, 단어 경계 다수 — \b가 상한 부재를 가리지 못하게(재검수 지적 1: 무경계 블롭은 상한 제거 변이에 초록이었다)
  const t0 = process.hrtime.bigint();
  detectDevicePaths(blob);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 200, `30KB 블롭 판정 ${ms.toFixed(1)}ms — 200ms를 넘으면 이차식 회귀(수정 실측 0.09ms, CI 편차 여유 포함 상한)`);
});
