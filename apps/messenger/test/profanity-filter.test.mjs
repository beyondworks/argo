// 부적절 표현 가리기 — 순수 판정(containsProfanity)과 설정 읽기/쓰기(기본 켜짐)를 잠근다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { containsProfanity, readProfanityFilterOn, writeProfanityFilterOn, PROFANITY_FILTER_EVENT } from '../src/profanity-filter.mjs';

test('명백한 한국어·영어 욕설이 들어간 문장은 걸린다', () => {
  assert.equal(containsProfanity('아 씨발 진짜'), true);
  assert.equal(containsProfanity('this is fucking great'), true);
  assert.equal(containsProfanity('you bitch'), true);
});

test('평범한 문장은 걸리지 않는다(오탐 최소화)', () => {
  assert.equal(containsProfanity('오늘 회의 몇 시예요?'), false);
  assert.equal(containsProfanity('let\'s ship this feature today'), false);
  assert.equal(containsProfanity(''), false);
  assert.equal(containsProfanity(null), false);
  assert.equal(containsProfanity(undefined), false);
});

// 검수 L1(2026-09-27) — 오탐 문장. 한국어는 "시발점·시발역·병신년"처럼 욕설과 겹치는 정상 단어를 예외 처리,
// 영어는 왼쪽 단어 경계만 걸어 다른 단어 중간에 우연히 낀 부분 문자열(Scunthorpe 등)을 막는다.
test('검수가 찾은 한국어 오탐 문장은 걸리지 않는다', () => {
  assert.equal(containsProfanity('이 프로젝트의 시발점이 궁금합니다'), false);
  assert.equal(containsProfanity('시발역에서 내려서 환승하세요'), false);
  assert.equal(containsProfanity('올해는 병신년입니다'), false);
});

test('영어는 단어 중간에 우연히 낀 부분 문자열을 오탐하지 않는다', () => {
  assert.equal(containsProfanity('I visited Scunthorpe last year'), false); // cunt가 중간에 낌
});

test('그래도 진짜 욕설(어미가 붙은 형태 포함)은 여전히 잡는다', () => {
  assert.equal(containsProfanity('아 진짜 시발 짜증나'), true, '순수 시발은 여전히 걸린다');
  assert.equal(containsProfanity('저 사람 병신 아니냐'), true, '순수 병신은 여전히 걸린다');
  assert.equal(containsProfanity('you bitches are the worst'), true, '어미가 붙어도 걸린다(오른쪽 경계는 걸지 않는다)');
  assert.equal(containsProfanity('that is so retarded'), true);
});

test('대소문자 구분 없이 영어 욕설을 잡는다', () => {
  assert.equal(containsProfanity('FUCK this'), true);
  assert.equal(containsProfanity('Bitch please'), true);
});

test('설정은 기본 켜짐 — localStorage에 값이 없으면 true', () => {
  const orig = globalThis.localStorage;
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  try {
    assert.equal(readProfanityFilterOn(), true, '값 없음 = 기본 켜짐');
    writeProfanityFilterOn(false);
    assert.equal(readProfanityFilterOn(), false);
    writeProfanityFilterOn(true);
    assert.equal(readProfanityFilterOn(), true);
  } finally { globalThis.localStorage = orig; }
});

test('localStorage가 없는 환경에서도 기본 켜짐으로 안전하게 폴백한다', () => {
  const orig = globalThis.localStorage;
  delete globalThis.localStorage;
  try { assert.equal(readProfanityFilterOn(), true); writeProfanityFilterOn(false); /* 던지지 않아야 한다 */ }
  finally { globalThis.localStorage = orig; }
});

test('설정을 바꾸면 window 이벤트로 즉시 알린다 — 설정 화면과 대화 목록이 다른 컴포넌트라도 반영', () => {
  const orig = globalThis.window;
  let seen = null;
  globalThis.window = { dispatchEvent: (e) => { seen = e; } };
  try { writeProfanityFilterOn(false); assert.equal(seen?.type, PROFANITY_FILTER_EVENT); assert.equal(seen?.detail, false); }
  finally { globalThis.window = orig; }
});
