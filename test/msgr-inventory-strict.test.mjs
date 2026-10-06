// L1(2026-10-05 분리 검수): msgr.mjs listAgentsForInventory의 `{ strict: true }`를 지운 변이에도 테스트가 통과했다.
// 이 플래그가 빠지면 hub.listAgents가 못 읽은 카드를 조용히 빼고, 인벤토리 미러가 그 크루를 "카드가 사라진 크루"로 보아
// 메신저 행을 지운다 — 결재·자동화·실행 기록까지 연쇄 삭제된다(msgr_crews 삭제 연쇄).
// 잠그는 행동(실제 drain의 기본 인벤토리 + 가짜 DB): 못 읽은 카드(EISDIR)가 있는 회사에서 그 크루의 메신저 행(해제 상태)을 지우지 않는다.
// 대조군은 같은 카드가 읽히는 회사 — 카드가 정말 없는 해제 행은 지운다(삭제 기계가 실제로 돈다는 증거. 없으면 위 단언이 공허하다).
// 주의: 깨진 카드 하나에 drain이 던지는지 여부(M2)는 이 파일이 다루지 않는다 — 던지든 안 던지든 행을 지우면 안 된다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-invstrict-'));
process.env.ARGO_ENC_VAULT = '0';
const { paths } = await import('../src/workspace.mjs');
const M = await import('../src/gateway/msgr.mjs');
const ORG = 'aaaaaaaa-0000-4000-8000-000000000001';

async function workspace(WS, { badReadable }) {
  const p = paths(WS);
  for (const d of [p.root, join(p.root, 'agents'), join(p.root, 'chats')]) await mkdir(d, { recursive: true });
  await writeFile(p.company, JSON.stringify({ id: WS, name: 'x', lang: 'ko', created: '2026-10-05' }));
  await writeFile(join(p.root, 'agents', 'good.md'), '---\nname: 좋은\nrole: r\n---\n');
  if (badReadable) await writeFile(join(p.root, 'agents', 'bad.md'), '---\nname: bad\nrole: r\n---\n');
  else await mkdir(join(p.root, 'agents', 'bad.md'), { recursive: true }); // 디렉터리 = readFile EISDIR — 못 읽는 카드
}
const rows = [
  { id: 'r-good', org_id: ORG, slug: 'good', display_name: '좋은', role_text: 'r', status: 'active' },
  { id: 'r-bad', org_id: ORG, slug: 'bad', display_name: 'bad', role_text: 'r', status: 'available' }, // 소유자가 파견을 해제한 행 — 카드가 사라지면 미러가 지우는 종류
  { id: 'r-gone', org_id: ORG, slug: 'gone', display_name: 'gone', role_text: 'r', status: 'available' }, // 카드 자체가 없는 해제 행
];
async function runDrain(WS) {
  const deleted = [];
  const known = { myCrews: [], myCrewRows: rows, myOrgIds: [ORG], orgAllowDefaults: {}, personalCrewsInRooms: new Set(), crewInbox: [], pendingCrewRequests: [], docsIndex: [] };
  const db = new Proxy({}, { get(_, k) {
    if (k === 'then') return undefined;
    if (k === 'deleteCrews') return async (ids) => { deleted.push(...ids); };
    return async () => (k in known ? known[k] : null);
  } });
  // 기본 inventory(listAgentsForInventory)를 쓴다 — 인자로 주지 않는다. 던져도(M2) 지우면 안 된다는 것만 본다.
  await M.drain(WS, { db, uid: 'u1', lang: 'ko', enqueue: async () => {}, housekeeping: true, commandsFor: null }).catch(() => {});
  return deleted;
}

test('못 읽은 크루 카드의 메신저 행은 지우지 않는다 — 인벤토리가 strict로 카드를 읽는다', async () => {
  await workspace('inv-broken', { badReadable: false });
  const deleted = await runDrain('inv-broken');
  assert.ok(!deleted.includes('r-bad'), `못 읽은 카드의 행을 지웠다: ${deleted}`);
});

test('대조군 — 카드가 모두 읽히면 카드가 없는 해제 행만 지운다(삭제 기계가 실제로 돈다)', async () => {
  await workspace('inv-clean', { badReadable: true });
  const deleted = await runDrain('inv-clean');
  assert.deepEqual(deleted, ['r-gone'], '읽히는 카드(good·bad)의 행은 남기고 카드 없는 행만 지운다');
});
