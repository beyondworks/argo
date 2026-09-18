import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcilePending, messageEvent } from '../src/instant-delivery.mjs';

test('낙관적 글은 client_msg_id로 맞춰 걷어낸다', () => {
  const pending = [{ clientId: 'cid-1', body: 'ㄱ' }, { clientId: 'cid-2', body: 'ㄴ' }];
  assert.deepEqual(reconcilePending(pending, [{ id: 12, client_msg_id: 'cid-1' }]).map((x) => x.clientId), ['cid-2']);
  // 남의 글(client_msg_id 없음)이 와도 내 낙관적 글을 지우지 않는다
  assert.equal(reconcilePending(pending, [{ id: 13, client_msg_id: null }]).length, 2);
  assert.equal(reconcilePending(pending, []).length, 2);
});

test("방송 구분자는 payload의 글 종류에 덮이지 않는다 — 이 순서가 뒤집히면 수신이 통째로 죽는다", () => {
  // 서버 트리거 payload에는 글 종류 kind('text')가 들어 있다. 구분자를 앞에 두고 전개하면
  // event.kind가 'text'가 되어 수신 분기가 전부 빗나간다(실측: 글이 10초 폴백 폴에서야 그려짐).
  const ev = messageEvent({ id: 7, channel_id: 'c1', kind: 'text', body: '가', created_at: '2026-09-18T01:00:00Z' });
  assert.equal(ev.kind, 'message');   // 무슨 방송인가
  assert.equal(ev.msgKind, 'text');   // 글 종류
  assert.equal(messageEvent({ id: 8, kind: 'system' }).kind, 'message');
  assert.equal(messageEvent({ id: 9 }).msgKind, 'text'); // 종류가 없으면 text
});
