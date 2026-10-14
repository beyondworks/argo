// 매니페스트에만 있고 객체가 없는 항목(빈 항목) — Pro 제보 "하루 종일 기기 간 동기화가 안 된다"(2026-10-14, 맥 two 총괄 운영 로그).
// 운영 edge_logs: 같은 빈 항목 GET 400이 항목마다 하루 14~18회, 대상 상당수가 에이전트 임시 파일(tmp_work/extracted/**·vault/files/_tmp_*·_build_tmp.*).
// 경우 표(PR 본문) 칸 이름을 시험 이름 앞에 붙인다.
//  A — 올리기가 실패한 파일은 매니페스트에 올리지 않는다(지금 순서가 그런지 재현해 잠근다)
//  B — 이미 생긴 빈 항목은 지우지 않고 재요청만 줄인다: 1시간 → 4시간 → 하루 한 번, 세 번째부터 '복구 필요', 재시작해도 이어 간다
//  C — 에이전트 임시 파일은 diff 불가시(올리기·받기·삭제 전파 전부 건너뜀)
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-orphan-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
const { syncCompany, _setSyncClientForTest, isAgentScratchRel, isDevArtifactRel, MISSING_RECOVERY_AFTER } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(5, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const meta = (b, m = 1000) => ({ m, s: b.length, h: hashBuf(b) });
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' }; // storage-js 오류 모양(운영 GET 400)
const BUCKET_NOT_FOUND = { message: 'Bucket not found', status: 400, statusCode: '404' }; // 만료 토큰(#835)
const HOUR = 60 * 60_000;

/** 가짜 스토리지 — 키별 GET·PUT·DELETE 수를 센다. failUpload(key)·failGet(key)로 실패를 주입한다. */
function fakeStorage(initial) {
  const store = new Map(Object.entries(initial));
  const log = { gets: new Map(), puts: [], removed: [] };
  const hooks = { failUpload: () => null, failGet: () => null, beforeUpload: async () => {} };
  const bucket = {
    async download(key) {
      log.gets.set(key, (log.gets.get(key) ?? 0) + 1);
      const inj = hooks.failGet(key); if (inj) return { data: null, error: inj };
      if (!store.has(key)) return { data: null, error: OBJECT_NOT_FOUND };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) {
      await hooks.beforeUpload(key);
      const inj = hooks.failUpload(key); if (inj) return { error: inj };
      log.puts.push(key); store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null };
    },
    async remove(keys) { for (const k of keys) { log.removed.push(k); store.delete(k); } return { error: null }; },
    async list() { return { data: [] }; },
  };
  return { _store: store, log, hooks, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

async function setup(wsId, { localFiles = {}, state = {}, remoteFiles = {}, remoteBlobs = {} }) {
  const wsRoot = join(ROOT, wsId);
  await mkdir(join(wsRoot, 'chats', '.archive'), { recursive: true });
  for (const [rel, buf] of Object.entries(localFiles)) {
    const full = join(wsRoot, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, buf);
  }
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: state, ts: 1000 }));
  const store = { [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: remoteFiles })) };
  for (const [rel, buf] of Object.entries(remoteBlobs)) store[`${OWNER}/${wsId}/${rel}`] = buf;
  const fake = fakeStorage(store);
  _setSyncClientForTest(fake);
  return { wsRoot, fake };
}
const manifest = (fake, wsId) => JSON.parse(openSecretCompat(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`)).toString());
const stateOf = async (wsId) => JSON.parse(await readFile(join(ROOT, wsId, '.sync-state.json'), 'utf8'));
const getsOf = (fake, wsId, rel) => fake.log.gets.get(`${OWNER}/${wsId}/${rel}`) ?? 0;
/** 가짜 시계 안에서 fn(tick) — tick(ms)만큼 시간을 보낸다 */
async function withClock(fn) {
  const real = Date.now; let now = real(); Date.now = () => now;
  try { return await fn((ms) => { now += ms; }); } finally { Date.now = real; }
}

/* ── A. 올리기 실패와 매니페스트 기록 순서 ── */
test('A1·A2·A3 올리기가 실패한 파일은 매니페스트에 새 항목·새 메타로 들어가지 않는다(다음 사이클에 다시 올린다)', async () => {
  const wsId = 'push-fail';
  const old = Buffer.from('old'), base = Buffer.from('base'), theirs = Buffer.from('their edit');
  const { fake } = await setup(wsId, {
    localFiles: { 'vault/new.md': Buffer.from('new'), 'vault/mod.json': Buffer.from('{"v":2}'), 'vault/clash.md': Buffer.from('my edit') },
    state: { 'vault/mod.json': meta(old), 'vault/clash.md': meta(base) },
    remoteFiles: { 'vault/mod.json': meta(old), 'vault/clash.md': meta(theirs, 2000) },
    remoteBlobs: { 'vault/mod.json': old, 'vault/clash.md': theirs },
  });
  const fail = { message: 'Service Unavailable', status: 503 };
  fake.hooks.failUpload = (key) => (/vault\/(new\.md|mod\.json|clash\.conflict-)/.test(key) ? fail : null);
  const r = await syncCompany(wsId, OWNER);
  assert.ok(r.failed >= 3, `실패 ${r.failed}`);
  const m = manifest(fake, wsId).files;
  assert.ok(!('vault/new.md' in m), 'A1: 올리지 못한 새 파일이 매니페스트에 들어갔다 — 다른 기기가 빈 항목으로 받으러 간다');
  assert.deepEqual(m['vault/mod.json'], meta(old), 'A2: 올리지 못한 수정본 메타가 매니페스트에 들어갔다');
  assert.ok(!Object.keys(m).some((k) => k.includes('clash.conflict-')), 'A3: 올리지 못한 충돌 사본이 매니페스트에 들어갔다');
  const st = (await stateOf(wsId)).files ?? {};
  assert.ok(!('vault/new.md' in st), 'A1: base에도 없어야 다음 사이클이 다시 올린다');
  // 회복하면 다음 사이클이 올린다
  fake.hooks.failUpload = () => null;
  await withClock(async (tick) => { tick(10 * 60_000 + 1); await syncCompany(wsId, OWNER); });
  assert.ok('vault/new.md' in manifest(fake, wsId).files, '회복 뒤 다시 올려 항목이 생긴다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/new.md`));
});


/* ── A4~A8. 빈 항목이 생기는 경로: 사이클 도중 다른 기기가 끝낸 삭제를 매니페스트 덮어쓰기로 되살림 ── */
/** 이 기기(B)의 사이클 도중(매니페스트 재읽기 전)에 다른 기기(A)가 rel을 지운 것처럼 만든다 — 객체 삭제 + 항목 뺀 매니페스트.
    두 번째 매니페스트 GET(재읽기)이 오는 순간 적용한다. 재읽기와 업로드 사이의 수 ms 창은 이 수정 밖이다(PR 본문). */
function deleteByOtherDeviceDuringMyCycle(fake, wsId, rel, { keepBlob = false } = {}) {
  const mk = `${OWNER}/${wsId}/__manifest__.json`;
  const bucket = fake.storage.from(), dl = bucket.download.bind(bucket);
  let reads = 0;
  bucket.download = async (key) => {
    if (key === mk && ++reads === 2) {
      if (!keepBlob) fake._store.delete(`${OWNER}/${wsId}/${rel}`);
      const m = manifest(fake, wsId); delete m.files[rel]; fake._store.set(mk, Buffer.from(JSON.stringify(m)));
    }
    return dl(key);
  };
}
async function raceSetup(wsId) {
  const tmp = Buffer.from('agent tmp'), note = Buffer.from('note v1');
  const r = await setup(wsId, {
    localFiles: { 'vault/files/report-draft.txt': tmp, 'vault/n.md': Buffer.from('note v2 (this device)') },
    state: { 'vault/files/report-draft.txt': meta(tmp), 'vault/n.md': meta(note) },
    remoteFiles: { 'vault/files/report-draft.txt': meta(tmp), 'vault/n.md': meta(note) },
    remoteBlobs: { 'vault/files/report-draft.txt': tmp, 'vault/n.md': note },
  });
  return r;
}

test('A4 다른 기기가 내 사이클 도중 끝낸 삭제를 되살리지 않는다 — 빈 항목이 생기지 않고, 다음 사이클에 이 기기 사본도 정상 삭제', async () => {
  const wsId = 'race-del';
  const { wsRoot, fake } = await raceSetup(wsId);
  deleteByOtherDeviceDuringMyCycle(fake, wsId, 'vault/files/report-draft.txt');
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.concurrentDeletes, 1);
  const m = manifest(fake, wsId).files;
  assert.ok(!('vault/files/report-draft.txt' in m), 'A4: 다른 기기가 지운 항목이 되살아나 빈 항목이 됐다');
  assert.ok('vault/n.md' in m, '이 기기가 고친 파일은 그대로 올라간다');
  await withClock(async (tick) => { tick(61_000); await syncCompany(wsId, OWNER); });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(wsRoot, 'vault', 'files', 'report-draft.txt')), false, '다음 사이클이 다른 기기의 삭제를 이 기기에도 반영한다(겹치지 않았을 때와 같은 결과)');
  assert.equal(await readFile(join(wsRoot, 'vault', 'n.md'), 'utf8'), 'note v2 (this device)');
});

test('A5 항목만 빠지고 객체는 있으면(다른 기기 매니페스트 유실) 종전처럼 되살린다', async () => {
  const wsId = 'race-heal';
  const { wsRoot, fake } = await raceSetup(wsId);
  deleteByOtherDeviceDuringMyCycle(fake, wsId, 'vault/files/report-draft.txt', { keepBlob: true });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.concurrentDeletes, undefined);
  assert.ok('vault/files/report-draft.txt' in manifest(fake, wsId).files, 'A5: 객체가 있는데 항목을 뺐다 — 유실 복구가 깨졌다');
  const { existsSync } = await import('node:fs');
  assert.ok(existsSync(join(wsRoot, 'vault', 'files', 'report-draft.txt')));
});

test('A6 객체 확인이 안 되면(만료 토큰 Bucket not found·5xx) 빼지 않는다(#835 오분류 방어)', async () => {
  for (const [i, err] of [BUCKET_NOT_FOUND, { message: 'Internal Server Error', status: 500 }].entries()) {
    const wsId = `race-unknown-${i}`;
    const { fake } = await raceSetup(wsId);
    deleteByOtherDeviceDuringMyCycle(fake, wsId, 'vault/files/report-draft.txt');
    fake.hooks.failGet = (key) => (key.endsWith('vault/files/report-draft.txt') ? err : null);
    const r = await syncCompany(wsId, OWNER);
    assert.equal(r.concurrentDeletes, undefined, `A6(${err.message}): 확인 못 했는데 뺐다`);
    assert.ok('vault/files/report-draft.txt' in manifest(fake, wsId).files);
  }
});

test('A7 매니페스트 재읽기가 실패하면 종전처럼 그대로 쓴다', async () => {
  const wsId = 'race-reread-fail';
  const { fake } = await raceSetup(wsId);
  const mk = `${OWNER}/${wsId}/__manifest__.json`;
  fake._store.delete(`${OWNER}/${wsId}/vault/files/report-draft.txt`);
  let reads = 0; const bucket = fake.storage.from(), dl = bucket.download.bind(bucket);
  bucket.download = async (key) => { if (key === mk && ++reads === 2) throw new Error('fetch failed'); return dl(key); };
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.concurrentDeletes, undefined);
  assert.ok('vault/files/report-draft.txt' in manifest(fake, wsId).files);
});

test('A8 이 기기가 이번 사이클에 올린 항목은 재읽기에 없어도 빼지 않는다', async () => {
  const wsId = 'race-mine';
  const { fake } = await raceSetup(wsId);
  deleteByOtherDeviceDuringMyCycle(fake, wsId, 'vault/n.md'); // 내가 방금 올린 n.md를 다른 기기가 지운 것처럼
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.concurrentDeletes, undefined);
  assert.ok('vault/n.md' in manifest(fake, wsId).files, 'A8: 이 기기가 올린 판을 뺐다');
});

/* ── B. 빈 항목 재요청 줄이기 ── */
test('B1·B2·B3 같은 빈 항목은 1시간 → 4시간 → 하루 간격으로만 다시 받고, 세 번째부터 복구 필요로 표시한다(항목·매니페스트 그대로)', async () => {
  const wsId = 'orphan-steps';
  const gone = 'vault/journal/2026-09-03-pepper.md';
  const { fake } = await setup(wsId, { remoteFiles: { [gone]: meta(Buffer.from('lost')) } });
  await withClock(async (tick) => {
    const r1 = await syncCompany(wsId, OWNER);
    assert.equal(r1.failed, 0); assert.equal(r1.missing, 1); assert.equal(r1.needsRecovery, undefined);
    assert.equal(getsOf(fake, wsId, gone), 1, 'B1');
    const puts0 = fake.log.puts.length;
    tick(HOUR - 1); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 1, 'B2: 1시간 안에 다시 받으러 갔다');
    tick(61_000); await syncCompany(wsId, OWNER); // 유휴 확인(60초)을 넘는 걸음
    assert.equal(getsOf(fake, wsId, gone), 2, '1시간 뒤 두 번째 확인');
    tick(4 * HOUR - 1); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 2, 'B3: 두 번째 확인 뒤 4시간 안에 다시 받으러 갔다');
    tick(61_000); const r3 = await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 3);
    assert.equal(MISSING_RECOVERY_AFTER, 3);
    assert.equal(r3.needsRecovery, 1, 'B3: 세 번째 확인부터 복구 필요');
    assert.deepEqual(r3.needsRecoveryRels, [gone]);
    tick(24 * HOUR - 1); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 3, 'B3: 복구 필요 항목은 하루에 한 번만');
    tick(61_000); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 4);
    tick(24 * HOUR + 1); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 5, '그 뒤로도 하루 한 번(간격이 더 늘지 않는다)');
    assert.equal(fake.log.puts.length, puts0, '빈 항목 때문에 매니페스트를 다시 쓰지 않는다');
  });
  assert.ok(gone in manifest(fake, wsId).files, 'B8: 항목은 지우지 않는다');
});

test('B4 재시작(메모리 기억이 비어도) state에 남은 기억으로 이어 가 다시 받지 않는다', async () => {
  const wsId = 'orphan-restart';
  const gone = 'vault/files/report.xlsx';
  const { fake } = await setup(wsId, { remoteFiles: { [gone]: meta(Buffer.from('x')) } });
  await withClock(async (tick) => {
    await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 1);
    const saved = (await stateOf(wsId)).missing?.[gone];
    assert.ok(saved && saved.n === 1 && typeof saved.sig === 'string', `state에 기억이 없다: ${JSON.stringify(saved)}`);
    _setSyncClientForTest(fake); // 메모리 기억(missingSeen)·유휴 기록을 비운다 = 재시작
    tick(61_000); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 1, 'B4: 재시작 뒤 같은 빈 항목을 바로 다시 받으러 갔다');
    tick(HOUR); _setSyncClientForTest(fake); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 2, '간격이 지나면 다시 확인');
    assert.equal((await stateOf(wsId)).missing[gone].n, 2, '재시작을 건너도 횟수가 이어진다');
  });
});

test('B4-1 state의 기억이 이상하면(먼 미래·잘못된 모양) 버리거나 하루로 자른다', async () => {
  const wsId = 'orphan-bad-state';
  const gone = 'vault/a.md', b = Buffer.from('a');
  const { fake } = await setup(wsId, { remoteFiles: { [gone]: meta(b), 'vault/b.md': meta(b) } });
  const st = await stateOf(wsId);
  st.missing = { [gone]: { sig: meta(b).h, until: Date.now() + 365 * 24 * HOUR, n: 9 }, 'vault/b.md': { sig: 1, until: 'x' }, '../evil': { sig: 'a', until: 1, n: 1 } };
  await writeFile(join(ROOT, wsId, '.sync-state.json'), JSON.stringify(st));
  await withClock(async (tick) => {
    await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 0, '남은 기억은 따른다');
    assert.equal(getsOf(fake, wsId, 'vault/b.md'), 1, '모양이 잘못된 기억은 버리고 확인한다');
    tick(24 * HOUR + 1); await syncCompany(wsId, OWNER);
    assert.equal(getsOf(fake, wsId, gone), 1, '1년 뒤로 적힌 기억도 하루로 잘라 다시 확인한다');
  });
  assert.ok(!('../evil' in ((await stateOf(wsId)).missing ?? {})));
});

test('B5·B6 다른 기기가 다시 올리면(메타 바뀜) 바로 받고, 같은 메타로 객체만 돌아오면 다음 확인 때 받는다 — 둘 다 기억을 지운다', async () => {
  const wsId = 'orphan-revive';
  const a = Buffer.from('A v1'), a2 = Buffer.from('A v2 from device B'), c = Buffer.from('C');
  const { wsRoot, fake } = await setup(wsId, { remoteFiles: { 'vault/a.md': meta(a), 'vault/c.md': meta(c) } });
  await withClock(async (tick) => {
    await syncCompany(wsId, OWNER);
    const mk = `${OWNER}/${wsId}/__manifest__.json`;
    const man = manifest(fake, wsId); man.files['vault/a.md'] = meta(a2, 3000);
    fake._store.set(mk, Buffer.from(JSON.stringify(man)));
    fake._store.set(`${OWNER}/${wsId}/vault/a.md`, a2);                 // B5: 기기 B가 다시 올림
    fake._store.set(`${OWNER}/${wsId}/vault/c.md`, c);                  // B6: 같은 메타로 객체만 돌아옴
    tick(61_000); const r = await syncCompany(wsId, OWNER);
    assert.equal(await readFile(join(wsRoot, 'vault', 'a.md'), 'utf8'), 'A v2 from device B', 'B5: 메타가 바뀌었는데 받지 않았다');
    assert.equal(r.missing, 1, 'c는 아직 간격 안이라 건너뜀');
    tick(HOUR); await syncCompany(wsId, OWNER);
    assert.equal(await readFile(join(wsRoot, 'vault', 'c.md'), 'utf8'), 'C', 'B6: 다음 확인 때 받는다');
  });
  assert.equal((await stateOf(wsId)).missing, undefined, '받은 항목의 기억은 남지 않는다');
});

test('B9 만료 토큰(Bucket not found)·5xx는 빈 항목이 아니라 실패 — 기억하지 않아 간격이 늘지 않는다(#835 오분류 방어)', async () => {
  const wsId = 'orphan-misclass';
  const b = Buffer.from('real');
  const { wsRoot, fake } = await setup(wsId, { remoteFiles: { 'vault/x.md': meta(b), 'vault/y.md': meta(b) }, remoteBlobs: { 'vault/x.md': b, 'vault/y.md': b } });
  fake.hooks.failGet = (key) => (key.endsWith('vault/x.md') ? BUCKET_NOT_FOUND : key.endsWith('vault/y.md') ? { message: 'Internal Server Error', status: 500 } : null);
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 2); assert.equal(r.missing, undefined);
  assert.equal(r.deletedL + r.deletedR, 0);
  await withClock(async (tick) => {
    fake.hooks.failGet = () => null;
    tick(10 * 60_000 + 1); await syncCompany(wsId, OWNER);                // 재시도 대기만 지나면 바로 받는다(빈 항목 간격에 묶이지 않음)
  });
  assert.equal(await readFile(join(wsRoot, 'vault', 'x.md'), 'utf8'), 'real');
  assert.equal(await readFile(join(wsRoot, 'vault', 'y.md'), 'utf8'), 'real');
  assert.equal((await stateOf(wsId)).missing, undefined);
});

test('B10 매니페스트에서 항목이 빠지면 state의 기억도 정리한다', async () => {
  const wsId = 'orphan-pruned';
  const { fake } = await setup(wsId, { remoteFiles: { 'vault/p.md': meta(Buffer.from('p')) } });
  await syncCompany(wsId, OWNER);
  assert.ok((await stateOf(wsId)).missing?.['vault/p.md']);
  const mk = `${OWNER}/${wsId}/__manifest__.json`;
  fake._store.set(mk, Buffer.from(JSON.stringify({ files: { 'vault/q.md': meta(Buffer.from('q')) } })));
  fake._store.set(`${OWNER}/${wsId}/vault/q.md`, Buffer.from('q'));
  await withClock(async (tick) => { tick(61_000); await syncCompany(wsId, OWNER); });
  assert.equal((await stateOf(wsId)).missing, undefined);
});

test('B11 무료 회사(freePlan)도 같은 규칙 — 빈 항목은 실패가 아니고, 다시 받으러 가지 않는다', async () => {
  const wsId = 'orphan-free';
  const gone = 'vault/f.md';
  const { fake } = await setup(wsId, { remoteFiles: { [gone]: meta(Buffer.from('f')) } });
  const r1 = await syncCompany(wsId, OWNER, false, { freePlan: true });
  assert.equal(r1.failed, 0); assert.equal(r1.missing, 1);
  const r2 = await syncCompany(wsId, OWNER, false, { freePlan: true });
  assert.equal(r2.missing, 1);
  assert.equal(getsOf(fake, wsId, gone), 1);
});

test('B14 state에는 빈 항목 기억을 500개까지만 적는다', async () => {
  const wsId = 'orphan-many';
  const files = {}; for (let i = 0; i < 520; i++) files[`vault/n/${i}.md`] = meta(Buffer.from(`n${i}`));
  await setup(wsId, { remoteFiles: files });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.missing, 520);
  assert.equal(Object.keys((await stateOf(wsId)).missing).length, 500);
});

test('B15 로그 — 복구 필요가 되면 그 사실이 한 줄 더 붙고, 같은 목록이면 다시 쓰지 않는다', async () => {
  const wsId = 'orphan-log';
  const gone = 'vault/l.md';
  await setup(wsId, { remoteFiles: { [gone]: meta(Buffer.from('l')) } });
  const warn = console.warn, lines = [];
  console.warn = (l) => { lines.push(String(l)); };
  try {
    await withClock(async (tick) => {
      for (const step of [0, HOUR + 1, 4 * HOUR + 1, 61_000, 61_000]) { tick(step); await syncCompany(wsId, OWNER); }
    });
  } finally { console.warn = warn; }
  const mine = lines.filter((l) => l.includes(`동기화(${wsId}): 매니페스트에만`));
  assert.equal(mine.length, 2, mine.join('\n'));
  assert.match(mine[1], /복구 필요 1개\(하루 한 번만 다시 확인/);
});

/* ── C. 에이전트 임시 파일 ── */
test('C5 임시 파일 판정 — 운영에서 확인된 경로만, 비슷한 이름의 사용자 파일은 그대로 동기화', () => {
  for (const rel of ['tmp_work/extracted/xl/styles.xml', 'tmp_work/extracted/[Content_Types].xml', 'tmp_work/parse.js', 'tmp_work/extracted/_rels/.rels',
    'vault/files/_tmp_row0.txt', 'vault/files/_tmp_header.txt', 'vault/files/_tmp_AKB-MON-GBK.txt', 'vault/projects/20260927_사내지침/_build_tmp.pdf', 'vault/projects/p/_build_tmp.docx']) {
    assert.equal(isAgentScratchRel(rel), true, rel);
    assert.equal(isDevArtifactRel(rel), true, `${rel} — diff 불가시 경로에 실려야 한다`);
  }
  for (const rel of ['tmp_work', 'vault/notes/tmp_work.md', 'vault/tmp_work/a.md', 'vault/files/my_tmp_notes.txt', 'vault/files/_tmpx.txt', 'vault/files/tmp_row.txt',
    'vault/projects/p/build_tmp.pdf', 'vault/projects/p/_build_tmp2.pdf', 'chats/.archive/argo-chief-of-staff-1789118554799.json', 'vault/journal/2026-09-03-pepper.md']) {
    assert.equal(isAgentScratchRel(rel), false, rel);
  }
});

test('C1·C2·C3·C4 임시 파일은 올리지도 받지도 지우지도 않는다 — 원격 빈 항목은 GET 0·집계 0·항목 보존, 옛 앱이 올린 사본도 그대로', async () => {
  const wsId = 'scratch';
  const k = Buffer.from('keep'), oldTmp = Buffer.from('old tmp');
  const { fake } = await setup(wsId, {
    localFiles: {
      'tmp_work/extracted/xl/styles.xml': Buffer.from('<x/>'), 'vault/files/_tmp_row0.txt': Buffer.from('row'),  // C1
      'vault/projects/p/_build_tmp.pdf': Buffer.from('%PDF'), 'vault/notes/tmp_work.md': Buffer.from('user note'),
      'vault/keep.md': k,
    },
    state: { 'vault/keep.md': meta(k), 'vault/files/_tmp_header.txt': meta(oldTmp) },               // C4: base에 있던 임시 파일을 이 기기에서 지움
    remoteFiles: {
      'vault/keep.md': meta(k),
      'tmp_work/extracted/docProps/core.xml': meta(Buffer.from('gone')), 'vault/files/_tmp_sbe.txt': meta(Buffer.from('gone2')), // C2: 객체 없는 임시 항목
      'vault/files/_tmp_header.txt': meta(oldTmp), 'tmp_work/parse.js': meta(Buffer.from('js')),   // C3: 옛 앱이 올린 사본(객체 있음)
    },
    remoteBlobs: { 'vault/keep.md': k, 'vault/files/_tmp_header.txt': oldTmp, 'tmp_work/parse.js': Buffer.from('js') },
  });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0); assert.equal(r.missing, undefined, 'C2: 임시 빈 항목이 빈 항목 집계에 들어갔다');
  assert.equal(r.deletedR, 0, 'C4: 임시 파일 삭제를 원격에 전파했다');
  for (const rel of ['tmp_work/extracted/docProps/core.xml', 'vault/files/_tmp_sbe.txt', 'tmp_work/parse.js']) assert.equal(getsOf(fake, wsId, rel), 0, `C2·C3: ${rel}를 받으러 갔다`);
  for (const rel of ['tmp_work/extracted/xl/styles.xml', 'vault/files/_tmp_row0.txt', 'vault/projects/p/_build_tmp.pdf']) assert.ok(!fake._store.has(`${OWNER}/${wsId}/${rel}`), `C1: ${rel}를 올렸다`);
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/notes/tmp_work.md`), 'C5: 비슷한 이름의 사용자 파일은 올린다');
  const m = manifest(fake, wsId).files;
  for (const rel of ['tmp_work/extracted/docProps/core.xml', 'vault/files/_tmp_sbe.txt', 'vault/files/_tmp_header.txt', 'tmp_work/parse.js']) assert.ok(rel in m, `C3: ${rel} 항목을 지웠다 — 옛 앱 기기가 로컬 사본을 지운다`);
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/files/_tmp_header.txt`), 'C3·C4: 옛 앱이 올린 객체를 지웠다');
  assert.equal(fake.log.removed.length, 0);
});
