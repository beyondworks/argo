// UL6(2026-10-05 분리 검수): src/routines.mjs의 예약 형식·완료 조건 검증 오류가 코드 없이 한국어로 던져져, 영어 화면에도 한국어가 나왔다(F11이 다른 엔진 오류에만 코드를 붙였다).
// 그리고 영입 라우트가 내리는 errorCode crew_slug_reserved가 사전에 없어 화면 언어로 다시 그려지지 않았다.
// 잠그는 행동: ① 각 검증 오류가 errorCode를 달고(메시지는 종전 한국어 문장 그대로 — 로그·기존 소비자 회귀 0) ② 코드가 사전(API_MSG)에 ko/en으로 있고 ko는 메시지와 같다
// ③ 영어 화면 요청은 영어 문구 + errorCode(apiErrorFrom) ④ 사전의 ko 문구가 실제 한도(VERIFY_MAX_FILES)와 어긋나지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule, normalizeVerify, VERIFY_MAX_FILES } from '../src/routines.mjs';
import { API_MSG, apiErrorFrom, errorTextFor } from '../app/apimsg.mjs';

const CASES = [
  ['routine_once_date_required', () => normalizeSchedule({ type: 'once', date: '내일', time: '09:00' }), '1회 예약은 날짜(YYYY-MM-DD)가 필요합니다'],
  ['routine_time_format', () => normalizeSchedule({ type: 'daily', time: '9시' }), '예약 시각은 HH:MM 형식'],
  ['routine_time_format', () => normalizeSchedule({ type: 'once', date: '2026-10-06', time: 'abc' }), '예약 시각은 HH:MM 형식'],
  ['routine_interval_range', () => normalizeSchedule({ type: 'interval', everyMinutes: 3 }), '반복 간격은 10~1440분'],
  ['routine_times_max', () => normalizeSchedule({ type: 'daily', times: ['01:00', '02:00', '03:00', '04:00', '05:00', '06:00', '07:00', '08:00', '09:00'] }), '예약 시각은 하루 8개까지'],
  ['routine_dow_range', () => normalizeSchedule({ type: 'weekly', time: '09:00', dows: [9] }), '요일은 일(0)~토(6) 범위'],
  ['routine_verify_path_len', () => normalizeVerify({ files: ['a'.repeat(201)] }), '완료 조건 파일 경로는 200자 이내'],
  ['routine_verify_path_relative', () => normalizeVerify({ files: ['/etc/passwd'] }), '완료 조건 경로는 회사 기억 안 상대경로만'],
  ['routine_verify_path_traversal', () => normalizeVerify({ files: ['a/../../b'] }), '완료 조건 경로에 상위 탈출(..) 금지'],
  ['routine_verify_files_max', () => normalizeVerify({ files: Array.from({ length: VERIFY_MAX_FILES + 1 }, (_, i) => `f${i}.md`) }), `완료 조건 파일은 ${VERIFY_MAX_FILES}개까지`],
];

for (const [code, run, ko] of CASES) {
  test(`${code} — 코드가 달리고 메시지는 종전 그대로, 사전에 ko/en이 있다`, async () => {
    let err; try { run(); } catch (e) { err = e; }
    assert.ok(err, '검증 오류가 던져진다');
    assert.equal(err.errorCode, code);
    assert.equal(err.message, ko, '메시지는 종전 한국어 문장 그대로(로그·기존 소비자 회귀 0)');
    assert.equal(API_MSG[code].status, 400);
    assert.equal(API_MSG[code].ko, ko, '사전 ko = 엔진 메시지');
    assert.ok(API_MSG[code].en && !/[가-힣]/.test(API_MSG[code].en), `en 문구에 한글이 없다: ${API_MSG[code].en}`);
    const en = apiErrorFrom(err, 'en', 400); const body = await en.json();
    assert.equal(en.status, 400); assert.equal(body.errorCode, code); assert.equal(body.error, API_MSG[code].en, '영어 화면 요청은 영어 문구');
    assert.equal(errorTextFor({ errorCode: code, error: ko }, 400, 'en'), API_MSG[code].en, '화면 쪽도 서버가 ko로 그렸어도 화면 언어를 따른다');
  });
}

test('영입 예약 slug 오류 코드가 사전에 있다 — 화면 언어로 다시 그려진다', () => {
  const m = API_MSG.crew_slug_reserved;
  assert.equal(m.status, 400);
  assert.match(m.ko, /회의실 내부 이름/); assert.doesNotMatch(m.en, /[가-힣]/); assert.match(m.en, /room-/);
  assert.equal(errorTextFor({ errorCode: 'crew_slug_reserved', error: '크루 이름 "Room Main"(room-main)은 …' }, 400, 'en'), m.en);
});

test('사전의 한도 문구가 실제 한도와 같다 — 한도를 바꾸면 이 테스트가 사전 갱신을 요구한다', () => {
  assert.ok(API_MSG.routine_verify_files_max.ko.includes(String(VERIFY_MAX_FILES)));
  assert.ok(API_MSG.routine_verify_files_max.en.includes(String(VERIFY_MAX_FILES)));
});
