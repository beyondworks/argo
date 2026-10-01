// UI 점검 E·F(2026-10-01) — 연결이 끊겼을 때: 전송 실패 카드는 원문 없이 쉬운 문구만, 검색은 실패를 빈 결과로 삼키지 않고, 연결 끊김 막대는 offline/online 이벤트를 따라간다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDelivery, setDeliveryReporter } from '../src/composer-delivery.mjs';
import { isNetworkFailure } from '../src/net-errors.mjs';
import { fetchSearchRows } from '../src/search-rows.mjs';
import { watchOnline } from '../src/connection.mjs';

const transport = (overrides = {}) => ({ message: async () => 7, upload: async () => {}, attachment: async () => {}, ...overrides });
const file = (name) => ({ name, size: 4, type: 'text/plain' });

test('isNetworkFailure: 브라우저·WebView가 주는 네트워크 오류 문구만 잡고 다른 서버 오류는 건드리지 않는다', () => {
  for (const m of ['Failed to fetch', 'TypeError: Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'Network request failed']) assert.equal(isNetworkFailure(m), true, m);
  for (const m of ['new row violates row-level security policy', 'msgr_room_limit', '', null, undefined]) assert.equal(isNetworkFailure(m), false, String(m));
});

test('전송 실패 카드: 네트워크 오류면 원문 대신 offline 키를 쓰고, 원문은 진단 기록(reporter)으로만 간다', async () => {
  const reported = []; setDeliveryReporter((kind, message) => reported.push([kind, message]));
  try {
    const session = createComposerDelivery(transport({ message: async () => { throw new TypeError('Failed to fetch'); } }));
    session.setText('안녕'); assert.equal(await session.send([]), false);
    assert.equal(session.snapshot().job.errorKey, 'msg.delivery.offline');
    assert.deepEqual(reported, [['send', 'TypeError: Failed to fetch']]);
    // 다시 보내기는 같은 카드를 유지한 채 다시 시도한다
    assert.equal(await session.retry(), false); assert.equal(session.snapshot().job.errorKey, 'msg.delivery.offline');
  } finally { setDeliveryReporter(null); }
});

test('전송 실패 카드: 네트워크가 아닌 오류는 그대로(원인을 숨기지 않는다) — errorKey 비어 있음', async () => {
  const session = createComposerDelivery(transport({ message: async () => { throw new Error('new row violates row-level security policy'); } }));
  session.setText('x'); await session.send([]);
  assert.equal(session.snapshot().job.errorKey, '');
  assert.match(session.snapshot().job.error, /row-level security/);
});

test('첨부만 실패(메시지는 게시됨)한 네트워크 오류도 원문 파일 오류줄 대신 offline 키', async () => {
  const reported = []; setDeliveryReporter((kind, message) => reported.push([kind, message]));
  try {
    const session = createComposerDelivery(transport({ upload: async () => { throw new TypeError('Load failed'); } }));
    session.setFiles([file('a.txt')]);
    assert.equal(await session.send([]), false);
    assert.equal(session.snapshot().job.messageId, 7);
    assert.equal(session.snapshot().job.errorKey, 'msg.delivery.offline');
    assert.ok(reported.some(([k, m]) => k === 'send' && /a\.txt: Load failed/.test(m)));
  } finally { setDeliveryReporter(null); }
});

test('fetchSearchRows: 성공이면 한도 안의 글과 더 있음 표시, 실패하면 빈 결과가 아니라 failed 표시', async () => {
  assert.deepEqual(await fetchSearchRows(async () => [1, 2, 3], 2), { msgs: [1, 2], more: true, failed: false });
  assert.deepEqual(await fetchSearchRows(async () => [1], 2), { msgs: [1], more: false, failed: false });
  const seen = [];
  const r = await fetchSearchRows(async () => { throw new TypeError('Failed to fetch'); }, 2, (e) => seen.push(e.message));
  assert.deepEqual(r, { msgs: [], more: false, failed: 'offline' });
  assert.deepEqual(seen, ['Failed to fetch']);
});

test('watchOnline: 처음 상태를 알리고 offline/online 이벤트를 따라가며, 해제하면 더 알리지 않는다', () => {
  const win = new EventTarget(); win.navigator = { onLine: true };
  const seen = []; const stop = watchOnline((v) => seen.push(v), win);
  assert.deepEqual(seen, [true]);
  win.navigator.onLine = false; win.dispatchEvent(new Event('offline'));
  win.navigator.onLine = true; win.dispatchEvent(new Event('online'));
  assert.deepEqual(seen, [true, false, true]);
  stop(); win.dispatchEvent(new Event('offline')); assert.deepEqual(seen, [true, false, true]);
  const dead = new EventTarget(); dead.navigator = { onLine: false };
  const first = []; watchOnline((v) => first.push(v), dead)(); assert.deepEqual(first, [false]);
});
