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
import { mkdir, writeFile, readFile, readdir, rm, rename } from 'node:fs/promises';
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
  const log = { uploads: [], removed: [], gets: 0 };
  const bucket = {
    async download(k) {
      k = k.split('?')[0];
      log.gets++;
      if (state.mode === 'expired') return { data: null, error: BUCKET_NOT_FOUND };
      const forced = state.downloadError?.(k);
      if (forced) return { data: null, error: forced };
      return store.has(k) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(k)).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async upload(k, blob) {
      log.uploads.push(k);
      if (state.mode === 'expired') return { error: JWT_EXPIRED };
      const forced = state.uploadError?.(k);
      if (forced) return { error: forced };
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

test('정리된 원격(매니페스트·blob 모두 없음) 큰 회사 — main처럼 대량 삭제 브레이크로 보류: 삭제 0, 쓰기 0, GET 1', async () => {
  const WS = 'co-wiped';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {}, N = 14; // 무변경 11개 — 대량 삭제 브레이크(max(8, 절반)) 위
  for (let i = 0; i < N; i++) {
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[`vault/notes/n${i}.md`] = meta(orig);
    await writeFile(join(dir, `n${i}.md`), i < 3 ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  const f = storage({}); // 매니페스트도 객체도 없다(Object not found) — 원격이 비었다
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /대량 삭제 감지/);
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, N, '로컬 삭제 0');
  assert.deepEqual(f.log.uploads, [], '다시 밀지 않는다');
  assert.equal(f.log.gets, 1, '매니페스트 읽기 1건(main과 같음)');
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
const NET_FAIL = { message: 'fetch failed', name: 'StorageUnknownError' };
const RLS_DENIED = { message: 'new row violates row-level security policy', status: 400, statusCode: '403' };
async function seedFresh(WS, n) { // 기록(state) 없는 회사 — 첫 동기화 전
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  await writeFile(join(ROOT, WS, 'company.json'), JSON.stringify({ id: WS, ownerId: OWNER }));
  for (let i = 0; i < n; i++) await writeFile(join(dir, `n${i}.md`), `# ${i}\n`);
  return { dir, count: async () => (await readdir(dir)).filter((x) => x.endsWith('.md')).length };
}
const blobKeys = (f, WS) => [...f.store.keys()].filter((k) => k.startsWith(`${OWNER}/${WS}/`) && !isManifest(k));
const remoteText = (f, WS, rel) => openSecretCompat(f.store.get(`${OWNER}/${WS}/${rel}`)).toString();

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

// F4-b(최종 검수 뒤 결정) — 매니페스트가 없는 사이클은 '다른 기기가 지웠다'를 추론하지 않는다. 기록(state)이 있고 이 기기가 안 고친 파일은
// blob이 있으면 main처럼 항목만 되살리고(치유 — blob을 덮지 않는다), blob이 하나라도 없으면 지우지도 다시 밀지도 않고 사이클 전체를 보류한다.
// 보류는 어떤 업로드보다 먼저다. 후보가 브레이크 아래인 회사(이 기기가 많이 고침)로 사전 확인 경로를 직접 본다.
test('F4-b 매니페스트 없음 + 무변경 파일 blob이 모두 있음 — main처럼 치유(다른 기기 내용을 덮지 않음), 고친 파일만 밈, 삭제 0, blob GET 후보당 1건', async () => {
  const WS = 'co-misread';
  // 이 기기는 n0~n7을 고쳤다(무변경 후보 n8~n13 = 6개, 브레이크 아래). 다른 기기가 n9를 고쳤다(blob 내용이 기록과 다름). n10 blob은 봉투
  const { store, count } = await seedCompany(WS, 14, { edited: (i) => i < 8, manifest: false });
  store[`${OWNER}/${WS}/vault/notes/n9.md`] = Buffer.from('# 다른 기기에서 고침 9\n');
  store[`${OWNER}/${WS}/vault/notes/n10.md`] = sealSecret(Buffer.from('# 원본 10\n'));
  const f = storage(store);
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.deletedL, 0, '로컬 삭제 0');
  assert.equal(await count(), 14);
  assert.equal(r.healed, 6, 'blob이 남은 무변경 파일(n8~n13)은 항목만 되살린다');
  assert.equal(r.pushed, 8, '고친 파일(n0~n7)만 민다');
  assert.equal(f.store.get(`${OWNER}/${WS}/vault/notes/n9.md`).toString(), '# 다른 기기에서 고침 9\n', '다른 기기의 내용을 덮지 않는다');
  assert.equal(remoteText(f, WS, 'vault/notes/n0.md'), '# 이 기기에서 고침 0\n', '이 기기의 수정이 올라간다');
  assert.equal(f.log.gets, 1 + 6 + 1, 'GET = 매니페스트 읽기 + 후보 blob 6(사전 확인 결과를 루프가 다시 씀) + 재읽기 — main과 같다');
  const manifest = JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
  assert.equal(Object.keys(manifest.files).length, 14, '매니페스트가 다시 채워진다');
});

test('F4-c 매니페스트 없음 + 무변경 파일 하나라도 blob 없음 — 지우지도 다시 밀지도 않고 사이클 보류(업로드 전), 다음 사이클도 같다', async () => {
  const WS = 'co-misread-gap';
  const { dir, store, count } = await seedCompany(WS, 14, { edited: (i) => i < 8, blobs: (i) => i !== 12, manifest: false });
  const f = storage(store);
  for (let c = 0; c < 2; c++) {
    _setSyncClientForTest(f.client);
    await assert.rejects(() => syncCompany(WS, OWNER, false), /클라우드 사본이 비어 있어 이 회사 동기화를 멈췄습니다/);
  }
  assert.deepEqual(f.log.uploads, [], '고친 파일도 올리지 않는다(보류가 업로드보다 먼저)');
  assert.deepEqual(f.log.removed, []);
  assert.equal(await count(), 14, '로컬 삭제 0');
  assert.equal(await readFile(join(dir, 'n0.md'), 'utf8'), '# 이 기기에서 고침 0\n');
});

// F2-2 — 재확인은 '매니페스트를 다시 읽어 성공'일 때만 통과다. 재확인에서 매니페스트가 '없음'(Object not found)이면 그 사이 매니페스트가
// 사라진 것이라 삭제 근거가 없다 — 오류와 똑같이 보류한다(없음을 통과로 바꾸는 변이 M3b를 잡는다).
for (const [name, recheckErr] of [['500', { message: 'Internal Server Error', status: 500 }], ['Object not found', OBJECT_NOT_FOUND]]) {
  test(`F2-2 매니페스트 정상 사이클에서 blob 없음 → 로컬 삭제 전 매니페스트 재확인이 ${name}이면 사이클 보류(로컬 삭제 0)`, async () => {
    const WS = `co-recheck-${name.replace(/\W+/g, '').toLowerCase()}`;
    // n5: 항목만 빠졌고 blob은 있지만 blob 확인이 잘못 '없음'(다른 계정 토큰 등)으로 나온다
    const { dir, store } = await seedCompany(WS, 10, { inManifest: (i) => i !== 5 });
    const f = storage(store);
    let manifestReads = 0;
    f.state.downloadError = (k) => {
      if (isManifest(k)) return ++manifestReads === 1 ? null : recheckErr;
      return k.endsWith('/n5.md') ? OBJECT_NOT_FOUND : null;
    };
    _setSyncClientForTest(f.client);
    await assert.rejects(() => syncCompany(WS, OWNER, false), /매니페스트 재확인 실패/);
    assert.equal(await readFile(join(dir, 'n5.md'), 'utf8'), '# 원본 5\n', 'n5 보존');
    assert.deepEqual(f.log.uploads, [], '매니페스트를 쓰지 않는다');
    assert.equal(manifestReads, 2, '재확인은 한 번');
  });
}

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

// ── 첫 동기화 끊김(재검수 HIGH-1) ──
// state는 사이클 끝에만 써진다. 첫 동기화가 매니페스트를 쓰기 전에 끊기면(매니페스트 PUT 실패·앱 종료·잠자기·토큰 만료)
// 이 기기가 방금 올린 blob만 남는다 — 이것을 보류하면 그 회사는 이 기기에서 영구히 멈춘다. main처럼 다음 사이클이 다시 밀어 복구한다.

test('HIGH-1 첫 사이클이 blob을 다 올린 뒤 매니페스트 쓰기 실패 — 다음 사이클이 모두 다시 밀고 매니페스트를 쓴다(영구 보류 아님)', async () => {
  const WS = 'first-mfail';
  const { count } = await seedFresh(WS, 20);
  const f = storage({});
  f.state.uploadError = (k) => (isManifest(k) ? NET_FAIL : null);
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false));
  assert.equal(blobKeys(f, WS).length, 21, '파일 blob은 올라갔다');
  assert.ok(!f.store.has(`${OWNER}/${WS}/__manifest__.json`), '매니페스트는 없다');
  f.state.uploadError = null;
  for (let c = 0; c < 2; c++) { // 다음 사이클 — 재시도 대기는 비운다(저장소 내용은 그대로)
    _setSyncClientForTest(f.client);
    const r = await syncCompany(WS, OWNER, false);
    if (c === 0) { assert.equal(r.pushed, 21, '모두 다시 민다'); assert.equal(r.failed, 0); assert.equal(r.deletedL, 0); }
  }
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`), '매니페스트를 쓴다');
  assert.equal(await count(), 20);
});

test('HIGH-1 업로드 도중 끊김(blob 7개만) 뒤 이 기기에서 파일을 고쳐도 — 다음 사이클이 모두 다시 밀어 복구한다', async () => {
  const WS = 'first-cut-edit';
  const { dir, count } = await seedFresh(WS, 20);
  const f = storage({});
  let ok = 0;
  f.state.uploadError = (k) => (isManifest(k) || ++ok > 7 ? NET_FAIL : null); // 7개 올라간 뒤 끊김
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false));
  assert.equal(blobKeys(f, WS).length, 7);
  for (let i = 0; i < 20; i++) await writeFile(join(dir, `n${i}.md`), `# 고침 ${i}\n`); // 다음 사이클 전에 모두 고침 — 올라간 blob과 로컬이 다르다
  f.state.uploadError = null;
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.pushed, 21); assert.equal(r.failed, 0); assert.equal(r.deletedL, 0);
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`));
  for (let i = 0; i < 20; i++) assert.equal(remoteText(f, WS, `vault/notes/n${i}.md`), `# 고침 ${i}\n`);
  assert.equal(await count(), 20);
});

test('HIGH-1 이전 실행·이전 판이 남긴 blob(로컬과 같은 내용) — 다음 사이클이 복구한다', async () => {
  const WS = 'first-preseed';
  await seedFresh(WS, 20);
  const pre = {};
  for (let i = 0; i < 7; i++) pre[`${OWNER}/${WS}/vault/notes/n${i}.md`] = i === 3 ? sealSecret(Buffer.from(`# ${i}\n`)) : Buffer.from(`# ${i}\n`);
  const f = storage(pre);
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.pushed, 21); assert.equal(r.failed, 0);
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`));
});

// 3차 검수 oldfirst — 옛 판(0.1.95 이전)은 기록 없이 첫 동기화를 남긴다. 그 뒤 로컬이 바뀌어도 새 판이 영구 보류하지 않고 main처럼 다시 민다.
test('옛 판이 남긴 끊긴 첫 동기화(blob만 남고 매니페스트·state 없음) 뒤 로컬을 고쳐도 — 다음 사이클이 다시 민다(보류 없음)', async () => {
  const WS = 'first-oldver';
  await seedFresh(WS, 3);
  const pre = { [`${OWNER}/${WS}/company.json`]: Buffer.from(JSON.stringify({ id: WS, ownerId: OWNER })) };
  for (let i = 0; i < 3; i++) pre[`${OWNER}/${WS}/vault/notes/n${i}.md`] = Buffer.from(`# ${i}\n`);
  const renamed = JSON.stringify({ id: WS, ownerId: OWNER, name: '이름 바꿈' });
  await writeFile(join(ROOT, WS, 'company.json'), renamed); // 끊긴 뒤 로컬 변경 — 올라간 blob과 다르다
  const f = storage(pre);
  for (let c = 0; c < 3; c++) {
    _setSyncClientForTest(f.client);
    const r = await syncCompany(WS, OWNER, false);
    if (c === 0) { assert.equal(r.pushed, 4, '모두 다시 민다'); assert.equal(r.failed, 0); }
    else assert.equal(r.pushed + r.pulled + r.failed, 0, `사이클 ${c + 1}: 할 일 없음`);
  }
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`));
  assert.equal(remoteText(f, WS, 'company.json'), renamed);
});

// 3차 검수 2번(emptyman2) — 매니페스트 없는 원격에서 받을 것 없이 복원한 기기가 빈 매니페스트({files:{}})를 쓰면, 기록이 있는 기기의 다음 사이클이
// '매니페스트 있음 + 항목 없음 + blob 없음'을 '다른 기기가 지웠다'로 읽어 파일을 지운다. 복원 기기는 쓸 항목이 0이면 쓰지 않는다(main은 썼다).
test('emptyman2 매니페스트 없는 원격을 받을 것 없이 복원한 기기는 빈 매니페스트를 쓰지 않는다 — 기록이 있는 기기의 삭제 0', async () => {
  const WS = 'co-restore-empty';
  // 정리된 원격(매니페스트·blob 없음). 이 기기(A)는 기록 12개 중 n0~n7을 정리 기간에 고쳤다 — 무변경 4개는 대량 삭제 브레이크 아래
  const { count } = await seedCompany(WS, 12, { blobs: () => false, manifest: false, edited: (i) => i < 8 });
  const f = storage({});
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /클라우드 사본이 비어/); // A는 보류(업로드 0)
  assert.deepEqual(f.log.uploads, []);
  // 회사가 없는 다른 기기(C)가 색인으로 발견해 복원 — 같은 ARGO_ROOT라 A의 회사 폴더를 잠시 옮겨 C의 빈 로컬을 만든다
  const away = join(ROOT, `${WS}.away`);
  await rename(join(ROOT, WS), away);
  _setSyncClientForTest(f.client);
  const g = f.log.gets;
  const rc = await syncCompany(WS, OWNER, true);
  assert.equal(rc.pulled, 0, '받을 것 없음');
  assert.deepEqual(f.log.uploads, [], '복원 기기의 쓰기 0');
  assert.equal(f.log.gets - g, 1, '매니페스트 읽기 1건뿐(재읽기도 생략)');
  assert.ok(!f.store.has(`${OWNER}/${WS}/__manifest__.json`), '빈 매니페스트를 쓰지 않는다');
  await rm(join(ROOT, WS), { recursive: true, force: true });
  await rename(away, join(ROOT, WS));
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /클라우드 사본이 비어/); // A의 다음 사이클 — 여전히 보류, 삭제 0
  assert.equal(await count(), 12);
});

test('복원 기기 + 로컬 파일 + 매니페스트 없음 — 올린 파일이 있으면 main처럼 매니페스트를 쓰고, 다음 발견 주기에 blob GET을 반복하지 않는다', async () => {
  const WS = 'co-restore-local';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < 20; i++) await writeFile(join(dir, `n${i}.md`), `# ${i}\n`); // company.json 없음 = 색인 발견 복원 경로, 기록 없음
  const f = storage({});
  _setSyncClientForTest(f.client);
  const r1 = await syncCompany(WS, OWNER, true);
  assert.equal(r1.pushed, 20);
  assert.ok(f.store.has(`${OWNER}/${WS}/__manifest__.json`), '매니페스트를 쓴다');
  for (let c = 0; c < 2; c++) {
    _setSyncClientForTest(f.client);
    const g = f.log.gets;
    const r = await syncCompany(WS, OWNER, true);
    assert.equal(r.healed + r.pushed + r.deletedL, 0);
    assert.ok(f.log.gets - g <= 2, `발견 주기 ${c + 2}: GET ${f.log.gets - g}건 — 매니페스트 읽기·재읽기만(main과 같음)`);
  }
});

// 최종 검수 HIGH — 클라우드 사본이 통째로 정리된 뒤 기기 2대. 늦게 동기화한 기기 B(옛 사본)가 먼저 들어와도 최신 기기 A의 편집·파일이 남는다.
// 브레이크 위(무변경이 대부분)는 main처럼 대량 삭제 감지로, 브레이크 아래(이 기기가 많이 고침)는 사전 확인으로 둘 다 보류한다.
for (const [name, bEdited] of [['브레이크 위', 0], ['브레이크 아래', 4]]) {
  test(`wipe2 정리된 원격 + 기기 2대, 옛 사본 기기가 먼저(${name}) — 두 기기 모두 보류, A의 편집·A만 가진 파일 손실 0`, async () => {
    const WS = `co-wipe2-${bEdited}`;
    const N = 5, E = 2;
    const devA = join(ROOT, `${WS}.A`), devB = join(ROOT, `${WS}.B`);
    const seed = async (files, edits = {}) => { // 기록 = files(마지막 동기화 때 내용), 로컬 = files + edits
      const dir = join(ROOT, WS, 'vault', 'notes');
      await mkdir(dir, { recursive: true });
      const base = {};
      for (const [rel, b] of Object.entries(files)) { base[rel] = meta(Buffer.from(b)); await writeFile(join(ROOT, WS, rel), edits[rel] ?? b); }
      await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
    };
    const A = {}, B = {};
    for (let i = 0; i < N; i++) {
      B[`vault/notes/n${i}.md`] = `# n${i} v0\n`;
      A[`vault/notes/n${i}.md`] = i < E ? `# n${i} vA\n` : `# n${i} v0\n`;
    }
    A['vault/notes/x0.md'] = '# x0 A만 가진 파일\n';
    const bEdits = Object.fromEntries([...Array(bEdited).keys()].map((i) => [`vault/notes/n${i}.md`, `# n${i} B가 고침\n`]));
    await seed(A); await rename(join(ROOT, WS), devA);
    await seed(B, bEdits); await rename(join(ROOT, WS), devB);
    const f = storage({}); // 정리된 원격
    const as = async (dev, fn) => { await rename(dev, join(ROOT, WS)); try { return await fn(); } finally { await rename(join(ROOT, WS), dev); } };
    const hold = bEdited ? /클라우드 사본이 비어/ : /대량 삭제 감지/;
    for (const dev of [devB, devA, devA, devB]) {
      _setSyncClientForTest(f.client);
      await as(dev, () => assert.rejects(() => syncCompany(WS, OWNER, false), dev === devB ? hold : /대량 삭제 감지|클라우드 사본이 비어/));
    }
    assert.deepEqual(f.log.uploads, [], '옛 사본으로 매니페스트를 새로 쓰지 않는다');
    for (let i = 0; i < E; i++) assert.equal(await readFile(join(devA, 'vault/notes', `n${i}.md`), 'utf8'), `# n${i} vA\n`, `A의 편집 n${i} 남음`);
    assert.equal(await readFile(join(devA, 'vault/notes/x0.md'), 'utf8'), '# x0 A만 가진 파일\n', 'A만 가진 파일 남음');
    assert.equal((await readdir(join(devB, 'vault/notes'))).length, N, 'B 삭제 0');
  });
}

test('빈 원격 + 기록 1개(브레이크 미적용) — main은 로컬을 지웠지만 이제 보류: 삭제 0, 쓰기 0, GET 2', async () => {
  const WS = 'co-wiped-one';
  const { count } = await seedCompany(WS, 1, { blobs: () => false, manifest: false });
  const f = storage({});
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /클라우드 사본이 비어/);
  assert.equal(await count(), 1, '로컬 삭제 0');
  assert.deepEqual(f.log.uploads, []);
  assert.equal(f.log.gets, 2, '매니페스트 읽기 + blob 확인 1건');
});

test('빈 원격 + 업로드 거절 반복 + 기록 20개 — 사이클마다 GET 1·PUT 0(main과 같음, 재시도마다 2N 요청 아님)', async () => {
  const WS = 'deny-wiped';
  await seedCompany(WS, 20, { blobs: () => false, manifest: false });
  const f = storage({});
  f.state.uploadError = () => RLS_DENIED;
  for (let c = 0; c < 3; c++) {
    _setSyncClientForTest(f.client);
    const g = f.log.gets, u = f.log.uploads.length;
    await assert.rejects(() => syncCompany(WS, OWNER, false));
    assert.equal(f.log.gets - g, 1, `사이클 ${c + 1}: GET 1`);
    assert.equal(f.log.uploads.length - u, 0, `사이클 ${c + 1}: 업로드 시도 0`);
  }
});

// MEDIUM-2 — 매니페스트 없는 사이클이 요청을 늘리지 않는다: 업로드가 계속 거절되는 첫 동기화 기기도 main처럼 매니페스트 읽기·재읽기 2건.
test('MEDIUM-2 매니페스트 없음 + 업로드가 계속 거절되는 첫 동기화 기기 — 사이클마다 GET은 매니페스트 2건(main과 같음)', async () => {
  const WS = 'deny-cost';
  await seedFresh(WS, 20);
  const f = storage({});
  f.state.uploadError = () => RLS_DENIED;
  for (let c = 0; c < 4; c++) {
    _setSyncClientForTest(f.client);
    const g = f.log.gets;
    await assert.rejects(() => syncCompany(WS, OWNER, false));
    assert.ok(f.log.gets - g <= 2, `사이클 ${c + 1}: GET ${f.log.gets - g}건 — 매니페스트 읽기·재읽기만`);
  }
  assert.equal(blobKeys(f, WS).length, 0, '거절이라 아무것도 안 올라갔다');
});

// LOW-3 — 매니페스트 없는 사이클의 무변경 파일 blob 확인이 오류면 main처럼 그 파일만 실패로 두고 지우지도 밀지도 않는다(보류 판정은 '없음'일 때만).
// 그 파일은 이번 매니페스트에서 빠지고, 다음 사이클이 다시 올린다(유실 없음).
for (const [name, err] of [['e500', { message: 'Internal Server Error', status: 500, statusCode: '500' }], ['bucket', BUCKET_NOT_FOUND]]) {
  test(`LOW-3 매니페스트 없음 + 무변경 파일의 blob 확인 불가(${name}) — 그 파일은 실패로 두고 지우지도 밀지도 않으며, 다음 사이클이 다시 올린다`, async () => {
    const WS = `probe-err-${name}`;
    const { count, store } = await seedCompany(WS, 12, { edited: (i) => i < 8, manifest: false }); // 무변경 후보 n8~n11, blob 있음
    const f = storage(store);
    f.state.downloadError = (k) => (k.endsWith('/n9.md') ? err : null); // 매니페스트는 진짜 없음(Object not found)
    _setSyncClientForTest(f.client);
    const r = await syncCompany(WS, OWNER, false);
    assert.equal(r.failed, 1); assert.equal(r.deletedL, 0); assert.equal(r.healed, 3);
    assert.ok(!f.log.uploads.some((k) => k.endsWith('/n9.md')), '확인 못 한 파일은 밀지 않는다');
    assert.equal(await count(), 12);
    f.state.downloadError = null;
    _setSyncClientForTest(f.client);
    const r2 = await syncCompany(WS, OWNER, false);
    assert.equal(r2.deletedL, 0); assert.equal(r2.healed + r2.pushed, 1, '다음 사이클이 n9를 원격 매니페스트에 다시 올린다(main과 같은 파일 단위 실패 경로)');
    const manifest = JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
    assert.ok('vault/notes/n9.md' in manifest.files);
    assert.equal(await count(), 12);
  });
}

// 사전 확인은 루프와 같은 파일만 본다 — 계정 키가 없는 사이클의 암호화 대상은 main처럼 불가시 보류(held)이고, blob이 없다고 사이클을 멈추지 않는다.
test('사전 확인 대상 = 루프와 같음 — 키 없는 기기 + 매니페스트 없음 + blob 없는 노트는 main처럼 held, 사이클 보류 아님', async () => {
  const WS = 'nokey-wiped';
  const { clearAccountKey } = await import('../src/accountkey.mjs');
  const { count } = await seedCompany(WS, 5, { blobs: () => false, manifest: false });
  const f = storage({});
  clearAccountKey();
  try {
    _setSyncClientForTest(f.client);
    const r = await syncCompany(WS, OWNER, false);
    assert.equal(r.held, 5, '노트는 불가시 보류');
    assert.equal(r.deletedL, 0);
    assert.ok(!f.log.uploads.some((k) => k.includes('/vault/notes/')), '노트를 올리지 않는다');
    assert.equal(await count(), 5);
  } finally { await useFakeAccountKey(3, 'o'); }
});

test('사전 확인 대상 = 루프와 같음 — 자격 동기화 끔(noSecrets) + 매니페스트 없음 + blob 없는 .secrets.json은 main처럼 건너뜀, 사이클 보류 아님', async () => {
  const WS = 'nosecrets-wiped';
  await seedCompany(WS, 3, { blobs: () => false, manifest: false, edited: () => true });
  const sec = Buffer.from(JSON.stringify({ k: 'local-only' }));
  await writeFile(join(ROOT, WS, '.secrets.json'), sec);
  const st = JSON.parse(await readFile(join(ROOT, WS, '.sync-state.json'), 'utf8'));
  st.files['.secrets.json'] = meta(sec);
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify(st));
  const f = storage({});
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false, { noSecrets: true });
  assert.equal(r.pushed, 3, '고친 노트는 main처럼 민다');
  assert.ok(!f.log.uploads.some((k) => k.endsWith('/.secrets.json')), '자격 파일은 건너뜀');
  assert.equal(await readFile(join(ROOT, WS, '.secrets.json'), 'utf8'), sec.toString(), '로컬 자격 파일 그대로');
});
