// 회사 카드 기억 칩(listCompanies.memories) == 기억 트리 칩(listDocs + listProjectDocs 합)의
// 행동 계약 테스트(실 fs, 임시 ARGO_ROOT). 두 화면이 다른 셈법을 쓰면 숫자가 갈라진다
// (PR #204 LOW → PR #208). memories는 경량 카운트(countProjectFiles — readdir만)로 계산되므로,
// 포함/제외 규칙(닷파일·심링크 제외, 재귀, md/비md 무구분)이 listProjectDocs와 갈라지면 여기서 잡힌다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let hub; let ROOT;
const WS = 'co-par1';

before(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'argo-parity-'));
  process.env.ARGO_ROOT = ROOT;
  hub = await import('../src/hub.mjs');
  const ws = join(ROOT, WS);
  for (const d of ['notes', 'journal', 'conversations', join('projects', 'alpha', 'deep')]) {
    await mkdir(join(ws, 'vault', d), { recursive: true });
  }
  await writeFile(join(ws, 'company.json'), JSON.stringify({ id: WS, name: '패리티', created: '2026-01-01' }));
  // 기억(docs) 3
  await writeFile(join(ws, 'vault', 'notes', 'n1.md'), '# 노트');
  await writeFile(join(ws, 'vault', 'journal', '2026-01-01.md'), '# 일지');
  await writeFile(join(ws, 'vault', 'conversations', '2026-01-01T00-00-00-a.md'), '# 대화');
  // 산출물(projects) 4 — 루트 직치 + 중첩 + md/비md 혼합
  await writeFile(join(ws, 'vault', 'projects', 'root.md'), '# 루트');
  await writeFile(join(ws, 'vault', 'projects', 'alpha', 'a.md'), '# a');
  await writeFile(join(ws, 'vault', 'projects', 'alpha', 'data.csv'), 'x,y');
  await writeFile(join(ws, 'vault', 'projects', 'alpha', 'deep', 'b.txt'), 'b');
  // 두 셈법 모두 제외해야 하는 것들 — 규칙이 한쪽만 갈라지면 합이 어긋난다
  await writeFile(join(ws, 'vault', 'projects', 'alpha', '.hidden'), 'dot'); // 닷파일
  await writeFile(join(ROOT, 'outside.md'), 'x');
  await symlink(join(ROOT, 'outside.md'), join(ws, 'vault', 'projects', 'alpha', 'leak.md')); // 심링크
});
after(async () => { await rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

test('회사 카드 memories == 기억 트리 칩(listDocs+listProjectDocs 합)', async () => {
  const co = (await hub.listCompanies()).find((c) => c.id === WS);
  assert.ok(co, '시드 회사가 목록에 있어야 한다');
  const docs = await hub.listDocs(WS);
  const projects = await hub.listProjectDocs(WS);
  // 전제 고정(시드 직접 통제) — 파생 단언이 0==0 우연 통과로 무력화되는 것 방지
  assert.equal(docs.length, 3, '기억 = 노트+일지+대화');
  assert.equal(projects.length, 4, '산출물 = md 2 + csv + txt (닷파일·심링크 제외)');
  assert.equal(co.memories, docs.length + projects.length,
    '회사 카드 칩과 기억 트리 칩은 같은 셈법이어야 한다(두 화면 숫자 불일치 금지)');
});

test('경량 카운트(countProjectFiles)의 규칙 == listProjectDocs의 규칙', async () => {
  assert.equal(await hub.countProjectFiles(WS), (await hub.listProjectDocs(WS)).length,
    '카운트 전용 walk가 목록 walk와 다른 것을 세면 안 된다(닷파일·심링크·재귀 규칙 동일)');
});
