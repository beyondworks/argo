// 메신저 결재 슬립 표시 규칙(src/approval-display.js) 행동 테스트 — 분리 검수 M-1·M-2·M-4.
// App.jsx는 거대한 단일 파일이라 JSX 문법 때문에 plain node로 직접 import·렌더링할 수 없다
// (이 레포의 모든 App.jsx 테스트가 소스를 텍스트로 읽어 정규식으로만 검사해 온 이유). 이 파일은
// JSX가 전혀 없는 순수 함수만 담아, Slip 컴포넌트가 실제로 쓰는 그 함수를 직접 호출해 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainField, approvalPlainFields, orgDocTitle, approvalOneLineSummary, approvalExpandDefault } from '../src/approval-display.js';

test('plainField: 문자열만 통과, 공백뿐이면 null', () => {
  assert.equal(plainField('목적문장'), '목적문장');
  assert.equal(plainField('   '), null);
  assert.equal(plainField(''), null);
});

test('plainField: 문자열이 아니면(손상·조작 데이터) null — React 자식으로 못 넣게 막는다(분리 검수 M-2)', () => {
  assert.equal(plainField({ evil: 'object' }), null);
  assert.equal(plainField(['array']), null);
  assert.equal(plainField(123), null);
  assert.equal(plainField(true), null);
  assert.equal(plainField(null), null);
  assert.equal(plainField(undefined), null);
});

test('approvalPlainFields: 정상 문자열 payload.plain → 그대로 통과', () => {
  const fields = approvalPlainFields({ plain: { purpose: '목적', task: '할 일', need: '필요' } });
  assert.deepEqual(fields, { purpose: '목적', task: '할 일', need: '필요' });
});

test('approvalPlainFields: purpose/task/need 중 일부만 문자열이어도 있는 것만 통과', () => {
  const fields = approvalPlainFields({ plain: { purpose: '목적', task: { broken: true }, need: 123 } });
  assert.deepEqual(fields, { purpose: '목적', task: null, need: null });
});

// 분리 검수 M-2 핵심 시나리오 — "객체 plain → 화면 정상 + 폴백 카드". purpose/task/need가 전부
// 문자열이 아니면(예: 손상된 payload) approvalPlainFields가 null을 돌려줘 Slip이 폴백(action/reason)
// 카드로 그린다 — plainField 가드가 없으면 이 값이 그대로 JSX 자식이 되어 채널 화면 전체가 죽는다.
test('approvalPlainFields: 셋 다 객체·배열·숫자면(전부 비문자열) null — 화면이 안 죽고 폴백 카드로', () => {
  assert.equal(approvalPlainFields({ plain: { purpose: { a: 1 }, task: [1, 2], need: 42 } }), null);
  assert.equal(approvalPlainFields({ plain: { purpose: null, task: undefined, need: false } }), null);
});

test('approvalPlainFields: payload·plain 자체가 없거나 이상해도(문자열·숫자 등) 안전하게 null', () => {
  assert.equal(approvalPlainFields(null), null);
  assert.equal(approvalPlainFields({}), null);
  assert.equal(approvalPlainFields({ plain: 'not-an-object' }), null);
  assert.equal(approvalPlainFields({ plain: 42 }), null);
});

test('orgDocTitle: 문자열 title은 그대로, 비문자열이면(손상 데이터) 폴백 문자열(분리 검수 M-2 — payload.title도 같은 위험)', () => {
  assert.equal(orgDocTitle({ title: '규칙 문서' }), '규칙 문서');
  assert.equal(orgDocTitle({ title: { broken: true } }, '원래 액션'), '원래 액션');
  assert.equal(orgDocTitle({ title: ['x'] }), 'x'); // fallback 미지정 시 String()으로 안전 변환(그래도 React 자식으로 안전한 문자열)
  assert.equal(orgDocTitle({}), '');
});

test('approvalOneLineSummary: plain 있으면 세 항목 + "명령: <action>" 한 줄(분리 검수 H-1 — 알림함 미리보기도 명령이 보여야 한다)', () => {
  const a = { action: 'sendGmail(to=subs)', reason: 'CEO 지시', payload: { plain: { purpose: '뉴스레터 발송 완료', task: '구독자 발송', need: 'Gmail 권한' } } };
  const summary = approvalOneLineSummary(a, '명령');
  assert.match(summary, /뉴스레터 발송 완료/); // purpose 포함
  assert.match(summary, /구독자 발송/); // task 포함
  assert.match(summary, /Gmail 권한/); // need 포함
  assert.match(summary, /명령: sendGmail\(to=subs\)/);
});

test('approvalOneLineSummary: plain 없으면(폴백) 기존 action/reason 한 줄 그대로', () => {
  assert.equal(approvalOneLineSummary({ action: '경쟁사 리포트 업로드', reason: '분기 보고' }, '명령'), '경쟁사 리포트 업로드 — 분기 보고');
  assert.equal(approvalOneLineSummary({ action: '단독 결재' }, '명령'), '단독 결재');
});

test('approvalOneLineSummary: payload.plain이 전부 객체면(손상 데이터) 폴백으로 떨어진다 — 요약 줄도 안 죽는다', () => {
  const a = { action: '손상된 결재', reason: '사유', payload: { plain: { purpose: {}, task: [], need: 1 } } };
  assert.equal(approvalOneLineSummary(a, '명령'), '손상된 결재 — 사유');
});

test('approvalExpandDefault: risk가 high면 "명령 보기"를 기본으로 펼친다(분리 검수 M-1)', () => {
  assert.equal(approvalExpandDefault({ risk: 'high' }), true);
  assert.equal(approvalExpandDefault({ risk: 'low' }), false);
  assert.equal(approvalExpandDefault({}), false);
});
