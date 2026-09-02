// 스캐폴드 안내 노트(argo-사용법.md) 표식 — provision이 쓰는 파일명과 listDocs가 표시하는 이름이 한 상수(GUIDE_NOTE)라
// 어긋나지 않는지 실 fs(임시 ARGO_ROOT)로 잠근다. 표식이 빠지면 데크 연결 지표의 분모에 안내문이 섞여 신규 회사가
// 100%에 닿지 못한다(검수 L-1: 기억 3건이면 최대 67%).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let hub; let ws; let ROOT;
const WS = 'co-guid1';

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'argo-guide-'));
  process.env.ARGO_ROOT = ROOT;
  hub = await import('../src/hub.mjs');
  ws = await import('../src/workspace.mjs');
  await ws.createCompany(WS, '안내 표식', '유건'); // 실제 스캐폴드가 안내 노트를 만든다
  await writeFile(join(ws.paths(WS).notes, 'n1.md'), '# 노트\n\n[[n2]]\n');
  await writeFile(join(ws.paths(WS).notes, 'n2.md'), '# 노트2\n');
  await writeFile(join(ws.paths(WS).journal, '2026-09-02-x.md'), '# 일지\n\n[[notes/argo-사용법]]\n'); // 안내 노트만(전체 stem) 가리키는 일지 — 지표에선 고립
  await writeFile(join(ws.paths(WS).journal, 'argo-사용법.md'), '# 동명 일지\n'); // notes/ 밖의 동명 파일은 보통 기억(검수 LOW-1)
});
after(async () => { await rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

test('listDocs — 스캐폴드 안내 노트만 guide:true, 나머지는 필드 부재', async () => {
  const docs = await hub.listDocs(WS);
  const guide = docs.filter((d) => d.guide === true);
  assert.deepEqual(guide.map((d) => d.rel), ['notes/argo-사용법.md']);
  for (const d of docs) if (!d.guide) assert.equal('guide' in d, false, d.rel);
});

test('연결 지표 — 안내 노트는 지표 밖: 안내 노트만 가리키는 일지는 고립, 서로 엮인 노트만 있으면 100%', async () => {
  const { linkStats } = await import('../app/c/[ws]/graph2d-core.mjs');
  const docs = await hub.listDocs(WS);
  const pick = ({ linked, isolated }) => ({ linked, isolated });
  assert.deepEqual(pick(linkStats(docs)), { linked: 2, isolated: 2 }); // n1↔n2 연결, 일지 2건 고립(안내 노트만 가리킴·링크 없음)
  assert.deepEqual(pick(linkStats(docs.filter((d) => d.dir === 'notes'))), { linked: 2, isolated: 0 }); // n1↔n2 + 안내 노트 → 100%
});

test('자동 링크 — 안내 노트는 후보에서 빠진다(안내 노트만 있는 회사에 폴더 어휘 노트를 저장해도 엮이지 않는다)', async () => {
  const mem = await import('../src/memory.mjs');
  const A = 'co-auto1';
  await ws.createCompany(A, '자동 링크', '유건');
  await mem.saveNote(A, '우리 회사 기억 폴더 정리 방침', '크루가 노트를 남기고 프로젝트 산출물을 폴더에 정리한다. vault notes journal projects 폴더.', { create: true });
  const docs = await hub.listDocs(A);
  const guide = docs.find((d) => d.guide);
  const note = docs.find((d) => !d.guide);
  assert.ok(guide && note, '안내 노트 + 새 노트');
  assert.deepEqual(guide.links, []);
  assert.equal(note.links.some((l) => /argo-사용법/.test(l)), false);
});
