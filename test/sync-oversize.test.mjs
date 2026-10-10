// 크기 제한을 넘는 파일은 동기화에서 뺀다(2026-10-10 운영 사고) — 162MB PDF 하나를 10분마다 올리려다 매번 400(24시간 129회·20.9GB)이었고,
// 업로드 실패가 파일 실패로 세져 회사 사이클이 재시도 대기만 반복했다. 이제 그런 파일은 diff 불가시(올리기·받기·삭제 전파·브레이크 집계 전부 건너뜀)이고
// 실패로 세지 않으며, 결과·state에 '동기화 제외(크기 초과)'로 남는다. 시험은 제한을 4KB로 낮춰(ARGO_SYNC_MAX_FILE_BYTES) 빠르게 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-oversize-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
process.env.ARGO_SYNC_MAX_FILE_BYTES = '4096';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;

const { syncCompany, _setSyncClientForTest, SYNC_MAX_OBJECT_BYTES } = await import('../src/sync.mjs');
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-sync-oversize');

const OWNER = 'o';
const LIMIT = 4096;
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });
const big = (tag = 'B', n = 10_000) => Buffer.alloc(n, tag);
const small = (t) => Buffer.from(t);

/** 운영처럼 제한을 넘는 업로드를 거절하는 가짜 Storage — 올리기 시도를 키별로 센다. */
function storage(initial) {
  const store = new Map(Object.entries(initial));
  const puts = new Map(), gets = new Map(), dels = [];
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  const bucket = {
    async download(key) { bump(gets, key); if (!store.has(key)) return { data: null, error: { message: 'Object not found', statusCode: '404' } }; const b = store.get(key); return { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null }; },
    async upload(key, blob) {
      bump(puts, key);
      const b = Buffer.from(await blob.arrayBuffer());
      if (b.length > LIMIT) return { error: { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' } };
      store.set(key, b); return { error: null };
    },
    async remove(keys) { for (const k of keys) { dels.push(k); store.delete(k); } return { error: null }; },
    async list() { return { data: [] }; },
  };
  return { store, puts, gets, dels, client: { storage: { from: () => bucket } } };
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
const manifest = (st, ws) => JSON.parse(openSecretCompat(st.store.get(`${OWNER}/${ws}/__manifest__.json`)).toString()).files;
const stateOf = async (wsRoot) => JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8'));

test('제한 env가 실렸다', () => assert.equal(SYNC_MAX_OBJECT_BYTES, LIMIT));

test('새 로컬 큰 파일 — 올리기를 시도조차 하지 않고 실패로 세지 않으며, 사이클이 완결되고(state 기록) 다음 사이클도 다시 시도하지 않는다', async () => {
  const ws = 'ov-new';
  const { wsRoot, st } = await setup(ws, { local: { 'vault/files/imported/big.pdf': big(), 'vault/note.md': small('작은 노트') } });
  const bigKey = `${OWNER}/${ws}/vault/files/imported/big.pdf`;
  const r1 = await syncCompany(ws, OWNER);
  assert.equal(r1.failed, 0, '크기 초과는 실패가 아니다 — 실패로 세면 재시도 대기(30초~10분)마다 같은 거절을 다시 부른다');
  assert.equal(r1.pushed, 1, '작은 노트는 종전대로 올린다');
  assert.equal(r1.oversize, 1);
  assert.deepEqual(r1.oversizeRels, ['vault/files/imported/big.pdf']);
  assert.equal(st.puts.get(bigKey) ?? 0, 0, '큰 파일 올리기 0');
  assert.equal(manifest(st, ws)['vault/files/imported/big.pdf'], undefined, '매니페스트에도 넣지 않는다');
  const s1 = await stateOf(wsRoot);
  assert.deepEqual(s1.oversize, { n: 1, rels: ['vault/files/imported/big.pdf'], limit: LIMIT }, 'argo status가 읽을 수 있게 state에 남긴다');
  assert.equal(s1.files['vault/files/imported/big.pdf'], undefined);
  for (let i = 0; i < 3; i++) {
    _setSyncClientForTest(st.client); // 유휴 확인·재시도 대기를 지워 매번 실제로 돌게
    const r = await syncCompany(ws, OWNER);
    assert.equal(r.failed, 0); assert.equal(r.oversize, 1); assert.equal(r.pushed, 0);
  }
  assert.equal(st.puts.get(bigKey) ?? 0, 0, '여러 사이클에서도 같은 거절을 다시 시도하지 않는다');
  assert.equal(existsSync(join(wsRoot, 'vault', 'files', 'imported', 'big.pdf')), true);
});

test('대조 — 재시도 대기 없이 유휴 확인으로 들어간다(실패 사이클이 아니다)', async () => {
  const ws = 'ov-idle';
  const { st } = await setup(ws, { local: { 'big.bin': big() } });
  const r1 = await syncCompany(ws, OWNER);
  assert.equal(r1.failed, 0);
  const r2 = await syncCompany(ws, OWNER);
  assert.equal(r2.skipped, 'idle-probe', '바뀐 게 없으면 다음 사이클은 유휴 확인으로 끝난다');
  assert.equal(r2.oversize, 1, '유휴 확인 결과도 크기 초과 목록을 싣는다(설정 화면 줄이 사라지지 않게)');
  assert.deepEqual(r2.oversizeRels, ['big.bin']); assert.equal(r2.oversizeLimit, LIMIT);
  assert.equal([...st.puts.values()].reduce((a, b) => a + b, 0), 1, '쓰기는 첫 사이클 매니페스트 1건뿐');
});

// 검수 #938 LOW-3: 다른 파일 실패로 재시도 대기에 들어가도 크기 초과 표시가 사라지지 않는다(설정 화면 줄이 대기 동안 빠지던 것)
test('다른 파일이 실패해 재시도 대기 중이어도 크기 초과 목록을 싣는다', async () => {
  const ws = 'ov-backoff';
  const { st } = await setup(ws, { local: { 'big.bin': big(), 'fail.md': small('올리기 실패') } });
  const bucket = st.client.storage.from(), up = bucket.upload;
  bucket.upload = async (key, blob) => (key.endsWith('/fail.md') ? { error: { statusCode: '500', message: 'Internal' } } : up(key, blob));
  const r1 = await syncCompany(ws, OWNER);
  assert.equal(r1.failed, 1); assert.equal(r1.oversize, 1);
  const r2 = await syncCompany(ws, OWNER);
  assert.equal(r2.skipped, 'retry-backoff');
  assert.equal(r2.oversize, 1, '재시도 대기 결과도 크기 초과를 싣는다'); assert.deepEqual(r2.oversizeRels, ['big.bin']);
});
test('원격에 예전 작은 판이 있던 파일이 로컬에서 커졌다 — 원격을 덮거나 지우지 않고 base도 작은 판 그대로, 다른 기기의 원격 변경도 받지 않는다', async () => {
  const ws = 'ov-grew';
  const rel = 'vault/report.md';
  const old = small('예전 작은 판');
  const { wsRoot, st } = await setup(ws, { local: { [rel]: big('G') }, state: { [rel]: meta(old) }, remote: { [rel]: meta(old) }, blobs: { [rel]: old } });
  const key = `${OWNER}/${ws}/${rel}`;
  const r1 = await syncCompany(ws, OWNER);
  assert.equal(r1.failed, 0); assert.equal(r1.oversize, 1); assert.equal(r1.pushed, 0); assert.equal(r1.deletedR, 0);
  assert.equal(st.puts.get(key) ?? 0, 0, '원격 작은 판을 덮지 않는다');
  assert.equal(openSecretCompat(st.store.get(key)).toString(), '예전 작은 판', '원격 그대로');
  assert.deepEqual((await stateOf(wsRoot)).files[rel], meta(old), 'base는 작은 판 그대로(디스크가 가진 것을 거짓 주장하지 않는다)');
  // 다른 기기가 원격 작은 판을 고쳤다 — 받아서 로컬 큰 파일을 덮으면 안 된다(충돌 사본도 만들지 않는다)
  const neu = small('다른 기기가 고친 작은 판');
  st.store.set(key, sealSecret(neu));
  st.store.set(`${OWNER}/${ws}/__manifest__.json`, sealSecret(Buffer.from(JSON.stringify({ files: { [rel]: meta(neu, 5000) } }))));
  _setSyncClientForTest(st.client);
  const r2 = await syncCompany(ws, OWNER);
  assert.equal(r2.pulled, 0); assert.equal(r2.conflicts, 0); assert.equal(r2.failed, 0);
  assert.equal((await readFile(join(wsRoot, ...rel.split('/')))).length, 10_000, '로컬 큰 파일 그대로');
  assert.equal(st.gets.get(key) ?? 0, 0, '받으러 가지도 않는다');
});

test('다른 기기가 지운 파일이라도 로컬 큰 파일은 지우지 않는다 — 삭제 전파 불가시, 브레이크 집계에도 들어가지 않는다', async () => {
  const ws = 'ov-del';
  const rel = 'vault/clip.mov';
  const old = small('작았던 판');
  const { wsRoot, st } = await setup(ws, { local: { [rel]: big('D') }, state: { [rel]: meta(old) }, remote: {} });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.deletedL, 0); assert.equal(r.failed, 0); assert.equal(r.oversize, 1);
  assert.equal(existsSync(join(wsRoot, 'vault', 'clip.mov')), true);
  assert.equal(st.dels.length, 0);
});

test('로컬에서 지운 큰 파일 — 원격 항목도 크면(다른 기기 제한이 큼) 원격을 지우지 않는다', async () => {
  const ws = 'ov-localdel';
  const rel = 'data/huge.bin';
  const b = big('H');
  const { st } = await setup(ws, { local: { 'x.md': small('x') }, state: { [rel]: meta(b), 'x.md': meta(small('x')) }, remote: { [rel]: meta(b), 'x.md': meta(small('x')) }, blobs: { 'x.md': small('x') } });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.deletedR, 0, '큰 항목의 삭제 전파 없음'); assert.equal(st.dels.length, 0);
  assert.equal(r.oversize, 1);
});

test('원격 항목만 큰 파일(다른 기기 제한이 큼) — 받지 않는다(로컬 작은 판·기록 그대로)', async () => {
  const ws = 'ov-remotebig';
  const rel = 'vault/deck.key';
  const old = small('작은 판');
  const { wsRoot, st } = await setup(ws, { local: { [rel]: old }, state: { [rel]: meta(old) }, remote: { [rel]: meta(big('R'), 7000) }, blobs: {} });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.pulled, 0); assert.equal(r.failed, 0); assert.equal(r.missing ?? 0, 0); assert.equal(r.oversize, 1);
  assert.equal(await readFile(join(wsRoot, ...rel.split('/')), 'utf8'), '작은 판');
  assert.equal(st.gets.get(`${OWNER}/${ws}/${rel}`) ?? 0, 0);
});

test('큰 파일이 다시 작아지면 종전처럼 동기화한다(원격 작은 판 위로 밀기)', async () => {
  const ws = 'ov-shrink';
  const rel = 'vault/report.md';
  const old = small('예전 작은 판');
  const { wsRoot, st } = await setup(ws, { local: { [rel]: big('G') }, state: { [rel]: meta(old) }, remote: { [rel]: meta(old) }, blobs: { [rel]: old } });
  await syncCompany(ws, OWNER);
  await writeFile(join(wsRoot, ...rel.split('/')), '줄인 새 판');
  _setSyncClientForTest(st.client);
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.pushed, 1); assert.equal(r.oversize ?? 0, 0);
  assert.equal(openSecretCompat(st.store.get(`${OWNER}/${ws}/${rel}`)).toString(), '줄인 새 판');
  assert.equal((await stateOf(wsRoot)).oversize, undefined, '크기 초과가 없어지면 state에서도 빠진다');
});

test('매니페스트 없는 사이클의 사전 확인도 큰 파일을 보지 않는다 — 큰 파일 때문에 회사 전체가 보류되지 않는다', async () => {
  const ws = 'ov-nomanifest';
  const rel = 'vault/big.pdf';
  const old = small('작았던 판');
  // 기록에는 있고(예전 작은 판), 로컬은 커졌고, 원격은 매니페스트·blob 모두 없다 — 큰 파일을 사전 확인 대상으로 보면 blob 없음 → 사이클 보류
  const { st } = await setup(ws, { local: { [rel]: big('N'), 'a.md': small('a') }, state: { [rel]: meta(old) } });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.oversize, 1); assert.equal(r.failed, 0); assert.equal(r.pushed, 1, '작은 파일은 올린다');
  assert.equal(st.gets.get(`${OWNER}/${ws}/${rel}`) ?? 0, 0, '큰 파일의 blob 확인 GET 0');
});

test('경계 — 봉투(평문 + 42바이트)를 씌워도 제한 안이면 올리고, 64바이트 여유 안쪽은 뺀다', async () => {
  const ws = 'ov-edge';
  const ok = Buffer.alloc(LIMIT - 64, 'k'), over = Buffer.alloc(LIMIT - 63, 'o');
  const { st } = await setup(ws, { local: { 'ok.bin': ok, 'over.bin': over } });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.failed, 0, '제한 안 파일 업로드가 거절되면 실패로 보인다');
  assert.equal(r.pushed, 1); assert.deepEqual(r.oversizeRels, ['over.bin']);
  assert.equal(st.puts.get(`${OWNER}/${ws}/ok.bin`), 1);
});
