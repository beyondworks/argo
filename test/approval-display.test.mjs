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

// F8(2026-10-05 분리 검증): 관리자가 정해야 하는 메신저 고위험 결재(msgr.ownerMayDecide===false)에도 본체 카드가 승인·거절 버튼을
// 그렸고, 누르면 approvals.mjs resolveApproval이 항상 거절했다(조직 정책 오류). 같은 판정을 화면이 먼저 쓴다.
test('approvalOwnerMayDecide: 메신저가 "소유자 확정 불가"로 판정한 결재만 false — 서버 판정(approvals.mjs)과 같은 규칙', async () => {
  const { approvalOwnerMayDecide } = await import('../app/lib/approval-display.mjs');
  assert.equal(approvalOwnerMayDecide({ msgr: { ownerMayDecide: false } }), false);
  assert.equal(approvalOwnerMayDecide({ msgr: { ownerMayDecide: true } }), true);
  assert.equal(approvalOwnerMayDecide({ msgr: {} }), true, '판정이 없으면(옛 결재) 종전처럼 버튼');
  assert.equal(approvalOwnerMayDecide({}), true);
  // 서버와 같은 판정인지 — resolveApproval이 웹 창구(via≠msgr)에서 거절하는 바로 그 결재다
  const { mkdtemp } = await import('./helpers/tmp.mjs');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-apdisp-'));
  const { createCompany } = await import('../src/workspace.mjs');
  const { addApproval, resolveApproval } = await import('../src/approvals.mjs');
  await createCompany('co-apd', '결재 회사', 'captain');
  const a = await addApproval('co-apd', { slug: 'pepper', action: '송금', reason: '고위험', msgr: { orgId: 'o', channelId: 'c', ownerMayDecide: false } });
  assert.equal(approvalOwnerMayDecide(a), false);
  await assert.rejects(() => resolveApproval('co-apd', a.id, true), /조직 정책/, '화면이 버튼을 숨기는 결재 = 서버가 거절하는 결재');
});
