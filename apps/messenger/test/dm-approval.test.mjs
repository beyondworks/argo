import test from 'node:test';
import assert from 'node:assert/strict';
import { dmApprovalState, dmNeedsApproval } from '../src/dm-approval.js';

test('결재자 RPC가 오류면 결재자 모름 — 승인 필요를 띄우지 않는다(170000 없는 서버에서 방을 연 사람에게 틀린 안내 금지)', () => {
  const st = dmApprovalState({ data: null, error: { message: 'Could not find the function public.msgr_dm_approver' } }, 'me');
  assert.deepEqual(st, { legacy: true, approver: null, isApprover: false });
  assert.equal(dmNeedsApproval(st), false);
});

test('결재자면 바로, 아니면 승인 필요 — 결재자가 아직 없으면(null) 승인 필요', () => {
  assert.equal(dmNeedsApproval(dmApprovalState({ data: 'me', error: null }, 'me')), false);
  assert.equal(dmNeedsApproval(dmApprovalState({ data: 'opener', error: null }, 'me')), true);
  const none = dmApprovalState({ data: null, error: null }, 'me');
  assert.equal(none.legacy, false); assert.equal(dmNeedsApproval(none), true);
});
