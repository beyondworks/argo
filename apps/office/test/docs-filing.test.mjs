// 서명본 → 문서함 보관(분리 검수 LOW 4): 넣는 데 실패하면 '보관함' 표시를 하지 않는다(다음에 다시), 다른 관리자가 먼저 넣었으면(file_conflict) 표시만 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileSignedCopies } from '../src/docs/filing.js';

const todo = [{ id: 'e1', title: 'A' }, { id: 'e2', title: 'B' }, { id: 'e3', title: 'C' }];

test('LOW 4: 실패한 건은 표시하지 않고, 성공·이미 들어 있음만 표시한다 — 서명본 참조(ref)를 함께 넘긴다', async () => {
  const marked = [], entries = [];
  const results = { e1: { id: 'f1' }, e2: null, e3: { conflict: true } };
  const n = await fileSignedCopies(todo, {
    pdf: async (e) => new Uint8Array([e.id.length]),
    entryOf: (e) => ({ title: e.title, refEsign: e.id }),
    file: async (entry) => { entries.push(entry); return results[entry.refEsign]; },
    mark: async (id) => { marked.push(id); },
  });
  assert.deepEqual(marked, ['e1', 'e3']);
  assert.equal(n, 2);
  assert.deepEqual(entries.map((x) => x.refEsign), ['e1', 'e2', 'e3']);
});

test('LOW 4: 서명본을 못 읽거나 표시가 실패해도 다음 건은 이어서 한다', async () => {
  const marked = [];
  const n = await fileSignedCopies(todo, {
    pdf: async (e) => { if (e.id === 'e1') throw new Error('missing'); return new Uint8Array(1); },
    entryOf: (e) => ({ refEsign: e.id }),
    file: async () => ({ id: 'x' }),
    mark: async (id) => { if (id === 'e2') throw new Error('net'); marked.push(id); },
    warn: () => {},
  });
  assert.deepEqual(marked, ['e3']); assert.equal(n, 1);
});
