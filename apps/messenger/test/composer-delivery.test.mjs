import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerDelivery, composerTransport, getComposerSession, clearComposerSessions } from '../src/composer-delivery.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const file = (name) => ({ name, size: 4, type: 'text/plain' });
const transport = (overrides = {}) => ({ message: async () => 7, upload: async () => {}, attachment: async () => {}, ...overrides });

test('delayed send owns its snapshot and cannot clear the next draft; double click posts once', async () => {
  const wait = deferred(); let calls = 0;
  const session = createComposerDelivery(transport({ message: async () => { calls++; return wait.promise; } }));
  session.setText('first'); const sending = session.send([]);
  session.setText('next'); session.setFiles([file('next.txt')]);
  assert.equal(await session.send([]), false);
  wait.resolve(7); assert.equal(await sending, true);
  assert.equal(calls, 1); assert.equal(session.snapshot().text, 'next');
  assert.equal(session.snapshot().files[0].name, 'next.txt');
});

test('partial upload failure keeps failed File and retries only it on the original message', async () => {
  let messages = 0; const uploaded = []; const attached = []; let offline = true;
  const session = createComposerDelivery(transport({
    message: async () => { messages++; return 7; },
    upload: async (_job, item) => { uploaded.push(item.file.name); if (item.file.name === 'b.txt' && offline) throw Error('offline'); },
    attachment: async (job, item) => { attached.push([job.messageId, item.file.name]); },
  }));
  session.setFiles([file('a.txt'), file('b.txt')]);
  assert.equal(await session.send([]), false, 'attachment-only message accepted');
  assert.equal(session.snapshot().job.messageId, 7);
  assert.match(session.snapshot().job.error, /b.txt: offline/);
  session.setText('next draft'); offline = false;
  assert.equal(await session.retry(), true);
  assert.equal(messages, 1); assert.deepEqual(uploaded, ['a.txt', 'b.txt', 'b.txt']);
  assert.deepEqual(attached, [[7, 'a.txt'], [7, 'b.txt']]);
  assert.equal(session.snapshot().text, 'next draft');
});

test('metadata retry retains upload and stable attachment ID; unknown message result retains client ID', async () => {
  const ids = []; const attachmentIds = []; let failMessage = true; let failMeta = true; let uploads = 0;
  const session = createComposerDelivery(transport({
    message: async (job) => { ids.push(job.clientId); if (failMessage) throw Error('lost response'); return 9; },
    upload: async () => { uploads++; },
    attachment: async (_job, item) => { attachmentIds.push(item.id); if (failMeta) throw Error('metadata offline'); },
  }));
  session.setText('hello'); session.setFiles([file('x.txt')]);
  assert.equal(await session.send([]), false); failMessage = false;
  assert.equal(await session.retry(), false); failMeta = false;
  assert.equal(await session.retry(), true);
  assert.equal(new Set(ids).size, 1); assert.equal(new Set(attachmentIds).size, 1); assert.equal(uploads, 1);
});

test('channel navigation preserves draft and failed job, server/account keys isolate it; logout clears files', async () => {
  const one = getComposerSession('server/user/a', transport({ message: async () => { throw Error('offline'); } }));
  one.setText('unsent'); one.setFiles([file('private.txt')]); await one.send([]);
  one.setText('draft');
  assert.equal(getComposerSession('server/user/a', transport()), one);
  assert.equal(getComposerSession('server/user/b', transport()).snapshot().text, '');
  assert.equal(getComposerSession('other/user/a', transport()).snapshot().job, null);
  clearComposerSessions();
  assert.equal(one.snapshot().job, null);
  assert.equal(getComposerSession('server/user/a', transport()).snapshot().text, '');
  clearComposerSessions();
});

test('logout during message request stops attachment requests and late state delivery', async () => {
  const wait = deferred(); let uploads = 0;
  const session = createComposerDelivery(transport({ message: () => wait.promise, upload: async () => { uploads++; } }));
  session.setFiles([file('private.txt')]); const sending = session.send([]);
  session.dispose(); wait.resolve(8); await sending;
  assert.equal(uploads, 0); assert.equal(session.snapshot().job, null);
});

test('transport recovers committed responses and uses scoped message lookup and fixed storage path', async () => {
  const filters = []; const inserted = []; const paths = [];
  const client = {
    from(table) {
      let inserting = false;
      const query = {
        insert(row) { inserting = true; inserted.push([table, row]); return query; },
        select() { return query; }, eq(k, v) { filters.push([table, k, v]); return query; },
        single: async () => ({ error: { message: 'response lost' } }),
        maybeSingle: async () => ({ data: table === 'msgr_messages' ? { id: 7 } : { id: 'att-id', message_id: 7 } }),
        then(resolve) { resolve(inserting ? { error: { message: 'response lost' } } : { data: null }); },
      }; return query;
    },
    storage: { from: () => ({ upload: async (path) => { paths.push(path); return { error: { message: 'already exists' } }; },
      list: async (_prefix, { search }) => ({ data: [{ name: search }] }) }) },
  };
  const io = composerTransport(client, { orgId: 'org', chId: 'ch', uid: 'user' });
  const job = { clientId: 'stable-client', body: 'body', mentions: [] };
  job.messageId = await io.message(job);
  const item = { id: 'att-id', key: '0-test.txt', file: file('test.txt') };
  await io.upload(job, item); await io.attachment(job, item);
  assert.equal(job.messageId, 7);
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'author_user_id' && v === 'user'));
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'channel_id' && v === 'ch'));
  assert.ok(filters.some(([t, k, v]) => t === 'msgr_messages' && k === 'client_msg_id' && v === 'stable-client'));
  assert.equal(inserted[1][1].storage_path, paths[0]);
  assert.equal(inserted[1][1].id, 'att-id');
});
