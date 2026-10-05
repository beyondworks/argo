// UL5(2026-10-05 분리 검수): 영구 삭제 실패 문구가 응답 본문이 없으면 "영구 삭제하지 못했습니다 — "로 끝나고, 네트워크 실패면 한국어 화면에
// "— Load failed"(브라우저 원문)가 나왔다. 데크 deck.approvalFail도 같은 모양. → 공용 함수(failureReason·responseError)로 화면 언어 문구를 만든다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, responseError } from '../app/lib/error-text.mjs';

// 사전 대역 — 키 이름이 그대로 보이면(= 사전에 없으면) 테스트가 잡는다
const DICT = { 'common.reason.network': ['네트워크 연결을 확인해 주세요', 'Check your network connection'], 'common.reason.unknown': ['잠시 뒤 다시 시도해 주세요', 'Please try again shortly'] };
const tFor = (lang) => (key) => (DICT[key] ? DICT[key][lang === 'en' ? 1 : 0] : `⟨${key}⟩`);

test('브라우저 네트워크 실패 원문(Load failed·Failed to fetch·fetch failed)은 화면 언어 문구로 — 원문이 화면에 나오지 않는다', () => {
  for (const msg of ['Load failed', 'Failed to fetch', 'fetch failed', 'NetworkError when attempting to fetch resource.']) {
    assert.equal(failureReason(new TypeError(msg), tFor('ko')), '네트워크 연결을 확인해 주세요', msg);
    assert.equal(failureReason(new TypeError(msg), tFor('en')), 'Check your network connection', msg);
  }
});

test('이유가 비어 있으면 "— "로 끝나지 않고 다음 행동을 말한다', () => {
  assert.equal(failureReason(new Error(''), tFor('ko')), '잠시 뒤 다시 시도해 주세요');
  assert.equal(failureReason(null, tFor('en')), 'Please try again shortly');
  assert.equal(failureReason(undefined, tFor('ko')), '잠시 뒤 다시 시도해 주세요');
  assert.equal(failureReason(new Error('   '), tFor('ko')), '잠시 뒤 다시 시도해 주세요');
});

test('서버가 준 화면 언어 문구는 그대로 — api()가 던진 오류(data 있음)·본문 오류는 손대지 않는다', () => {
  assert.equal(failureReason(Object.assign(new Error('이미 처리된 결재입니다'), { data: { errorCode: 'approval_already_resolved' } }), tFor('ko')), '이미 처리된 결재입니다');
  assert.equal(failureReason(new Error('디스크가 가득 찼습니다'), tFor('ko')), '디스크가 가득 찼습니다');
});

test('responseError — 본문의 errorCode는 화면 언어 문구, 본문이 없으면 상태 문구("요청 실패 (500)")라 빈 이유가 없다', () => {
  const ko = responseError({ status: 404 }, { errorCode: 'routine_not_found' }, 'ko');
  assert.equal(ko.message, '루틴을 찾을 수 없습니다'); assert.equal(ko.status, 404); assert.deepEqual(ko.data, { errorCode: 'routine_not_found' });
  assert.equal(responseError({ status: 404 }, { errorCode: 'routine_not_found' }, 'en').message, 'Routine not found', '서버가 ko로 그렸어도 화면 언어를 따른다');
  assert.equal(responseError({ status: 500 }, {}, 'ko').message, '요청 실패 (500)');
  assert.equal(responseError({ status: 500 }, undefined, 'en').message, 'Request failed (500)');
  assert.equal(responseError({ status: 400 }, { error: '원문 오류' }, 'ko').message, '원문 오류');
  assert.equal(failureReason(responseError({ status: 500 }, {}, 'ko'), tFor('ko')), '요청 실패 (500)', 'api() 오류와 같은 모양이라 그대로 보인다');
});
