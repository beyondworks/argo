import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshMessageWindow, mergeRefreshedMessages } from '../src/refresh-messages.mjs';

test('refresh fills more than one page of missed messages and updates older edits/deletions', async () => {
  const server = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, body: `Message ${i + 1}` }));
  server[0].body = 'Edited old message'; server[1].deleted_at = '2026-09-27';
  let pages = 0;
  const fresh = await refreshMessageWindow({ firstId: 1, throughId: 300, pageSize: 100, fetchPage: async (cursor, until, limit) => { pages++; return server.filter(m => m.id > cursor && m.id <= until).slice(0, limit); } });
  assert.equal(pages, 3); assert.equal(fresh.length, 300);
  assert.deepEqual(fresh.map(m => m.id), server.map(m => m.id));
  assert.equal(fresh[0].body, 'Edited old message'); assert.equal(fresh[1].deleted_at, '2026-09-27');
});

test('refresh retains prepended history and newer realtime rows in chronological order', () => {
  const merged = mergeRefreshedMessages([{ id: 1 }, { id: 2 }, { id: 4 }], [{ id: 2 }, { id: 3 }], 2, 3);
  assert.deepEqual(merged.map(m => m.id), [1, 2, 3, 4]);
});

test('page failure rejects atomically and cursor cannot loop forever', async () => {
  let calls = 0;
  await assert.rejects(refreshMessageWindow({ firstId: 1, throughId: 3, pageSize: 1, fetchPage: async () => { if (++calls > 1) throw new Error('offline'); return [{ id: 1 }]; } }), /offline/);
  await assert.rejects(refreshMessageWindow({ firstId: 2, throughId: 3, pageSize: 1, fetchPage: async () => [{ id: 1 }] }), /did not advance/);
});
