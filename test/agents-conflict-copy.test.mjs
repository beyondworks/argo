// 동기화 충돌 사본(`<slug>.conflict-<기기>-<ts>.md`, sync.mjs)은 크루가 아니다 — 목록에 넣으면 사이드바와 메신저 미러에
// 같은 이름의 크루가 하나 더 생긴다(실사고 2026-10-04: 메신저에 '페퍼' 사본 크루 2개). 사본 파일은 지우지 않는다(보존).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-agents-conflict-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { listAgents } = await import('../src/hub.mjs');
const WS = 'conflict-co';
await createCompany(WS, '사본 회사', '', '77777777-7777-4777-8777-777777777777', 'ko');
const card = (name) => `---\nname: ${name}\nrole: 비서\n---\n\n지시\n`;

test('listAgents — 충돌 사본은 빼고, 규칙 밖 이름의 카드(pepper copy.md)는 그대로 보인다', async () => {
  const dir = paths(WS).agents;
  await writeFile(join(dir, 'pepper.md'), card('페퍼'));
  await writeFile(join(dir, 'pepper.conflict-mac-1759000000000.md'), card('페퍼'));
  await writeFile(join(dir, 'pepper copy.md'), card('페퍼 복제'));
  const slugs = (await listAgents(WS)).map((a) => a.slug).sort();
  assert.deepEqual(slugs, ['pepper', 'pepper copy']);
  await access(join(dir, 'pepper.conflict-mac-1759000000000.md')); // 사본은 디스크에 남는다
});
