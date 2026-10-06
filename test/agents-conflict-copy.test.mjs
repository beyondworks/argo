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

// 검수 #826 MEDIUM-1: 사본이 목록에서 빠지면 미러가 '파견 해제(available)'한 사본 조직 행을 지웠다(그 크루의 결재·자동화·실행 기록 연쇄 삭제, 글은 작성자 NULL).
// 사본 행 정리는 대상·행 수를 보여 드리고 승인받아 따로 한다 — 미러는 사본 행을 지우지 않는다. 해고한 진짜 크루의 available 행은 종전대로 지운다.
test('mirrorInventory — 카드가 없는 available 행 중 충돌 사본은 지우지 않고, 해고한 크루 행은 종전대로 지운다', async () => {
  const { mirrorInventory } = await import('../src/gateway/msgr.mjs');
  const O = 'aaaaaaaa-0000-4000-8000-000000000001';
  const rows = [
    { id: 'real', org_id: O, slug: 'pepper', display_name: '페퍼', role_text: '비서', status: 'active' },
    { id: 'copy-off', org_id: O, slug: 'pepper.conflict-mac-1759000000000', display_name: '페퍼', role_text: '비서', status: 'available' },
    { id: 'fired', org_id: O, slug: 'gone', display_name: '퇴사', role_text: null, status: 'available' },
  ];
  const calls = [];
  const db = { async myOrgIds() { return [O]; }, async myCrewRows() { return rows; }, async orgAllowDefaults(ids) { return Object.fromEntries(ids.map((i) => [i, 'owner'])); },
    async upsertAvailable(r) { calls.push(['upsertAvailable', r]); }, async updateCrewInfo(id) { calls.push(['updateCrewInfo', id]); }, async deleteCrews(ids) { calls.push(['deleteCrews', ids]); } };
  const agents = (await listAgents(WS)).map((a) => ({ slug: a.slug, name: a.name, role: a.role }));
  await mirrorInventory(WS, { db, uid: 'u1', agents });
  assert.deepEqual(calls.filter(([k]) => k === 'deleteCrews').flatMap(([, ids]) => ids), ['fired']);
});
