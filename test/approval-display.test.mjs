// 본체 웹 결재 카드 표시 규칙(app/lib/approval-display.mjs) 행동 테스트 — 분리 검수 M-1·M-4.
// app/*.jsx는 JSX 문법이라 plain node로 직접 import해 렌더링 검증을 할 수 없다(이 레포 관례:
// .jsx 테스트는 전부 소스를 텍스트로 읽어 정규식으로만 검사해 왔다). 이 파일은 JSX가 없는 순수
// 표시 결정 함수만 담아, 크루 채팅 카드·데크 카드가 실제로 쓰는 그 함수를 직접 호출해 검증한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalExpandDefault } from '../app/lib/approval-display.mjs';

test('approvalExpandDefault: risk가 high면 "명령 보기"를 기본으로 펼친다(분리 검수 M-1)', () => {
  assert.equal(approvalExpandDefault({ risk: 'high' }), true);
});

test('approvalExpandDefault: risk가 low·없음이면 기본 접힘', () => {
  assert.equal(approvalExpandDefault({ risk: 'low' }), false);
  assert.equal(approvalExpandDefault({}), false);
  assert.equal(approvalExpandDefault(null), false);
});
