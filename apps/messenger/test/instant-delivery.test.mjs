import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reconcilePending, messageEvent, broadcastEvent, onForeground } from '../src/instant-delivery.mjs';

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
  // 구분자 값이 문자열이든 변수든(목록에 없는 새 방송 종류 포함) 전개가 뒤에 오면 막는다
  const bad = app.match(/setEvent\(\{\s*kind:[^,}]+,\s*\.\.\./g) ?? [];
  assert.deepEqual(bad, [], `구분자 뒤에 전개가 오는 setEvent: ${bad.join(' | ')}`);
  // 세 방송이 모두 헬퍼를 거친다
  for (const k of ['approval', 'reaction', 'edit']) assert.match(app, new RegExp(`setEvent\\(broadcastEvent\\('${k}', payload\\)\\)`), `${k} 방송이 broadcastEvent를 거치지 않는다`);
});

test('앞으로 온 순간 한 번 따라잡는다 — 보일 때만, 연달아 오는 visibilitychange·focus는 한 번으로, 해제하면 멈춘다', () => {
  const doc = new EventTarget(); doc.visibilityState = 'hidden'; const win = new EventTarget();
  let t = 1000, calls = 0; const off = onForeground(() => { calls++; }, { doc, win, now: () => t });
  doc.dispatchEvent(new Event('visibilitychange')); assert.equal(calls, 0, '가려진 채로는 조회하지 않는다');
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); win.dispatchEvent(new Event('focus'));
  assert.equal(calls, 1, '앞으로 올 때 visibilitychange와 focus가 연달아 와도 한 번');
  t += 5000; win.dispatchEvent(new Event('focus')); assert.equal(calls, 2, '나중의 포커스 복귀(다른 창에서 돌아옴)도 따라잡는다');
  off(); t += 5000; win.dispatchEvent(new Event('focus')); doc.dispatchEvent(new Event('visibilitychange')); assert.equal(calls, 2, '해제 뒤엔 부르지 않는다');
});

test('App.jsx 채널 화면은 앞으로 올 때 글과 결재를 다시 읽는다', () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /useEffect\(\(\) => onForeground\(\(\) => \{ load\(lastId\)\.catch\(\(\) => \{\}\); loadApprovals\(\)\.catch\(\(\) => \{\}\); \}\), \[load, lastId\]\)/);
});
