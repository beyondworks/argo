// 결재함 카드(유건 9/30 #7) — 한 줄 핵심과 카드에서 바로 결정하는 조건.
import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalHead, mapBoard } from '../src/core/board.js';
import { canQuickDecide } from '../src/core/folders.js';

// 이유: 카드 한 줄은 에이전트가 적은 목적(purpose)이 먼저, 없으면 할 일(task), 둘 다 없으면 null(화면이 요청 원문 앞부분을 쓴다).
test('approvalHead: purpose → task → null, 빈 글·문자열 아닌 값은 버린다', () => {
  assert.equal(approvalHead({ purpose: '  견적 메일 보내기 ', task: '메일 1통' }), '견적 메일 보내기');
  assert.equal(approvalHead({ purpose: '   ', task: '메일 1통' }), '메일 1통');
  assert.equal(approvalHead({ purpose: { x: 1 }, task: 42 }), null); // payload는 검증 없는 jsonb — 객체를 그리면 화면이 죽는다
  assert.equal(approvalHead(null), null);
  assert.equal(approvalHead(undefined), null);
});

// 이유: 서버는 payload->plain만 pl로 내려 준다(전체 payload는 받지 않는다) — 매핑이 그 값을 head·need로 옮겨야 카드가 보인다.
test('mapBoard: pl(payload.plain) → head·need', () => {
  const b = mapBoard({ approvals: [{ id: 'a1', org_id: 'o', channel_id: 'c', crew_id: 'k', action: 'gmail.send', reason: '', risk: 'low', created_at: 't', pl: { purpose: '견적 보내기', need: '메일 1통' } }] },
    { orgKey: new Map([['o', 'bw']]), decidable: new Set(['a1']) });
  assert.equal(b.approvals[0].head, '견적 보내기');
  assert.equal(b.approvals[0].need, '메일 1통');
  assert.equal(b.approvals[0].plain, 'gmail.send');
});

// 이유: 위험도가 가장 높은 것은 카드에서 바로 승인하지 않고 상세 창에서 확인한다. 결정 권한이 없으면 버튼 자체가 없다.
test('canQuickDecide: high는 거짓, 권한 없음은 거짓, 나머지는 참', () => {
  assert.equal(canQuickDecide({ risk: 'low' }), true);
  assert.equal(canQuickDecide({ risk: 'low', canDecide: true }), true);
  assert.equal(canQuickDecide({ risk: 'high', canDecide: true }), false);
  assert.equal(canQuickDecide({ risk: 'low', canDecide: false }), false);
});
