// listDocs mtime 캐시 — 같은 파일은 다시 읽지 않고, 바뀐·새·지운 파일만 반영한다(옵시디언 가져오기 상한 10,000의 근거).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-listdocs-cache-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { listDocs, listDocsStats, countVaultDocs, listCompanies } = await import('../src/hub.mjs');
const { invalidatePath } = await import('../src/memindex.mjs');
const { dropDocCache, docCache } = await import('../src/doc-cache.mjs');
const { rm: rmFile } = await import('node:fs/promises');
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
  // 삭제 정리: 캐시 항목 수가 파일 수와 같다(검수 MEDIUM-1: 출력은 readdir로 만들어져 잔재가 안 보인다 — 항목 수로 잠근다)
  const notes = fourth.filter((d) => d.dir === 'notes').length; const others = fourth.length - notes;
  assert.equal(listDocsStats.entries(ws), notes + others, '지운 파일의 캐시 항목이 사라진다');
  // mtime을 보존한 채 크기만 바뀐 파일도 다시 읽는다(size 또는 ctime 성분 — 검수 2R: 실제 판별은 ctime이 먼저 한다)
  const before = await stat(f('c.md'));
  await writeFile(f('c.md'), '# 감마 길어진 제목\nCCCC'); await utimes(f('c.md'), before.atime, before.mtime);
  const r5 = listDocsStats.reads; const fifth = await listDocs(ws);
  assert.equal(listDocsStats.reads - r5, 1, 'mtime 같고 크기만 달라도 다시 읽는다');
  assert.ok(fifth.some((d) => d.title === '감마 길어진 제목'));
  // mtime·size 둘 다 같은 재작성(동기화 수신이 정수 ms mtime을 심는 경우) — ctime이 잡는다(검수 HIGH-1 재현 → 처방 A)
  const same = await stat(f('c.md'));
  await new Promise((r) => setTimeout(r, 25)); // ctime 해상도가 거친 플랫폼(NTFS 15.6ms 틱)에서도 틱이 갈리게(검수 2R MEDIUM-A 시뮬 13/15 red → 10/10 green)
  await writeFile(f('c.md'), '# 감마 길어진 제묵\nCCCC'); await utimes(f('c.md'), same.atime, same.mtime);
  const after = await stat(f('c.md')); assert.equal(after.mtimeMs, same.mtimeMs); assert.equal(after.size, same.size);
  assert.notEqual(after.ctimeMs, same.ctimeMs, '전제: 이 플랫폼에서 utimes는 ctime을 되돌리지 못한다');
  const r6 = listDocsStats.reads; const sixth = await listDocs(ws);
  assert.equal(listDocsStats.reads - r6, 1, 'mtime·size가 같아도 ctime이 달라 다시 읽는다');
  assert.ok(sixth.some((d) => d.title === '감마 길어진 제묵'));
});

test('listDocs — 무효화 프로토콜(invalidatePath)·회사 폐기(dropDocCache)·동시 첫 로드 합류·경량 카운트', async () => {
  const ws = 'cache-co-2';
  await createCompany(ws, '캐시 회사 2', 'alpha');
  const p = paths(ws); const f = (n) => join(p.notes, n);
  await writeFile(f('a.md'), '# 하나\nA'); await writeFile(f('b.md'), '# 둘\nB');
  // 동시 첫 로드 3회 = 전수 읽기 1회
  const r0 = listDocsStats.reads; const [x, y, z] = await Promise.all([listDocs(ws), listDocs(ws), listDocs(ws)]);
  const n = x.length; assert.equal(listDocsStats.reads - r0, n, `동시 호출은 한 번만 읽는다(${n}건)`); assert.equal(y.length, n); assert.equal(z.length, n);
  // invalidatePath: 키가 같아도(우연) 그 파일은 다시 읽는다
  const r1 = listDocsStats.reads; await invalidatePath(f('a.md')); await listDocs(ws);
  assert.equal(listDocsStats.reads - r1, 1, 'invalidatePath로 뺀 파일만 다시 읽는다');
  // 회사 폐기
  dropDocCache(ws); assert.equal(docCache.has(ws), false);
  const r2 = listDocsStats.reads; await listDocs(ws); assert.equal(listDocsStats.reads - r2, n, '폐기 뒤 첫 로드는 전수');
  // 경량 카운트 = listDocs 길이, listCompanies 기억 칩과 동일 셈법
  assert.equal(await countVaultDocs(ws), n);
  const co = (await listCompanies()).find((c) => c.id === ws); assert.equal(co.memories, n, 'projects 0이면 memories = 문서 수');
  // 진행 중 첫 로드와 폐기가 겹치면 폐기가 이긴다(MEDIUM-B) — 순회 중 파일이 사라져도 나머지는 살아남는다(MEDIUM-C)
  dropDocCache(ws);
  const loading = listDocs(ws); dropDocCache(ws); await loading;
  assert.equal(docCache.has(ws), false, '진행 중이던 로드가 폐기된 캐시를 되살리지 않는다');
  const orig = await listDocs(ws); assert.ok(orig.length >= 2);
  dropDocCache(ws);
  const p2 = listDocs(ws); await rmFile(f('b.md')); const survived = await p2; // 삭제가 순회와 겹쳐도 예외 없이 나머지 반환(경합이라 삭제분 포함 여부는 비결정)
  assert.ok(survived.length >= orig.length - 1 && survived.every((d) => d.title !== undefined));
  assert.deepEqual((await listDocs(ws)).filter((d) => !d.guide && d.dir === 'notes').map((d) => d.title), ['하나']);
});
