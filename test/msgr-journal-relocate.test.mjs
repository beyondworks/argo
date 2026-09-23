// 채널·조직 기억은 서버에만(유건 결정 2026-09-24) — PC에 남은 채널 태그 일지는 지우지 않고 점 폴더 .msgr-journal/로 옮긴다.
// 옮기면 _index.md·검색 색인·recall에서 빠지고(다른 채널 턴으로 새는 길), 개인 일지는 그대로 남는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-relocate-'));
const { paths } = await import('../src/workspace.mjs');
const { relocateOrgJournals, updateIndex, vaultDocsForTest } = await import('../src/memory.mjs');
const { docKind } = await import('../src/vaultdoc.mjs');
const WS = 'co-a';

test('채널 태그 일지는 .msgr-journal/로 옮겨지고 색인·recall에서 빠지며, 개인 일지는 남는다', async () => {
  const p = paths(WS);
  await mkdir(p.journal, { recursive: true });
  const tagged = '2026-09-23-seoyun.org-o1-ch-c1.md';
  await writeFile(join(p.journal, tagged), '# 채널 일지\n\n## 10:00 — 인사 평가\n기밀', 'utf8');
  await writeFile(join(p.journal, '2026-09-23-seoyun.md'), '# 개인 일지\n', 'utf8');
  await updateIndex(WS);
  assert.equal(await relocateOrgJournals(WS), 1);
  assert.deepEqual(await readdir(p.journal), ['2026-09-23-seoyun.md']);
  assert.match(await readFile(join(p.root, '.msgr-journal', tagged), 'utf8'), /기밀/, '지우지 않고 옮긴다');
  assert.doesNotMatch(await readFile(p.index, 'utf8'), /org-o1/);
  assert.ok(!(await vaultDocsForTest(WS)).some((d) => /org-o1/.test(d.rel)));
  assert.equal(await relocateOrgJournals(WS), 0, '두 번째는 할 일 없음');
  await writeFile(join(p.journal, tagged), await readFile(join(p.root, '.msgr-journal', tagged), 'utf8'), 'utf8'); // 다른 기기가 같은 파일을 다시 내려받음
  assert.equal(await relocateOrgJournals(WS), 1);
  assert.equal((await readFile(join(p.root, '.msgr-journal', tagged), 'utf8')).match(/기밀/g).length, 1, '같은 내용은 이어 붙이지 않는다');
  const { EXCLUDE } = await import('../src/sync.mjs');
  assert.equal(EXCLUDE(`.msgr-journal/${tagged}`), true, '동기화 제외(검수 #691 M2)');
  assert.equal(docKind(`journal/${tagged}`), 'other', '다른 기기가 동기화로 다시 내려도 색인에 오르지 않는다');
});

test('퇴장 회수: 서버가 명시적으로 false라고 답한 채널의 일지만 지운다 — null·답 없음은 보존', async () => {
  const { purgeDepartedJournals } = await import('../src/memory.mjs');
  const dir = join(paths(WS).root, '.msgr-journal');
  const O = '00000000-0000-4000-8000-000000000001', A = '00000000-0000-4000-8000-00000000000a', B = '00000000-0000-4000-8000-00000000000b', C = '00000000-0000-4000-8000-00000000000c';
  for (const ch of [A, B, C]) await writeFile(join(dir, `2026-09-24-seoyun.org-${O}-ch-${ch}.md`), 'x', 'utf8');
  const before = (await readdir(dir)).length;
  assert.equal(await purgeDepartedJournals(WS, async () => null), 0, '옛 서버·조회 실패');
  assert.equal(await purgeDepartedJournals(WS, async () => { throw new Error('net'); }), 0);
  assert.equal(await purgeDepartedJournals(WS, async () => new Map([[A, false], [B, true]])), 1, 'A만 — C는 답이 없어 보존');
  const left = await readdir(dir);
  assert.equal(left.length, before - 1);
  assert.ok(!left.some((n) => n.includes(A)) && left.some((n) => n.includes(B)) && left.some((n) => n.includes(C)));
});
