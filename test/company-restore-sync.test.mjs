// F14 연동 — 되돌린 회사가 동기화의 tombstone 규칙(sync.mjs syncTombstones 1.5)에 다시 보관되지 않고, 로컬·원격 보관 마커가
// 철회되는지 실제 함수로 확인한다(가짜 저장소). 대조군: mtime을 옮기지 않고 폴더만 되돌리면 1.5가 다시 보관한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-restore-sync-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://selfhost.local'; // 서비스 모드(셀프호스트) — cred-sync.test.mjs와 같은 하네스
process.env.SUPABASE_SERVICE_ROLE_KEY = 'selfhost-service-key-not-real';
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.ARGO_TENANT_OWNER;
const W = await import('../src/workspace.mjs');
const { _setSyncClientForTest, _tombstonesForTest } = await import('../src/sync.mjs');
const OWNER = 'o';
function fakeStorage() {
  const store = new Map();
  const bucket = {
    async download(key) { return store.has(key) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(key)).buffer }, error: null } : { data: null, error: { message: 'Object not found', status: 404 } }; },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list(prefix) { const p = prefix.endsWith('/') ? prefix : `${prefix}/`; return { data: [...store.keys()].filter((k) => k.startsWith(p) && !k.slice(p.length).includes('/')).map((k) => ({ name: k.slice(p.length), id: 'f' })) }; },
  };
  return { store, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

test('되돌린 회사는 동기화가 다시 보관하지 않고, 로컬·원격 보관 마커를 철회한다', async () => {
  const fake = fakeStorage(); _setSyncClientForTest(fake);
  await W.createCompany('co-rs', '되돌릴 회사', 'captain', OWNER);
  await W.archiveCompany('co-rs');
  await _tombstonesForTest.syncTombstones(OWNER); // 보관 마커가 원격으로 올라간 상태(다른 기기에도 전파된 상황)
  assert.ok(fake.store.has(`${OWNER}/.tombstones/co-rs.json`));
  const it = (await W.listArchivedCompanies()).find((x) => x.wsId === 'co-rs');
  await W.restoreArchivedCompany(it.archiveId);
  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.equal(tombs.has('co-rs'), false, '보관 대상에서 빠진다');
  assert.ok(existsSync(W.paths('co-rs').company), '다시 보관되지 않는다');
  assert.equal(existsSync(join(W.TOMBSTONE_DIR, 'co-rs.json')), false, '로컬 보관 마커 철회');
  assert.equal(fake.store.has(`${OWNER}/.tombstones/co-rs.json`), false, '원격 보관 마커 철회(같은 오너)');
});

test('대조군 — mtime을 옮기지 않고 폴더만 되돌리면 동기화가 다시 보관한다(되돌리기의 mtime 단계가 필요한 이유)', async () => {
  const fake = fakeStorage(); _setSyncClientForTest(fake);
  await W.createCompany('co-ctl', '대조군 회사', 'captain', OWNER);
  await new Promise((r) => setTimeout(r, 20)); // company.json mtime < 보관 시각
  await W.archiveCompany('co-ctl');
  const it = (await W.listArchivedCompanies()).find((x) => x.wsId === 'co-ctl');
  await rename(join(W.WS_ROOT, '.archive', it.archiveId), W.paths('co-ctl').root); // 손으로 되돌리기(mtime 그대로)
  await _tombstonesForTest.syncTombstones(OWNER);
  assert.equal(existsSync(W.paths('co-ctl').company), false, '다시 보관됐다');
  assert.ok((await readdir(join(W.WS_ROOT, '.archive'))).some((n) => n.endsWith('-co-ctl')));
});
