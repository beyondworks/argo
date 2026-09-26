// 풀 오토(회사 단위 스위치, 유건 확정 2026-09-26) — 연결 서비스 쓰기 결재의 3계급 분류(순수함수).
// connectorRiskCategory/connectorAlwaysNeedsApproval는 needsApprovalNow(행동 테스트는
// connector-fullauto-live.test.mjs)가 fullAuto일 때만 참조하는 판정 재료다. 여기서는 유건이 준
// 경계 예시(gmail send=자동, drive delete=결재, drive share=결재, stripe charge=결재,
// notion update=자동)를 그대로 잰다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-connclass-')); // import보다 먼저
const { connectorRiskCategory, connectorAlwaysNeedsApproval } = await import('../src/connectors.mjs');

test('유건이 준 경계 예시 — 그대로 통과해야 한다', () => {
  const cases = [
    ['gmail_send', {}, 'general'],
    ['drive_delete', {}, 'delete'],
    ['drive_share', {}, 'sensitive'],
    ['stripe_charge', {}, 'purchase'],
    ['notion_update', {}, 'general'],
  ];
  for (const [name, ann, want] of cases) {
    assert.equal(connectorRiskCategory(name, ann), want, `${name} → ${want}이어야 하는데 아니다`);
    assert.equal(connectorAlwaysNeedsApproval(name, ann), want !== 'general', `${name}의 결재 유지 여부가 어긋난다`);
  }
});

test('삭제 — annotations.destructiveHint가 이름보다 먼저 잡는다(MCP 표준 신호가 1순위)', () => {
  assert.equal(connectorRiskCategory('archive_thing', { destructiveHint: true }), 'delete');
  assert.equal(connectorAlwaysNeedsApproval('archive_thing', { destructiveHint: true }), true);
  // destructiveHint가 없거나 false면 이름만으로 판정
  assert.equal(connectorRiskCategory('archive_thing', { destructiveHint: false }), 'general');
});

test('삭제 계열 이름 — remove·trash·destroy·purge', () => {
  for (const name of ['remove_contact', 'trash_file', 'destroy_record', 'purge_cache']) {
    assert.equal(connectorRiskCategory(name), 'delete', name);
  }
});

test('구매·결제 계열 이름 — buy·order·checkout·subscription', () => {
  for (const name of ['buy_credits', 'create_order', 'begin_checkout', 'create_subscription']) {
    assert.equal(connectorRiskCategory(name), 'purchase', name);
  }
});

test('민감 정보 계열 이름 — acl·invite·password·credential·oauth·billing·account', () => {
  for (const name of ['set_acl', 'send_invite', 'reset_password', 'store_credential', 'connect_oauth', 'update_billing', 'update_account']) {
    assert.equal(connectorRiskCategory(name), 'sensitive', name);
  }
});

test('일반 쓰기 — 목록에 없는 동사는 general(풀 오토가 건드리는 유일한 계급)', () => {
  for (const name of ['create_draft', 'update_page', 'append_row', 'post_message']) {
    assert.equal(connectorRiskCategory(name), 'general', name);
    assert.equal(connectorAlwaysNeedsApproval(name), false, name);
  }
});

test('대소문자·구분자 무관 — 서비스마다 네이밍이 달라도 같은 계급', () => {
  assert.equal(connectorRiskCategory('Drive.Delete'), 'delete');
  assert.equal(connectorRiskCategory('DRIVE-SHARE'), 'sensitive');
  assert.equal(connectorRiskCategory('StripeCharge'), 'purchase'); // 부분 문자열 — 애매하면 결재 쪽(요구사항 3)
});

// 분리 검수 MEDIUM 반영(2026-09-26) — 단어 보강. 총괄이 준 경계 예시 그대로.
test('보강 경계 예시 — disconnect_slack·create_filter·forward_email_rule은 결재, send_email은 자동', () => {
  const cases = [
    ['disconnect_slack', 'sensitive'],
    ['create_filter', 'sensitive'],
    ['forward_email_rule', 'sensitive'],
    ['send_email', 'general'],
  ];
  for (const [name, want] of cases) {
    assert.equal(connectorRiskCategory(name), want, `${name} → ${want}이어야 하는데 아니다`);
    assert.equal(connectorAlwaysNeedsApproval(name), want !== 'general', `${name}의 결재 유지 여부가 어긋난다`);
  }
});

test('보강 민감 단어 — login·auth·connect·unlink·revoke', () => {
  for (const name of ['start_login', 'check_auth_status', 'connect_service', 'unlink_account', 'revoke_access']) {
    assert.equal(connectorRiskCategory(name), 'sensitive', name);
  }
});

test('보강 결제 단어 — transfer·refund', () => {
  for (const name of ['transfer_funds', 'issue_refund']) {
    assert.equal(connectorRiskCategory(name), 'purchase', name);
  }
});

// 참고: 이름이 sensitive 단어(billing 등)를 포함해도 readOnlyHint:true 도구가 애초에 결재 대상이 아닌 것은
// 이 순수함수의 몫이 아니다(needsApprovalNow가 그 신호로 먼저 걸러낸다) — 행동 증거는
// connector-fullauto-live.test.mjs의 "읽기 전용은 이름이 sensitive여도 영향 없음" 테스트가 진다.
