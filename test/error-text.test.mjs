// UL5(2026-10-05 분리 검수): 영구 삭제 실패 문구가 응답 본문이 없으면 "영구 삭제하지 못했습니다 — "로 끝나고, 네트워크 실패면 한국어 화면에
// "— Load failed"(브라우저 원문)가 나왔다. 데크 deck.approvalFail도 같은 모양. → 공용 함수(failureReason·responseError)로 화면 언어 문구를 만든다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureReason, responseError } from '../app/lib/error-text.mjs';

// 사전 대역 — 키 이름이 그대로 보이면(= 사전에 없으면) 테스트가 잡는다
const DICT = {
  'common.reason.network': ['네트워크 연결을 확인해 주세요', 'Check your network connection'], 'common.reason.unknown': ['잠시 뒤 다시 시도해 주세요', 'Please try again shortly'],
  'common.reason.forbidden': ['권한이 없거나 로그인이 필요해요', 'You may not have access, or you need to sign in'], 'common.reason.notFound': ['대상을 찾지 못했어요', 'Could not find it'],
  'common.reason.tooLarge': ['보내는 내용이 너무 커요', 'What you are sending is too large'], 'common.reason.server': ['서버에서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요', 'The server could not handle it. Please try again shortly'],
};
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

// 2차 분리 검수 M3(2026-10-05): failureReason이 네트워크 TypeError가 아니면 서버 error 원문을 그대로 보였다 — 보관함 복구가 "ENOENT: no such file or directory, open '/private/tmp/…/chats/.trash/….json'"(절대 경로 노출),
// 11MB 첨부가 "Failed to parse body as FormData." 로 나왔다. → 사전 문구로 바뀐 오류(errorCode가 사전에 있는 경우)만 그대로 쓰고 나머지는 상태별 일반 문구.
test('사전 문구로 바뀐 오류(errorCode가 사전에 있음)만 그대로 보인다 — api()·responseError가 만든 오류', () => {
  assert.equal(failureReason(Object.assign(new Error('이미 처리된 결재입니다'), { data: { errorCode: 'approval_already_resolved' }, status: 409 }), tFor('ko')), '이미 처리된 결재입니다');
  assert.equal(failureReason(Object.assign(new Error('Routine not found'), { data: { errorCode: 'routine_not_found' }, status: 404 }), tFor('en')), 'Routine not found');
  assert.equal(failureReason(Object.assign(new Error('로그인이 필요합니다'), { data: { errorCode: 'auth_required' }, status: 401 }), tFor('ko')), '로그인이 필요합니다', '가드 사전(AUTH_MSG)도 같다');
});

test('서버·시스템 원문은 화면에 나오지 않는다 — 경로·시스템 메시지·본문 파싱 오류 원문은 상태별 일반 문구로', () => {
  const raw = [
    ["ENOENT: no such file or directory, open '/private/tmp/argo/chats/.trash/abc.json'", 400],
    ['Failed to parse body as FormData.', 500],
    ['Unexpected token < in JSON at position 0', 502],
    ['디스크가 가득 찼습니다', 400],
  ];
  for (const [msg, status] of raw) {
    const e = Object.assign(new Error(msg), { status, data: { error: msg } }); // errorCode 없음 — 서버 원문
    for (const lang of ['ko', 'en']) {
      const out = failureReason(e, tFor(lang));
      assert.ok(!out.includes(msg) && !/ENOENT|\/private|FormData|Unexpected token/.test(out), `${lang} ${status}: 원문이 새지 않는다 — ${out}`);
    }
  }
  const byStatus = (status) => failureReason(Object.assign(new Error('x'), { status, data: { error: 'x' } }), tFor('ko'));
  assert.equal(byStatus(401), '권한이 없거나 로그인이 필요해요'); assert.equal(byStatus(403), '권한이 없거나 로그인이 필요해요');
  assert.equal(byStatus(404), '대상을 찾지 못했어요');
  assert.equal(byStatus(413), '보내는 내용이 너무 커요');
  assert.equal(byStatus(500), '서버에서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요'); assert.equal(byStatus(503), '서버에서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요');
  assert.equal(byStatus(400), '잠시 뒤 다시 시도해 주세요', '그 밖의 상태는 다음 행동 문구');
  assert.equal(failureReason(new Error('상태도 코드도 없는 오류'), tFor('ko')), '잠시 뒤 다시 시도해 주세요', '코드 안에서 던진 문장도 화면 원문이 아니다');
});

test('responseError — 본문의 errorCode는 화면 언어 문구, 본문이 없으면 상태 문구("요청 실패 (500)")라 빈 이유가 없다', () => {
  const ko = responseError({ status: 404 }, { errorCode: 'routine_not_found' }, 'ko');
  assert.equal(ko.message, '루틴을 찾을 수 없습니다'); assert.equal(ko.status, 404); assert.deepEqual(ko.data, { errorCode: 'routine_not_found' });
  assert.equal(responseError({ status: 404 }, { errorCode: 'routine_not_found' }, 'en').message, 'Routine not found', '서버가 ko로 그렸어도 화면 언어를 따른다');
  assert.equal(responseError({ status: 500 }, {}, 'ko').message, '요청 실패 (500)');
  assert.equal(responseError({ status: 500 }, undefined, 'en').message, 'Request failed (500)');
  assert.equal(responseError({ status: 400 }, { error: '원문 오류' }, 'ko').message, '원문 오류');
  assert.equal(failureReason(responseError({ status: 500 }, {}, 'ko'), tFor('ko')), '서버에서 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요', '본문 없는 500은 일반 문구(상태 숫자 문구는 사용자 말이 아니다)');
  assert.equal(failureReason(responseError({ status: 404 }, { errorCode: 'routine_not_found' }, 'ko'), tFor('ko')), '루틴을 찾을 수 없습니다', '사전 코드가 있으면 그 문구');
});
