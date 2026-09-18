import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rowFromBroadcast, reconcilePending, shouldFetchOnEvent, messageEvent, broadcastEvent } from '../src/instant-delivery.mjs';

// setEvent가 만든 event 모양: 구분자 kind='message', 글 종류는 msgKind.
const full = { id: 12, channel_id: 'c1', body: '안녕하세요', created_at: '2026-09-18T01:00:00Z',
  author_kind: 'user', author_user_id: 'u1', mentions: ['u2'], client_msg_id: 'cid-1', kind: 'message', msgKind: 'text' };

test('본문을 실은 방송은 조회 없이 그릴 행이 된다', () => {
  const row = rowFromBroadcast(full);
  assert.equal(row.id, 12);
  assert.equal(row.body, '안녕하세요');
  assert.equal(row.client_msg_id, 'cid-1');
  assert.deepEqual(row.mentions, ['u2']);
  assert.equal(row.deleted_at, null);
});

test('여윈 방송(본문 없음)은 null — 조회 폴백이 살아 있어야 한다', () => {
  // 마이그레이션 적용 전 서버와 구버전 서버가 보내는 모양. 여기서 행을 지어내면
  // 본문 없는 빈 글이 화면에 박힌다.
  const lean = { id: 12, channel_id: 'c1', author_kind: 'user', author_user_id: 'u1', mentions: [], kind: 'message', msgKind: 'text' };
  assert.equal(rowFromBroadcast(lean), null);
  assert.equal(rowFromBroadcast({ ...full, body: null }), null);
  assert.equal(rowFromBroadcast({ ...full, created_at: undefined }), null); // 시각이 없으면 정렬·표시가 깨진다
  assert.equal(rowFromBroadcast(null), null);
});

test('빈 본문은 본문이다 — 첨부만 있는 글이 사라지면 안 된다', () => {
  assert.equal(rowFromBroadcast({ ...full, body: '' })?.body, '');
});

test("글 종류는 msgKind에서 온다 — 방송 구분자 kind('message')를 글 종류로 쓰면 안 된다", () => {
  // 서버 payload의 kind는 'text'인데 setEvent가 구분자로도 kind를 쓴다. 전개 순서가 뒤집히면
  // 구분자가 'text'로 덮여 message 방송이 통째로 버려진다(실측: 10초 폴백 폴에서야 그려졌다).
  assert.equal(rowFromBroadcast(full).kind, 'text');
  assert.equal(rowFromBroadcast({ ...full, msgKind: 'system' }).kind, 'system');
  assert.notEqual(rowFromBroadcast(full).kind, 'message');
});

test('낙관적 글은 client_msg_id로 맞춰 걷어낸다', () => {
  const pending = [{ clientId: 'cid-1', body: 'ㄱ' }, { clientId: 'cid-2', body: 'ㄴ' }];
  assert.deepEqual(reconcilePending(pending, [{ id: 12, client_msg_id: 'cid-1' }]).map((x) => x.clientId), ['cid-2']);
  // 남의 글(client_msg_id 없음)이 와도 내 낙관적 글을 지우지 않는다
  assert.equal(reconcilePending(pending, [{ id: 13, client_msg_id: null }]).length, 2);
  assert.equal(reconcilePending(pending, []).length, 2);
});

test('본문 방송을 받은 뒤에는 여윈 쌍둥이를 보고 다시 읽지 않는다', () => {
  const now = 1_000_000;
  const base = { eventId: 12, msgIds: new Set(), chLiveAt: now - 1000, now, trustMs: 10_000 };
  assert.equal(shouldFetchOnEvent({ ...base, hasBody: true }), false);   // 그린 글은 조회 불필요
  assert.equal(shouldFetchOnEvent({ ...base, hasBody: false }), false);  // 쌍둥이 — 본문 방송이 최근이라 무시
});

test('본문 방송이 끊기면 조회 경로로 스스로 돌아온다', () => {
  const now = 1_000_000;
  assert.equal(shouldFetchOnEvent({ eventId: 12, hasBody: false, msgIds: new Set(),
    chLiveAt: now - 60_000, now, trustMs: 10_000 }), true);
  assert.equal(shouldFetchOnEvent({ eventId: 12, hasBody: false, msgIds: new Set(),
    chLiveAt: 0, now, trustMs: 10_000 }), true); // 한 번도 본문 방송을 못 받은 서버
});

test('이미 목록에 있는 글은 다시 읽지 않는다', () => {
  const now = 1_000_000;
  assert.equal(shouldFetchOnEvent({ eventId: 12, hasBody: false, msgIds: new Set([12]),
    chLiveAt: 0, now, trustMs: 10_000 }), false);
});

test("방송 구분자는 payload의 글 종류에 덮이지 않는다 — 이 순서가 뒤집히면 수신이 통째로 죽는다", () => {
  // 서버 트리거 payload에는 글 종류 kind('text')가 들어 있다. 구분자를 앞에 두고 전개하면
  // event.kind가 'text'가 되어 수신 분기가 전부 빗나간다(실측: 글이 10초 폴백 폴에서야 그려짐).
  const ev = messageEvent({ id: 7, channel_id: 'c1', kind: 'text', body: '가', created_at: '2026-09-18T01:00:00Z' });
  assert.equal(ev.kind, 'message');   // 무슨 방송인가
  assert.equal(ev.msgKind, 'text');   // 글 종류
  assert.equal(rowFromBroadcast(ev).kind, 'text');
  assert.equal(messageEvent({ id: 8, kind: 'system' }).kind, 'message');
  assert.equal(messageEvent({ id: 9 }).msgKind, 'text'); // 종류가 없으면 text
});

test("approval·reaction·edit도 payload의 kind에 구분자를 빼앗기지 않는다 — 서버가 kind를 싣는 날을 재현", () => {
  // 지금 이 세 방송의 payload엔 kind가 없다. 그래서 순서가 틀려도 멀쩡해 보인다 — 그게 함정이다.
  // 서버가 나중에 kind를 실으면 message와 똑같이 수신 분기가 전부 빗나간다.
  for (const k of ['approval', 'reaction', 'edit']) {
    const ev = broadcastEvent(k, { channel_id: 'c1', message_id: 5, kind: 'text' }, 1);
    assert.equal(ev.kind, k, `${k} 방송의 구분자가 payload의 kind에 덮였다`);
    assert.equal(ev.channel_id, 'c1');
  }
});

test('App.jsx에는 구분자를 앞에 두고 payload를 전개하는 setEvent가 없다', () => {
  // 헬퍼 테스트는 헬퍼만 지킨다. 누가 호출부에 인라인으로 { kind: 'x', ...payload }를 다시 쓰면
  // 헬퍼 테스트는 초록인 채로 방송이 죽는다. 그 모양 자체를 막는다.
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const bad = app.match(/setEvent\(\{\s*kind:\s*'[^']+',\s*\.\.\./g) ?? [];
  assert.deepEqual(bad, [], `구분자 뒤에 전개가 오는 setEvent: ${bad.join(' | ')}`);
  // 세 방송이 모두 헬퍼를 거친다
  for (const k of ['approval', 'reaction', 'edit']) assert.match(app, new RegExp(`setEvent\\(broadcastEvent\\('${k}', payload\\)\\)`), `${k} 방송이 broadcastEvent를 거치지 않는다`);
});
