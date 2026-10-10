// 로컬 걷기 해시 캐시(2026-10-10) — 8초마다 회사 폴더 전체를 읽고 해시하던 것을 (크기, mtime, ctime, inode, 장치)가 같으면 지난 해시를 다시 쓰게 했다.
// 잠그는 것: 바뀌지 않은 파일은 다시 읽지 않는다 / 같은 크기·같은 mtime으로 내용을 바꿔도(동기화가 원격 mtime을 심는 쓰기와 같은 함정) 다시 읽는다 /
// 막 바뀐 파일(같은 시각 칸 안 두 번 쓰기)은 캐시하지 않는다 / 시계가 되돌아가면 다시 읽는다 / 10분 지나면 다시 읽는다 /
// 캐시에서 온 해시로는 로컬을 덮지 않는다(쓰기 직전 실제 내용 확인) / 동기화 자신이 받아 쓴 파일을 '로컬 변경'으로 오해하지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdir, writeFile, readFile, utimes, stat } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

// 실제 파일 읽기를 센다 — sync.mjs가 import하는 node:fs/promises.readFile을 감싼다(import 전에)
const fsp = createRequire(import.meta.url)('node:fs/promises');
const realRead = fsp.readFile;
const reads = new Map();
fsp.readFile = function (p, ...rest) { const k = String(p); reads.set(k, (reads.get(k) ?? 0) + 1); return realRead.call(this, p, ...rest); };
syncBuiltinESMExports();

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-walkcache-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;
const { syncCompany, _setSyncClientForTest, _walkCacheForTest } = await import('../src/sync.mjs');
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-sync-walkcache');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

function storage(initial) {
  const store = new Map(Object.entries(initial));
  const puts = new Map();
  const bucket = {
    async download(key) { if (!store.has(key)) return { data: null, error: { message: 'Object not found', statusCode: '404' } }; const b = store.get(key); return { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null }; },
    async upload(key, blob) { puts.set(key, (puts.get(key) ?? 0) + 1); store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [] }; },
  };
  return { store, puts, client: { storage: { from: () => bucket } } };
}
async function setup(ws, { local = {}, state = null, remote = null, blobs = {} }) {
  const wsRoot = join(ROOT, ws);
  await mkdir(wsRoot, { recursive: true });
  for (const [rel, buf] of Object.entries(local)) { const f = join(wsRoot, ...rel.split('/')); await mkdir(join(f, '..'), { recursive: true }); await writeFile(f, buf); }
  if (state) await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: state, ts: 1000 }));
  const init = {};
  if (remote) init[`${OWNER}/${ws}/__manifest__.json`] = sealSecret(Buffer.from(JSON.stringify({ files: remote })));
  for (const [rel, buf] of Object.entries(blobs)) init[`${OWNER}/${ws}/${rel}`] = sealSecret(buf);
  const st = storage(init);
  _setSyncClientForTest(st.client);
  return { wsRoot, st };
}
const readsUnder = (wsRoot) => [...reads].filter(([p]) => p.startsWith(wsRoot + sep) && !p.endsWith('.sync-state.json')).reduce((a, [, c]) => a + c, 0);
/** Date.now를 앞으로 옮긴다 — 방금 만든 파일이 'racy'(3초 안에 바뀜)가 아니게 */
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const later = (ms) => { offset += ms; };
/** 사이클 하나 — 유휴 확인(60초)이 걷기를 건너뛰지 않게 매번 클라이언트를 다시 꽂는다(재시도·유휴 기억을 지움) */
const cycle = async (st, ws) => { _setSyncClientForTest(st.client); return syncCompany(ws, OWNER); };

test('바뀌지 않은 파일은 다시 읽지 않는다 — 두 번째 사이클부터 파일 읽기 0(종전에는 사이클마다 걷기 3번 × 파일 수)', async () => {
  const ws = 'wc-idle';
  const local = {}; for (let i = 0; i < 30; i++) local[`vault/n${i}.md`] = Buffer.from(`노트 ${i}`);
  const { wsRoot, st } = await setup(ws, { local });
  later(10_000);
  await cycle(st, ws); // 첫 사이클: 읽고 해시(캐시에 넣음)
  const before = readsUnder(wsRoot);
  later(10_000);
  const r = await cycle(st, ws);
  assert.equal(r.failed, 0); assert.equal(r.pushed, 0);
  assert.equal(readsUnder(wsRoot) - before, 0, '바뀌지 않은 파일을 다시 읽지 않는다');
});

test('같은 크기·같은 mtime으로 내용을 바꿔도(mtime을 되돌림) 다시 읽어 바뀐 것을 올린다 — ctime·inode가 키에 있다', async () => {
  const ws = 'wc-sametime';
  const rel = 'vault/plan.md', f = join(ROOT, ws, 'vault', 'plan.md');
  const { st } = await setup(ws, { local: { [rel]: Buffer.from('AAAA') } });
  later(10_000);
  await cycle(st, ws);
  const { mtime } = await stat(f);
  await writeFile(f, 'BBBB'); // 같은 크기
  await utimes(f, mtime, mtime); // mtime을 되돌린다(동기화의 원격 mtime 심기와 같은 모양)
  later(10_000);
  const r = await cycle(st, ws);
  assert.equal(r.pushed, 1, '바뀐 내용을 놓치지 않는다');
  assert.equal(openSecretCompat(st.store.get(`${OWNER}/${ws}/${rel}`)).toString(), 'BBBB');
});

test('막 바뀐 파일(같은 시각 칸 안의 두 번째 쓰기)은 캐시하지 않는다 — 다음 걷기가 다시 읽는다', async () => {
  const ws = 'wc-racy';
  const rel = 'vault/live.md', f = join(ROOT, ws, 'vault', 'live.md');
  offset = 0; // 앞 시험이 옮긴 시계를 실제 시각으로 — 방금 만든 파일이 '방금 바뀜'으로 보이게
  const { wsRoot, st } = await setup(ws, { local: { [rel]: Buffer.from('v1') } });
  await cycle(st, ws); // 방금 만든 파일은 racy라 캐시하지 않는다
  assert.equal(_walkCacheForTest().roots.get(wsRoot)?.has(rel) ?? false, false, '3초 안에 바뀐 파일은 캐시에 넣지 않는다');
  const before = readsUnder(wsRoot);
  await writeFile(f, 'v2'); // 같은 크기, 같은 칸 안일 수 있는 두 번째 쓰기
  const r = await cycle(st, ws);
  assert.ok(readsUnder(wsRoot) - before >= 1, '다시 읽는다');
  assert.equal(r.pushed, 1);
  assert.equal(openSecretCompat(st.store.get(`${OWNER}/${ws}/${rel}`)).toString(), 'v2');
});

test('시계가 되돌아가면 캐시를 버리고 다시 읽는다 / 10분이 지난 항목도 다시 읽는다', async () => {
  const ws = 'wc-clock';
  const { wsRoot, st } = await setup(ws, { local: { 'a.md': Buffer.from('a'), 'b.md': Buffer.from('b') } });
  later(10_000);
  await cycle(st, ws);
  let before = readsUnder(wsRoot);
  later(-5_000); // 시계가 되돌아감
  await cycle(st, ws);
  assert.ok(readsUnder(wsRoot) - before >= 2, '되돌아간 시계 — 다시 읽는다');
  later(10_000);
  await cycle(st, ws); // 다시 캐시
  before = readsUnder(wsRoot);
  later(5_000);
  await cycle(st, ws);
  assert.equal(readsUnder(wsRoot) - before, 0, '대조 — 시계가 앞으로 가면 캐시를 쓴다');
  later(11 * 60_000);
  before = readsUnder(wsRoot);
  await cycle(st, ws);
  assert.ok(readsUnder(wsRoot) - before >= 2, '10분 지난 항목은 다시 읽는다(놓친 변경의 상한)');
});

test('캐시에서 온 해시로는 로컬을 덮지 않는다 — 캐시가 낡았으면(내용이 실제로 다름) 원격 변경을 쓰기 직전에 확인하고 미룬다', async () => {
  const ws = 'wc-stale';
  const rel = 'vault/memo.md', f = join(ROOT, ws, 'vault', 'memo.md');
  const base = Buffer.from('기록된 판'), remoteNew = Buffer.from('다른 기기 판');
  const { wsRoot, st } = await setup(ws, { local: { [rel]: base }, state: { [rel]: meta(base) }, remote: { [rel]: meta(base) }, blobs: { [rel]: base } });
  later(10_000);
  await cycle(st, ws); // 캐시: memo.md = '기록된 판' 해시
  // 사용자가 고쳤는데 어떤 이유로 캐시 키가 같게 남았다고 하자(시험은 실제 내용만 바꾸고 캐시 키는 지금 stat으로 맞춰 넣는다)
  await writeFile(f, '사용자가 고친 판');
  const s = await stat(f);
  const entry = _walkCacheForTest().roots.get(wsRoot).get(rel);
  _walkCacheForTest().roots.get(wsRoot).set(rel, { ...entry, key: `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}:${s.dev}` });
  // 그 사이 다른 기기가 원격을 바꿨다 — 캐시만 믿으면 '원격만 변경 → 받기'로 사용자 편집을 덮는다
  st.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(remoteNew));
  st.store.set(`${OWNER}/${ws}/__manifest__.json`, sealSecret(Buffer.from(JSON.stringify({ files: { [rel]: meta(remoteNew, 9000) } }))));
  later(5_000);
  const r = await cycle(st, ws);
  assert.equal(await readFile(f, 'utf8'), '사용자가 고친 판', '사용자 편집을 원격본으로 덮으면 안 된다');
  assert.equal(r.deferred, 1); assert.equal(r.pulled, 0); assert.equal(r.failed, 0);
  later(11 * 60_000); // 캐시가 풀리면(10분) 양쪽 변경으로 보고 충돌 처리 — 사용자 편집은 사본으로 남는다
  const r2 = await cycle(st, ws);
  assert.equal(r2.conflicts, 1);
});

test('동기화가 받아 쓴 파일(원격 mtime을 심음)을 다음 걷기가 로컬 변경으로 오해하지 않는다 — 올리기 0', async () => {
  const ws = 'wc-pulled';
  const rel = 'vault/shared.md';
  const old = Buffer.from('예전 판'), neu = Buffer.from('새로운판'); // 같은 바이트 길이일 필요는 없다 — mtime 심기 뒤 판정만 본다
  const { wsRoot, st } = await setup(ws, { local: { [rel]: old }, state: { [rel]: meta(old) }, remote: { [rel]: meta(neu, 1000) }, blobs: { [rel]: neu } });
  later(10_000);
  const r1 = await cycle(st, ws);
  assert.equal(r1.pulled, 1);
  later(10_000);
  const r2 = await cycle(st, ws);
  assert.equal(r2.pushed, 0, '받아 쓴 파일을 다시 올리지 않는다');
  assert.equal(await readFile(join(wsRoot, ...rel.split('/')), 'utf8'), '새로운판');
  later(10_000);
  const before = readsUnder(wsRoot);
  await cycle(st, ws);
  assert.equal(readsUnder(wsRoot) - before, 0, '받아 쓴 파일도 시각이 지나면 캐시한다');
});

test('지운 파일은 캐시에서도 빠진다', async () => {
  const ws = 'wc-prune';
  const { wsRoot, st } = await setup(ws, { local: { 'gone.md': Buffer.from('x'), 'keep.md': Buffer.from('y') } });
  later(10_000);
  await cycle(st, ws);
  assert.equal(_walkCacheForTest().roots.get(wsRoot).has('gone.md'), true);
  const { rm } = await import('node:fs/promises');
  await rm(join(wsRoot, 'gone.md'));
  later(10_000);
  await cycle(st, ws);
  assert.equal(_walkCacheForTest().roots.get(wsRoot).has('gone.md'), false);
});
