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
  await writeFile(join(ws.paths(WS).journal, '2026-09-02-x.md'), '# 일지\n\n[[argo-사용법]]\n'); // 안내 노트를 가리키는 링크는 보통 해석
});
after(async () => { await rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

test('listDocs — 스캐폴드 안내 노트만 guide:true, 나머지는 필드 부재', async () => {
  const docs = await hub.listDocs(WS);
  const guide = docs.filter((d) => d.guide === true);
  assert.deepEqual(guide.map((d) => d.rel), ['notes/argo-사용법.md']);
  for (const d of docs) if (!d.guide) assert.equal('guide' in d, false, d.rel);
});

test('연결 지표 — 안내 노트가 링크를 받으면 연결로, 안 받으면 분모에서 빠져 전건 연결 회사가 100%', async () => {
  const { linkStats } = await import('../app/c/[ws]/graph2d-core.mjs');
  const docs = await hub.listDocs(WS);
  const withLink = linkStats(docs); // 일지가 안내 노트를 가리킨다 → 안내 노트도 연결됨
  assert.deepEqual({ linked: withLink.linked, isolated: withLink.isolated }, { linked: 4, isolated: 0 });
  const noLink = linkStats(docs.map((d) => (d.dir === 'journal' ? { ...d, links: [] } : d)));
  assert.deepEqual({ linked: noLink.linked, isolated: noLink.isolated }, { linked: 2, isolated: 1 }); // 일지가 고립, 안내 노트는 분모 밖
  assert.deepEqual({ linked: linkStats(docs.filter((d) => d.dir === 'notes')).linked, isolated: linkStats(docs.filter((d) => d.dir === 'notes')).isolated }, { linked: 2, isolated: 0 }); // n1↔n2 + 안내 노트 → 100%
});
