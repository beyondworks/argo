// listDocs mtime 캐시 — 같은 파일은 다시 읽지 않고, 바뀐·새·지운 파일만 반영한다(옵시디언 가져오기 상한 10,000의 근거).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-listdocs-cache-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { listDocs, listDocsStats } = await import('../src/hub.mjs');
const { MAX_COUNT } = await import('../src/obsidian-import.mjs');

test('listDocs — 두 번째 호출은 파일을 읽지 않고, 수정·추가·삭제만 다시 읽는다', async () => {
  const ws = 'cache-co';
  await createCompany(ws, '캐시 회사', 'alpha');
  const p = paths(ws);
  const f = (n) => join(p.notes, n);
  await writeFile(f('a.md'), '# 알파\n본문 A [[베타]]'); await writeFile(f('b.md'), '# 베타\n본문 B');
  const base = listDocsStats.reads;
  const first = await listDocs(ws);
  const readsFirst = listDocsStats.reads - base;
  assert.ok(readsFirst >= 2, `첫 호출은 전수 읽기(${readsFirst})`);
  const second = await listDocs(ws);
  assert.equal(listDocsStats.reads - base, readsFirst, '두 번째 호출은 readFile 0');
  assert.deepEqual(second.map((d) => d.title).sort(), first.map((d) => d.title).sort());
  // 수정: 본문이 바뀌면(mtime·size 변동) 그 파일만 다시 읽어 제목이 갱신된다
  await writeFile(f('a.md'), '# 알파2\n본문 A2'); await utimes(f('a.md'), new Date(), new Date(Date.now() + 5000));
  const third = await listDocs(ws);
  assert.equal(listDocsStats.reads - base, readsFirst + 1, '바뀐 파일 하나만');
  assert.ok(third.some((d) => d.title === '알파2') && !third.some((d) => d.title === '알파'));
  // 추가·삭제
  await writeFile(f('c.md'), '# 감마\nC'); await rm(f('b.md'));
  const fourth = await listDocs(ws);
  assert.equal(listDocsStats.reads - base, readsFirst + 2, '새 파일 하나만');
  assert.deepEqual(fourth.filter((d) => d.dir === 'notes' && !d.guide).map((d) => d.title).sort(), ['감마', '알파2'].sort(), '지운 파일은 사라진다');
  assert.equal(MAX_COUNT, 10_000, '가져오기 상한(캐시 근거로 상향)');
});
