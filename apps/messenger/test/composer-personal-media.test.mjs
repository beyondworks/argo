// 개인 방 첨부·보낸 글 링크 미리보기(2026-10-02) — 컴포저 전송 경로.
// 개인 방(org 없음)은 p/<방>/<글>/<키>로 올리고 첨부 행 org_id는 NULL(20261002100000 정책). 조직 방은 종전 그대로.
// 글이 다 올라간 뒤 링크가 있으면 엣지 함수(msgr-link-preview)를 한 번만 부른다 — 실패해도 전송은 성공으로 둔다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDelivery, composerTransport } from '../src/composer-delivery.mjs';

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
