// Pro 클라우드 5GiB(src/sync.mjs QUOTA_* 주석, 서버 20261019130000) — 행동 시험(가짜 저장소, 임시 ARGO_ROOT).
// 계약: ① 서버가 PT402 quota_exceeded로 거절하면 그 파일은 '할당량'으로 표시되고(quotaHit) 다른 파일·받기는 계속된다
// ② 한도가 찬 사이클(opts.quotaFull)은 새 파일·수정을 보내지 않고(네트워크 0) 실패가 아니라 '이 기기에 남김'으로 센다 — 받기는 계속, 매니페스트는 보낸다,
//    로컬·원격 삭제 0 ③ 자리가 나면 다음 사이클에 못 올린 파일이 '신규'로 올라간다(기록에 들어가지 않았으므로 유실 없음).
// ⚠ ARGO_ROOT는 sync.mjs 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-quota-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, _setSyncClientForTest, isQuotaError } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const meta = (b) => ({ m: 1000, s: b.length, h: hashBuf(b) });
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };
// storage-api가 정책 함수의 raise를 감춰 돌려주는 모양(메신저 첨부 한도와 같은 체계 — 20261011150000 머리말)
const QUOTA = { message: 'database error, code: PT402', status: 400, statusCode: '400' };
const isManifest = (k) => k.endsWith('/__manifest__.json');

function storage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const state = {};
  const log = { uploads: [], removed: [] };
  const bucket = {
    async download(k) { k = k.split('?')[0]; return store.has(k) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(k)).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND }; },
    async upload(k, blob) { log.uploads.push(k); const forced = state.uploadError?.(k); if (forced) return { error: forced }; store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { log.removed.push(...keys); for (const k of keys) store.delete(k); return { data: [], error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, state, log };
}

/** 이미 동기화된 회사(기록·원격 n개) + 이 기기의 새 파일 new0.md + 다른 기기가 고친 n1(받을 것) */
async function seed(WS, n = 3) {
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {}, files = {}, store = {};
  for (let i = 0; i < n; i++) {
    const rel = `vault/notes/n${i}.md`, b = Buffer.from(`# ${i}\n`);
    base[rel] = meta(b); files[rel] = meta(b); store[`${OWNER}/${WS}/${rel}`] = b;
    await writeFile(join(dir, `n${i}.md`), b);
  }
  const theirs = Buffer.from('# 1 다른 기기\n');
  files['vault/notes/n1.md'] = meta(theirs); store[`${OWNER}/${WS}/vault/notes/n1.md`] = theirs;
  await writeFile(join(dir, 'new0.md'), '# 이 기기의 새 파일\n');
  await writeFile(join(dir, 'n2.md'), '# 2 이 기기에서 고침\n');
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  store[`${OWNER}/${WS}/__manifest__.json`] = sealSecret(Buffer.from(JSON.stringify({ files })));
  return { dir };
}

test('isQuotaError — storage-api 감춘 문구(code: PT402)·원문(quota_exceeded) 둘 다, 다른 거절은 아니다', () => {
  assert.equal(isQuotaError(QUOTA), true);
  assert.equal(isQuotaError({ message: 'quota_exceeded' }), true);
  assert.equal(isQuotaError({ message: 'new row violates row-level security policy' }), false);
  assert.equal(isQuotaError(null), false);
});

test('① 서버가 PT402로 거절 — 그 파일만 quotaHit, 받기는 계속, 로컬·원격 삭제 0', async () => {
  const WS = 'q-reject';
  const { dir } = await seed(WS);
  const real = storage(Object.fromEntries((await seedStore(WS)).entries()));
  real.state.uploadError = (k) => (isManifest(k) ? null : QUOTA);
  _setSyncClientForTest(real.client);
  const r = await syncCompany(WS, OWNER, false).catch((e) => ({ err: e }));
  assert.equal(r.err, undefined, String(r.err?.message));
  assert.ok(r.quotaHit >= 2, `할당량으로 못 올린 파일(new0·n2) — ${r.quotaHit}`);
  assert.equal(r.pulled, 1, '다른 기기가 고친 n1은 받는다');
  assert.equal(await readFile(join(dir, 'n1.md'), 'utf8'), '# 1 다른 기기\n');
  assert.equal(r.deletedL + r.deletedR, 0); assert.deepEqual(real.log.removed, []);
  assert.equal(await readFile(join(dir, 'new0.md'), 'utf8'), '# 이 기기의 새 파일\n', '못 올린 파일은 로컬 그대로');
});

/** seed가 디스크에 깐 회사의 원격 상태(매니페스트·blob)를 다시 만든다 */
async function seedStore(WS) {
  const files = {}, store = new Map();
  for (let i = 0; i < 3; i++) { const rel = `vault/notes/n${i}.md`, b = Buffer.from(`# ${i}\n`); files[rel] = meta(b); store.set(`${OWNER}/${WS}/${rel}`, b); }
  const theirs = Buffer.from('# 1 다른 기기\n');
  files['vault/notes/n1.md'] = meta(theirs); store.set(`${OWNER}/${WS}/vault/notes/n1.md`, theirs);
  store.set(`${OWNER}/${WS}/__manifest__.json`, sealSecret(Buffer.from(JSON.stringify({ files }))));
  return store;
}

test('② 한도가 찬 사이클(quotaFull) — 새 파일·수정은 보내지 않고(업로드는 매니페스트뿐) 실패 0, 받기 계속 / ③ 자리가 나면 다음 사이클에 올라간다', async () => {
  const WS = 'q-full';
  const { dir } = await seed(WS);
  const f = storage(Object.fromEntries((await seedStore(WS)).entries()));
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false, { quotaFull: true });
  assert.equal(r.failed, 0, '한도가 찬 것은 실패가 아니다');
  assert.ok(r.denied >= 2, `이 기기에 남김(new0·n2) — ${r.denied}`);
  assert.deepEqual(f.log.uploads.filter((k) => !isManifest(k)), [], '파일 내용은 보내지 않는다');
  assert.equal(r.pulled, 1);
  assert.equal(r.deletedL + r.deletedR, 0);
  const man = JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
  assert.ok(!('vault/notes/new0.md' in man.files), '못 올린 파일은 매니페스트에 없다');
  // ③ 자리가 났다 — 보통 사이클
  _setSyncClientForTest(f.client);
  const r2 = await syncCompany(WS, OWNER, false);
  assert.equal(r2.failed, 0);
  assert.equal(openSecretCompat(f.store.get(`${OWNER}/${WS}/vault/notes/new0.md`)).toString(), '# 이 기기의 새 파일\n', '새 파일이 올라간다');
  assert.equal(openSecretCompat(f.store.get(`${OWNER}/${WS}/vault/notes/n2.md`)).toString(), '# 2 이 기기에서 고침\n', '멈춰 있던 수정도 올라간다');
  assert.equal(await readFile(join(dir, 'n2.md'), 'utf8'), '# 2 이 기기에서 고침\n');
});

test('F5 할당량 모드에서도 매니페스트의 네트워크 실패는 관용하지 않는다(할당량 거절만 관용) — 사이클 실패로 다음에 다시', async () => {
  const WS = 'q-mnet';
  const { dir } = await seed(WS);
  await rm(join(dir, 'n0.md')); // 로컬 삭제 → 원격 삭제 전파 → 매니페스트를 다시 써야 하는 사이클
  const f = storage(Object.fromEntries((await seedStore(WS)).entries()));
  f.state.uploadError = (k) => (isManifest(k) ? { message: 'fetch failed', name: 'StorageUnknownError' } : null);
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false, { quotaFull: true }));
});
