// 능동 비서 상태(<회사>/.assistant/)는 기기 로컬이다 — 버전 섞임(#863 분리 검수 LOW): 새 버전에서 상태 파일을 만든 기기를 옛 버전으로 내리면,
// 옛 EXCLUDE에는 .assistant 줄이 없어 그 기기가 상태 파일을 올린다. 새 버전 기기의 EXCLUDE는 로컬 walk에만 걸리므로, 원격에만 있는 그 파일을
// 받아 자기 상태(보낸 키·대기열)를 덮고 다음 사이클에 '로컬 삭제'로 원격을 지운다. 그래서 .assistant는 .local-assets와 같은 계약 —
// diff 불가시(올리기·받기·삭제 전파 전부 건너뜀)로 다룬다(local-asset-sync.test.mjs와 같은 가짜 저장소).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-asst-sync-'));
process.env.ARGO_ROOT = root;
process.env.HOME = await mkdtemp(join(tmpdir(), 'argo-asst-sync-home-'));
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://selfhost.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = randomBytes(20).toString('hex');
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.ARGO_TENANT_OWNER;
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { openSecretCompat } = await import('../src/secretbox.mjs');
await ensureAccountKey({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: randomBytes(32).toString('base64') } }) }) }) }) }, 'owner-asst-sync');
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: createHash('sha1').update(buf).digest('hex').slice(0, 16) });

async function setup(ws, { local = {}, state = {}, remote = {} } = {}) {
  await mkdir(join(root, ws), { recursive: true });
  for (const [rel, buf] of Object.entries(local)) {
    await mkdir(dirname(join(root, ws, rel)), { recursive: true });
    await writeFile(join(root, ws, rel), buf);
  }
  await writeFile(join(root, ws, '.sync-state.json'), JSON.stringify({ files: state }));
  const manifestKey = `owner/${ws}/__manifest__.json`;
  const store = new Map([[manifestKey, Buffer.from(JSON.stringify({ files: Object.fromEntries(Object.entries(remote).map(([rel, buf]) => [rel, meta(buf, Date.now() + 100000)])) }))]]);
  for (const [rel, buf] of Object.entries(remote)) store.set(`owner/${ws}/${rel}`, buf);
  const removed = [];
  const bucket = {
    async download(key) {
      const data = store.get(key);
      return data ? { data: { arrayBuffer: async () => Uint8Array.from(data).buffer } } : { error: { message: 'Object not found', status: 400, statusCode: '404' } };
    },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return {}; },
    async remove(keys) { for (const key of keys) { removed.push(key); store.delete(key); } return {}; },
  };
  _setSyncClientForTest({ storage: { from: () => bucket } });
  return { store, manifestKey, removed };
}

test('옛 버전 기기가 올린 .assistant/state.json — 새 기기는 받지도(자기 상태를 덮지 않음) 지우지도 올리지도 않는다, 두 사이클 내내', async () => {
  const ws = 'asst-mixed';
  const mine = Buffer.from(JSON.stringify({ v: 1, sent: { 'cal:e1:2026-10-08T05:00:00.000Z:pre': 1 }, pending: [], outbox: null }));
  const theirs = Buffer.from(JSON.stringify({ v: 1, sent: {}, pending: [], outbox: { kind: 'am', basis: 'sum:am:2026-10-06', body: '옛 묶음', keys: [] } }));
  const note = Buffer.from('# 평범한 노트');
  const { store, manifestKey, removed } = await setup(ws, {
    local: { '.assistant/state.json': mine, 'vault/notes/a.md': note },
    remote: { '.assistant/state.json': theirs },
  });
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const result = await syncCompany(ws, 'owner');
    assert.equal(result.failed, 0, `사이클 ${cycle}`);
    assert.deepEqual(await readFile(join(root, ws, '.assistant/state.json')), mine, `사이클 ${cycle}: 로컬 상태를 원격 사본으로 덮지 않는다`);
    assert.deepEqual(store.get(`owner/${ws}/.assistant/state.json`), theirs, `사이클 ${cycle}: 원격 사본을 내 것으로 덮거나 지우지 않는다`);
  }
  assert.deepEqual(removed.filter((k) => k.includes('.assistant')), [], '삭제 전파 0');
  const manifest = JSON.parse(openSecretCompat(store.get(manifestKey)));
  assert.ok(manifest.files['vault/notes/a.md'], '평범한 파일은 그대로 동기화된다');
});

test('원격에 .assistant가 없고 로컬에만 있으면 — 올리지 않는다(EXCLUDE 그대로)', async () => {
  const ws = 'asst-local-only';
  const mine = Buffer.from('{"v":1}');
  const { store } = await setup(ws, { local: { '.assistant/state.json': mine } });
  assert.equal((await syncCompany(ws, 'owner')).failed, 0);
  assert.equal(store.has(`owner/${ws}/.assistant/state.json`), false);
  assert.deepEqual(await readFile(join(root, ws, '.assistant/state.json')), mine);
});
