// 만료 토큰이 '원격 없음'으로 읽히던 결함(운영 실측 2026-10-05 08:59:49Z) — 행동 테스트(가짜 저장소, 임시 ARGO_ROOT).
// 상주 사이클이 토큰 남은 시간보다 오래 돌아 끝부분 요청이 만료 토큰으로 나갔다. Storage는 만료 토큰 GET을 익명으로 처리해
// 비공개 버킷을 못 보고 'Bucket not found'(HTTP 400, statusCode '404')를 준다(storage_logs: role anon, NoSuchBucket). 매니페스트 읽기·blob 검사의
// 없음 판정이 메시지의 "not found"만 보고 이것을 '매니페스트 없음'으로 읽어, 빈 원격으로 판정하고 쓰기까지 시도했다(쓰기는 만료로 거절).
// 실제 파일이 있는 회사라면 같은 판정이 blobExists에도 걸려 로컬 파일을 지우고(대량 삭제 브레이크 미만이면), 그 사이클은 state를
// 못 써서 다음 정상 사이클이 그 파일들을 '이 기기가 지운 것'으로 읽어 원격까지 지운다.
// 계약(이유: 삭제는 비가역 — 확인 못 한 것은 없음이 아니다): 만료 토큰 사이클은 아무것도 지우지 않고 보류하며, 다음 정상 사이클도 지우지 않는다.
// 인접 핀: 진짜 '객체 없음'(Object not found)은 지금처럼 없음으로 읽는다(새 회사 첫 푸시).
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';
import { startFakeSupabase } from './helpers/fake-supabase-http.mjs';
import { seedRoot, runSyncChild } from './helpers/sync-child.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-expired-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const meta = (b) => ({ m: 1000, s: b.length, h: hashBuf(b) });
// storage-js 2.110.2가 만드는 오류 모양 그대로(StorageApiError: message·status 숫자·statusCode 문자열)
const BUCKET_NOT_FOUND = { message: 'Bucket not found', status: 400, statusCode: '404' };
const JWT_EXPIRED = { message: '"exp" claim timestamp check failed', status: 400, statusCode: '403' };
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };

/** 가짜 저장소 — mode 'expired'면 읽기는 Bucket not found, 쓰기·지우기는 만료 거절(운영 08:59:49Z와 같은 짝). */
function storage(initial) {
  const store = new Map(Object.entries(initial));
  const state = { mode: 'ok' };
  const log = { uploads: [], removed: [] };
  const bucket = {
    async download(k) {
      k = k.split('?')[0];
      if (state.mode === 'expired') return { data: null, error: BUCKET_NOT_FOUND };
      const forced = state.downloadError?.(k);
      if (forced) return { data: null, error: forced };
      return store.has(k) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(k)).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async upload(k, blob) {
      log.uploads.push(k);
      if (state.mode === 'expired') return { error: JWT_EXPIRED };
      store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null };
    },
    async remove(keys) {
      if (state.mode === 'expired') return { error: JWT_EXPIRED };
      log.removed.push(...keys); for (const k of keys) store.delete(k); return { data: [], error: null };
    },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, state, log };
}

test('만료 토큰 사이클 — 실제 파일이 있는 회사의 로컬 파일을 지우지 않고, 다음 정상 사이클도 원격을 지우지 않는다', async () => {
  const WS = 'co-small';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  // 기록(base) 10개 중 3개는 이 기기에서 고쳤다 → 삭제 후보 7개는 대량 삭제 브레이크(전부 또는 max(8, 절반) 이상) 아래다
  const base = {}, remoteFiles = {}, blobs = {};
  for (let i = 0; i < 10; i++) {
    const rel = `vault/notes/n${i}.md`;
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[rel] = meta(orig); remoteFiles[rel] = meta(orig); blobs[`${OWNER}/${WS}/${rel}`] = orig;
    await writeFile(join(dir, `n${i}.md`), i < 3 ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  const f = storage({ ...blobs, [`${OWNER}/${WS}/__manifest__.json`]: sealSecret(Buffer.from(JSON.stringify({ files: remoteFiles }))) });
  _setSyncClientForTest(f.client);

  f.state.mode = 'expired';
  await syncCompany(WS, OWNER, false).catch(() => {});
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, 10, '만료 토큰 사이클이 로컬 파일을 지우지 않는다');

  f.state.mode = 'ok';
  _setSyncClientForTest(f.client); // 재시도 대기(backoff)를 비워 바로 다음 사이클을 돌린다 — 저장소 내용은 그대로
  const r = await syncCompany(WS, OWNER, false);
  assert.deepEqual(f.log.removed, [], '다음 정상 사이클이 원격 파일을 지우지 않는다');
  assert.equal(r.deletedL + r.deletedR, 0);
  for (let i = 3; i < 10; i++) assert.equal(await readFile(join(dir, `n${i}.md`), 'utf8'), `# 원본 ${i}\n`, `n${i}.md 그대로`);
});

test('만료 토큰 복원 — 빈 원격 회사로 읽어 매니페스트를 쓰려 하지 않고 읽기 실패로 보류한다', async () => {
  const WS = 'shell-expired';
  const f = storage({ [`${OWNER}/${WS}/__manifest__.json`]: sealSecret(Buffer.from(JSON.stringify({ files: {} }))) });
  _setSyncClientForTest(f.client);
  f.state.mode = 'expired';
  await assert.rejects(() => syncCompany(WS, OWNER, true), /매니페스트 읽기 실패/);
  assert.deepEqual(f.log.uploads, [], '쓰기 시도 0 — 운영에서는 GET·GET·POST가 나갔다');
});

test('정리된 원격(매니페스트·blob 모두 없음) — 기록이 있는 로컬 파일을 지우지 않고 모두 다시 민다(큰 회사)', async () => {
  const WS = 'co-wiped';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {}, N = 14; // 대량 삭제 브레이크(max(8, 절반)) 위 — 큰 회사도 브레이크가 아니라 다시 밀기로 끝난다
  for (let i = 0; i < N; i++) {
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[`vault/notes/n${i}.md`] = meta(orig);
    await writeFile(join(dir, `n${i}.md`), i < 3 ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  const f = storage({}); // 매니페스트도 객체도 없다(Object not found) — 원격이 비었다
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.deletedL, 0, '로컬 삭제 0');
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, N);
  assert.equal(r.pushed, N, '모두 다시 민다');
  const manifest = JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
  assert.equal(Object.keys(manifest.files).length, N, '원격 매니페스트가 다시 채워진다');
});

test('인접 핀 — 진짜 객체 없음(Object not found)은 지금처럼 없음이다: 새 회사는 첫 매니페스트를 쓴다', async () => {
  const WS = 'co-new';
  await mkdir(join(ROOT, WS), { recursive: true });
  await writeFile(join(ROOT, WS, 'company.json'), JSON.stringify({ id: WS, ownerId: OWNER }));
  const f = storage({});
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.failed, 0);
  assert.equal(r.pushed, 1, 'company.json을 민다');
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`), '첫 매니페스트를 쓴다');
});

// 토큰 배선 핀 — 동기화 요청이 기기 세션 토큰을 싣는다(익명 키로 새지 않는다). 요청 직전 토큰 갱신(sessionFetch)은 0.1.96에서 따로 다룬다.
test('토큰 창 배선 — 실제 supabase-js 클라이언트의 동기화 요청이 모두 세션 토큰을 싣는다(익명 키로 새지 않는다)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'argo-expired-wire-'));
  const fake = await startFakeSupabase({ userId: 'u1' });
  try {
    seedRoot(root, { url: fake.url, userId: 'u1', wsId: 'co-1234' }); // 기기 세션 access_token 'h.p.s', 만료 1시간 뒤
    await runSyncChild({ root, env: { ARGO_SYNC_CYCLE_MS: '100' }, waitMs: 2500 });
    const sync = fake.hits.filter((h) => h.k.includes('/storage/v1/') || h.k.includes('/rest/v1/'));
    assert.ok(sync.length >= 3, `동기화 요청이 있어야 본다(${sync.length})`);
    assert.deepEqual([...new Set(sync.map((h) => h.auth))], ['Bearer h.p.s'], '모든 요청이 세션 토큰');
  } finally { await fake.close(); }
});

// ── 분리 검수 #835 지적 반영(F1·F2-2·F2-3·F4) ──
/** 기록 n개짜리 회사를 깐다. blobs: 원격에 blob이 있는 i, inManifest: 매니페스트 항목이 있는 i, edited: 이 기기에서 고친 i */
async function seedCompany(WS, n, { blobs = () => true, inManifest = () => true, edited = () => false, withState = true, manifest = true } = {}) {
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {}, files = {}, store = {};
  for (let i = 0; i < n; i++) {
    const rel = `vault/notes/n${i}.md`;
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[rel] = meta(orig);
    if (inManifest(i)) files[rel] = meta(orig);
    if (blobs(i)) store[`${OWNER}/${WS}/${rel}`] = orig;
    await writeFile(join(dir, `n${i}.md`), edited(i) ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  if (withState) await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  if (manifest) store[`${OWNER}/${WS}/__manifest__.json`] = sealSecret(Buffer.from(JSON.stringify({ files })));
  const count = async () => (await readdir(dir)).filter((x) => x.endsWith('.md')).length;
  return { dir, store, count };
}
const isManifest = (k) => k.endsWith('/__manifest__.json');

test('F4-a 매니페스트는 정상, 그 뒤 blob 확인만 만료(Bucket not found) — 로컬 삭제 0, 다음 정상 사이클 원격 삭제 0', async () => {
  const WS = 'co-midcycle';
  // n5·n6: 항목만 빠짐(blob 있음, 동시 덮어쓰기) / n7·n8: 다른 기기가 진짜 지움(blob 없음)
  const { dir, store, count } = await seedCompany(WS, 10, { inManifest: (i) => i < 5 || i > 8, blobs: (i) => i !== 7 && i !== 8 });
  const f = storage(store);
  _setSyncClientForTest(f.client);
  f.state.downloadError = (k) => (isManifest(k) ? null : BUCKET_NOT_FOUND); // 매니페스트 읽은 뒤 토큰 만료
  const r1 = await syncCompany(WS, OWNER, false).catch((e) => ({ err: e }));
  assert.equal(await count(), 10, '만료 blob 확인이 로컬 파일을 지우지 않는다');
  assert.equal(r1.deletedL ?? 0, 0);
  f.state.downloadError = null;
  _setSyncClientForTest(f.client);
  await syncCompany(WS, OWNER, false);
  assert.deepEqual(f.log.removed, [], '다음 정상 사이클이 원격을 지우지 않는다');
  for (const i of [5, 6]) assert.equal(await readFile(join(dir, `n${i}.md`), 'utf8'), `# 원본 ${i}\n`, `n${i} 보존`);
});

test('F4-b 큰 회사(14개)에서 매니페스트만 없음으로 읽힘 + blob 있음 — 사이클 보류: 업로드 0(매니페스트 쓰기 0)·삭제 0', async () => {
  const WS = 'co-misread';
  // 다른 기기가 n12·n13을 지웠고(blob 없음) 이 기기는 n0~n2를 고쳤다 — 수정 파일 업로드도 판정보다 먼저 나가면 안 된다
  const { store, count } = await seedCompany(WS, 14, { blobs: (i) => i < 12, edited: (i) => i < 3 });
  const f = storage(store);
  _setSyncClientForTest(f.client);
  for (const err of [OBJECT_NOT_FOUND]) { // 'Object not found'인데 실제로는 있음(다른 계정 토큰의 RLS 등) — '없음' 판정에 남은 오분류
    f.state.downloadError = (k) => (isManifest(k) ? err : null);
    _setSyncClientForTest(f.client);
    await assert.rejects(() => syncCompany(WS, OWNER, false), /매니페스트 없음과 모순/);
    assert.deepEqual(f.log.uploads, [], '아무것도 올리지 않는다(지운 파일 부활 0, 매니페스트 덮어쓰기 0)');
    assert.deepEqual(f.log.removed, []);
    assert.equal(await count(), 14, '로컬 삭제 0');
    assert.ok(!f.store.has(`${OWNER}/${WS}/vault/notes/n12.md`), '지운 파일이 원격에 되살아나지 않는다');
  }
});

test('F2-3 첫 사이클(기록 없음)에서 매니페스트를 없음으로 읽었는데 로컬 파일의 blob이 있으면 보류 — 다른 기기 변경을 덮지 않는다', async () => {
  const WS = 'co-first';
  const { store, count } = await seedCompany(WS, 4, { withState: false, edited: (i) => i === 0 });
  const f = storage(store);
  f.state.downloadError = (k) => (isManifest(k) ? OBJECT_NOT_FOUND : null);
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /매니페스트 없음과 모순/);
  assert.deepEqual(f.log.uploads, [], '업로드 0');
  assert.equal(await count(), 4);
});

test('F2-2 매니페스트 정상 사이클에서 blob 없음 → 로컬 삭제 전 매니페스트 재확인이 실패하면 사이클 보류(로컬 삭제 0)', async () => {
  const WS = 'co-recheck';
  // n5: 항목만 빠졌고 blob은 있지만 blob 확인이 잘못 '없음'(다른 계정 토큰 등)으로 나온다
  const { dir, store } = await seedCompany(WS, 10, { inManifest: (i) => i !== 5 });
  const f = storage(store);
  let manifestReads = 0;
  f.state.downloadError = (k) => {
    if (isManifest(k)) return ++manifestReads === 1 ? null : { message: 'Internal Server Error', status: 500 };
    return k.endsWith('/n5.md') ? OBJECT_NOT_FOUND : null;
  };
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /매니페스트 재확인 실패/);
  assert.equal(await readFile(join(dir, 'n5.md'), 'utf8'), '# 원본 5\n', 'n5 보존');
  assert.deepEqual(f.log.uploads, [], '매니페스트를 쓰지 않는다');
  assert.equal(manifestReads, 2, '재확인은 한 번');
});

test('인접 핀 — 매니페스트 정상 + blob 진짜 없음(다른 기기가 지움) + 재확인 성공 → 지금처럼 로컬도 지운다', async () => {
  const WS = 'co-realdel';
  const { dir, store } = await seedCompany(WS, 10, { inManifest: (i) => i !== 9, blobs: (i) => i !== 9 });
  const f = storage(store);
  let manifestReads = 0;
  f.state.downloadError = (k) => { if (isManifest(k)) manifestReads++; return null; };
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.deletedL, 1);
  assert.ok(!(await readdir(dir)).includes('n9.md'));
  assert.ok(manifestReads >= 2, '삭제 후보가 있을 때 재확인 GET');
});

// LOW-1 — '없음'은 'Object not found' 하나뿐. 그 밖의 404 모양은 확인 불가로 보류한다(storage-js 2.110.2 statusCode는 문자열이라 숫자 비교 무의미).
const NOT_ABSENT = {
  plainNotFound: { message: 'Not Found', status: 404, statusCode: '404' },          // JSON 없는 404(statusText)
  kongNoRoute: { message: 'no Route matched with those values', status: 404, statusCode: '404' },
  resourceNotFound: { message: 'The resource was not found', status: 404, statusCode: '404' },
  enoent: { message: 'ENOENT: no such file or directory, open x', name: 'StorageUnknownError' },
  bucket: BUCKET_NOT_FOUND,
};
for (const [name, err] of Object.entries(NOT_ABSENT)) {
  test(`LOW-1 ${name} — 매니페스트 읽기에서는 읽기 실패로 보류(쓰기 0), blob 검사에서는 로컬 삭제 0`, async () => {
    const WSm = `low1-m-${name.toLowerCase()}`;
    const m = await seedCompany(WSm, 10);
    const fm = storage(m.store);
    fm.state.downloadError = (k) => (isManifest(k) ? err : null);
    _setSyncClientForTest(fm.client);
    await assert.rejects(() => syncCompany(WSm, OWNER, false), /매니페스트 읽기 실패/);
    assert.deepEqual(fm.log.uploads, []);
    assert.equal(await m.count(), 10);

    const WSb = `low1-b-${name.toLowerCase()}`;
    const b = await seedCompany(WSb, 10, { inManifest: (i) => i < 6 }); // n6~n9: 항목만 빠짐(blob 있음)
    const fb = storage(b.store);
    fb.state.downloadError = (k) => (isManifest(k) ? null : err);
    _setSyncClientForTest(fb.client);
    const r = await syncCompany(WSb, OWNER, false).catch(() => ({ deletedL: 0 }));
    assert.equal(r.deletedL, 0);
    assert.equal(await b.count(), 10, 'blob 확인 불가가 로컬 파일을 지우지 않는다');
    assert.deepEqual(fb.log.removed, []);
  });
}
