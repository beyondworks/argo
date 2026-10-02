// 개인 방 첨부·보낸 글 링크 미리보기(2026-10-02) — 컴포저 전송 경로.
// 개인 방(org 없음)은 p/<방>/<글>/<키>로 올리고 첨부 행 org_id는 NULL(20261002100000 정책). 조직 방은 종전 그대로.
// 글이 다 올라간 뒤 링크가 있으면 엣지 함수(msgr-link-preview)를 한 번만 부른다 — 실패해도 전송은 성공으로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDelivery, composerTransport, getComposerSession, bindComposerSession, clearComposerSessions } from '../src/composer-delivery.mjs';

const file = (name, type = 'image/png') => ({ name, size: 3, type });
function client() {
  const calls = { upload: [], insert: [], invoke: [] };
  return {
    calls,
    from(table) {
      const q = {
        insert(row) { calls.insert.push([table, row]); return q; },
        select() { return q; }, eq() { return q; },
        single: async () => ({ data: { id: 41 }, error: null }),
        maybeSingle: async () => ({ data: null }),
        then(resolve) { resolve({ error: null }); },
      };
      return q;
    },
    storage: { from: () => ({ upload: async (path, _f, opts) => { calls.upload.push([path, opts]); return { error: null }; } }) },
    functions: { invoke: async (name, opts) => { calls.invoke.push([name, opts]); return { data: { preview: null }, error: null }; } },
    auth: { getSession: async () => ({ data: { session: {} } }) },
  };
}

test('개인 방 — p/<방>/<글>/<id>-<키> 경로, 첨부 행 org_id NULL', async () => {
  const c = client();
  const s = createComposerDelivery(composerTransport(c, { orgId: '__personal__', personal: true, chId: 'ch-1', uid: 'me' }), () => 'fixed-id');
  s.setFiles([file('사진.png')]); s.setText('');
  assert.equal(await s.send([]), true);
  assert.deepEqual(c.calls.upload.map(([p]) => p), ['p/ch-1/41/fixed-id-0-file.png']);
  const att = c.calls.insert.find(([t]) => t === 'msgr_attachments')[1];
  assert.equal(att.org_id, null);
  assert.equal(att.storage_path, 'p/ch-1/41/fixed-id-0-file.png');
  assert.equal(att.name, '사진.png', '표시 이름은 원래 이름');
});

test('조직 방 — 경로·org_id 종전 그대로', async () => {
  const c = client();
  const s = createComposerDelivery(composerTransport(c, { orgId: 'org-1', chId: 'ch-2', uid: 'me' }), () => 'fixed-id');
  s.setFiles([file('a.pdf', 'application/pdf')]);
  await s.send([]);
  assert.deepEqual(c.calls.upload.map(([p]) => p), ['org-1/ch-2/41/fixed-id-0-a.pdf']);
  assert.equal(c.calls.insert.find(([t]) => t === 'msgr_attachments')[1].org_id, 'org-1');
});

test('링크가 든 글은 보낸 뒤 미리보기를 한 번만 요청, 링크 없는 글·실패한 전송은 요청하지 않는다', async () => {
  const c = client();
  const s = createComposerDelivery(composerTransport(c, { orgId: 'org-1', chId: 'ch-2', uid: 'me' }));
  s.setText('이거 https://example.com/a 봐'); await s.send([]);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(c.calls.invoke, [['msgr-link-preview', { body: { message_id: 41 } }]]);
  s.setText('링크 없음'); await s.send([]);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(c.calls.invoke.length, 1);
  const failing = { ...client(), from() { const q = { insert() { return q; }, select() { return q; }, eq() { return q; }, single: async () => ({ error: { message: 'denied' } }), maybeSingle: async () => ({ data: null }) }; return q; } };
  const s2 = createComposerDelivery(composerTransport(failing, { orgId: 'o', chId: 'c', uid: 'me' }));
  s2.setText('https://example.com'); assert.equal(await s2.send([]), false);
  assert.equal(failing.calls.invoke.length, 0);
});

test('미리보기 요청이 실패해도(엣지 함수 미배포 404 등) 전송은 성공이다', async () => {
  const c = client();
  c.functions.invoke = async () => { throw new Error('404'); };
  const s = createComposerDelivery(composerTransport(c, { orgId: 'org-1', chId: 'ch-2', uid: 'me' }));
  s.setText('https://example.com/a');
  assert.equal(await s.send([]), true);
});

// 검수(2026-10-02) MEDIUM — 개인 공간에서 남의 에이전트로 대화를 열면(dmWithCrew) 초안을 넣으려고 세션을 먼저 만든다.
// 세션은 방 키로 캐시되므로, 먼저 만든 쪽이 넘긴 통로(personal 없음)가 남으면 방 입력창의 첨부가 `__personal__/<방>/…`·org_id '__personal__'로 나가
// Storage 정책에 거절됐다(앱을 다시 켤 때까지). 통로는 마지막으로 통로를 넘긴 쪽(방 입력창)의 것을 쓴다.
test('같은 방 키 — 대화 열기가 personal 없는 통로로 세션을 먼저 만들어도 방 입력창 통로로 첨부를 올린다(p/<방>, org_id NULL)', async () => {
  const c = client(); const stale = client();
  const key = JSON.stringify(['srv', 'me', '__personal__', 'ch-9']);
  const primed = getComposerSession(key, composerTransport(stale, { orgId: '__personal__', chId: 'ch-9', uid: 'me' })); // App dmWithCrew 모양
  primed.setText('@에이전트 ');
  const room = bindComposerSession(key, composerTransport(c, { orgId: '__personal__', personal: true, chId: 'ch-9', uid: 'me' })); // 방 입력창
  assert.equal(room, primed, '같은 세션(초안 유지)');
  assert.equal(room.snapshot().text, '@에이전트 ');
  room.setFiles([file('사진.png')]); room.setText('');
  assert.equal(await room.send([]), true);
  assert.match(c.calls.upload[0][0], /^p\/ch-9\/41\//);
  assert.equal(c.calls.insert.find(([t]) => t === 'msgr_attachments')[1].org_id, null);
  assert.equal(stale.calls.upload.length + stale.calls.insert.length, 0, '먼저 만든 통로는 쓰이지 않는다');
  clearComposerSessions();
});

test('같은 방 키 — 방 입력창이 열린 뒤 대화 열기가 다시 불러도(getComposerSession) 방 입력창 통로가 남는다', async () => {
  const key = JSON.stringify(['srv', 'me', '__personal__', 'ch-8']);
  const stale = client(); const fresh = client();
  const room = bindComposerSession(key, composerTransport(fresh, { orgId: '__personal__', personal: true, chId: 'ch-8', uid: 'me' }));
  assert.equal(getComposerSession(key, composerTransport(stale, { orgId: '__personal__', chId: 'ch-8', uid: 'me' })), room); // 같은 방에서 '대화' 다시 누르기
  room.setFiles([file('a.png')]);
  assert.equal(await room.send([]), true);
  assert.equal(stale.calls.upload.length + stale.calls.insert.length, 0);
  assert.match(fresh.calls.upload[0][0], /^p\/ch-8\//);
  clearComposerSessions();
});

// 검수(2026-10-02) LOW — 첫 글 세션(sendFirstDm, feat/msgr-phone-v2)은 방 입력창보다 먼저 onDiscard 없이 만들어진다.
// 그 세션의 실패한 글을 방 입력창에서 다시 보낼 때는 방 입력창의 통로(onDiscard 방송 포함)가 쓰여야 다른 사람 화면에 빈 말풍선이 남지 않는다.
test('먼저 만든 세션에서 실패한 첨부만 글 — 방 입력창이 통로를 넘긴 뒤 다시 보내면 그 통로의 onDiscard로 방송한다', async () => {
  const key = JSON.stringify(['srv', 'me', '__personal__', 'ch-7']);
  const down = { message: async () => 70, upload: async () => { throw Error('offline'); }, attachment: async () => {}, discard: async () => { throw Error('offline'); } };
  const first = getComposerSession(key, down); // 첫 글 세션 — onDiscard 없음, 지우기도 실패
  first.setFiles([file('a.png')]);
  assert.equal(await first.send([]), false);
  const discarded = [];
  const roomIo = { message: async () => 71, upload: async () => { throw Error('offline'); }, attachment: async () => {}, discard: async (job) => { discarded.push(job.messageId); } };
  const room = bindComposerSession(key, roomIo); // 방 입력창
  assert.equal(room, first);
  assert.equal(await room.retry(), false);
  assert.deepEqual(discarded, [70], '다시 보내기의 지우기(=삭제 방송)는 방 입력창 통로가 맡는다');
  clearComposerSessions();
});
