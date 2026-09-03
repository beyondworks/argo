import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalRisk, RISK_LEVELS } from '../src/approval-risk.mjs';

test('위험 등급: 커넥터 쓰기는 항상 고위험, 회사 안 kind는 문장과 무관하게 저위험, 자유 문장은 발송·결제·삭제·게시·계약 키워드(ko/en)', () => {
  assert.deepEqual(RISK_LEVELS, ['low', 'high']);
  assert.equal(approvalRisk({ kind: 'connector', action: 'google-calendar · list_events' }), 'high');
  assert.equal(approvalRisk({ kind: 'profile', action: '프로필 변경 — 서윤: 규칙 삭제' }), 'low');
  assert.equal(approvalRisk({ kind: 'hire', action: '크루 영입 — 메일 발송 담당' }), 'low');
  assert.equal(approvalRisk({ kind: 'loop', action: '루프 재개 — 결제 정산' }), 'low');
  for (const a of ['거래처에 견적서 메일 발송', '광고비 30만원 결제', '고객 DB 행 삭제', '블로그에 글 게시', '납품 계약 체결', 'Send the invoice to the client', 'Delete the staging bucket', 'Publish the release notes', 'Wire $500 to the vendor']) {
    assert.equal(approvalRisk({ action: a }), 'high', a);
  }
  for (const a of ['광고 집행', '초안 검토 후 정리', '보고서 요약 작성', 'Summarize the Q3 report', 'Draft a reply for review']) {
    assert.equal(approvalRisk({ action: a }), 'low', a);
  }
  assert.equal(approvalRisk({ action: '초안 정리', reason: '정리 후 고객에게 발송 예정' }), 'high', '사유에 있는 키워드도 본다');
  assert.equal(approvalRisk(), 'low');
});
