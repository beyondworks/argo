// 매니페스트 판 재사용(2026-10-17 전송량 조사 — 소유자 737d57의 회사 매니페스트 1.73MB를 6시간에 445번 GET, 미적중 Storage 전송량의 약 70%).
// 동기화는 로컬이 바뀐 주기마다 매니페스트를 시작 읽기 + 쓰기 직전 재읽기로 두 번 받는다. ARGO_SYNC_MANIFEST_REUSE=1이면 이 기기가 마지막으로 받거나 올린 바이트를
// 보관하고, info()의 etag(= 내용 MD5)가 보관 바이트의 MD5와 같을 때만 받지 않는다. 판이 아니라 내용 해시로 비교하므로 경합·같은 크기 덮어쓰기·CDN 옛 판에서도
// 틀린 내용을 쓰지 않는다. 기본은 꺼짐(배포본과 같은 요청). 경우 표: artifacts/manifest-reuse/case-table.md(M1~M16).
// 인접 핀: 다른 기기 변경은 반드시 받는다·삭제 전파·동시 수정 병합·만료 토큰 보류·업로드 실패 뒤 다시 받기·유휴 쓰기 0.
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-mreuse-'));
process.env.ARGO_ROOT = ROOT;
delete process.env.ARGO_SYNC_MANIFEST_REUSE;
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });
afterEach(() => { delete process.env.ARGO_SYNC_MANIFEST_REUSE; });

const OWNER = 'o';
const md5 = (b) => createHash('md5').update(b).digest('hex');
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const BUCKET_NOT_FOUND = { message: 'Bucket not found', status: 400, statusCode: '404' };
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };
const MKEY = (ws) => `${OWNER}/${ws}/__manifest__.json`;

/** 가짜 저장소 — info()는 운영처럼 etag = "<내용 MD5>"를 돌려준다. 요청을 키·종류별로 세고 받은 바이트를 더한다. */
function storage() {
  const store = new Map();
  const state = {};
  const log = { ops: [], bytes: 0 };
  const note = (op, k, n = 0) => { log.ops.push(`${op} ${k}`); log.bytes += n; };
  const bucket = {
    async download(k) {
      k = k.split('?')[0];
      const forced = state.downloadError?.(k);
      if (forced) { note('GET', k); return { data: null, error: forced }; }
      const b = state.staleGet?.(k) ?? store.get(k); // staleGet: CDN 옛 판을 흉내(원본이 아닌 바이트)
      note('GET', k, b?.length ?? 0);
      return b ? { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async info(k) {
      const [base, query = ''] = k.split('?');
      k = base;
      note('INFO', k, 400);
      if (/cacheNonce=/.test(query)) log.nonceInfo = (log.nonceInfo || 0) + 1;
      const forced = state.infoError?.(k);
      if (forced) return { data: null, error: forced };
      const b = (!/cacheNonce=/.test(query) && state.staleInfo?.(k)) || store.get(k); // staleInfo: CDN이 info를 캐시해 옛 판의 메타를 주는 경우 — 이 가짜는 cacheNonce가 붙으면 원본을 준다고 가정한다(운영은 보장 안 됨 — 시험 머리말 M17)
      if (!b) return { data: null, error: { message: 'Object not found', status: 404, statusCode: '404' } };
      return { data: { etag: state.etagOf ? state.etagOf(b) : `"${md5(b)}"`, version: randomUUID(), size: b.length, lastModified: new Date().toISOString() }, error: null };
    },
    async upload(k, blob) {
      const b = Buffer.from(await blob.arrayBuffer());
      note('PUT', k);
      const forced = state.uploadError?.(k);
      if (forced) return { error: forced };
      store.set(k, b); state.afterUpload?.(k);
      if (state.lostResponse?.(k)) return { error: { message: 'fetch failed', status: 500, statusCode: '500' } };
      return { error: null };
    },
    async remove(keys) { for (const k of keys) { note('DEL', k); store.delete(k); } return { data: [], error: null }; },
    async list() { return { data: [], error: null }; },
  };
  const manifest = (ws) => JSON.parse(openSecretCompat(store.get(MKEY(ws))).toString());
  const setManifest = (ws, files) => store.set(MKEY(ws), sealSecret(Buffer.from(JSON.stringify({ files }))));
  const count = (op, ws) => log.ops.filter((x) => x === `${op} ${MKEY(ws)}`).length;
  const reset = () => { log.ops.length = 0; log.bytes = 0; };
  return { client: { storage: { from: () => bucket } }, store, state, log, manifest, setManifest, count, reset };
}
/** 로컬 회사 하나 — 노트 n개. 첫 사이클로 원격에 올린다. */
async function company(ws, f, n = 3) {
  const dir = join(ROOT, ws, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `n${i}.md`), `# 노트 ${i}\n`);
  _setSyncClientForTest(f.client);
  const r = await syncCompany(ws, OWNER, false);
  assert.equal(r.failed, 0, '첫 사이클 성공');
  return dir;
}
/** 로컬만 바꾼 다음 사이클 — 에이전트가 일하는 회사의 평소 모양. */
async function localChange(ws, dir, f, tag) {
  await writeFile(join(dir, 'n0.md'), `# 노트 0 — 고침 ${tag} ${'.'.repeat(tag.length)}\n`);
  _setSyncClientForTest(f.client); // 재시도 대기만 비운다(보관본은 프로세스 메모리 — 그대로)
  f.reset();
  return syncCompany(ws, OWNER, false);
}
/** 다른 기기가 원격에 파일을 더함(객체 + 매니페스트 항목). */
function otherDeviceAdds(f, ws, rel, body) {
  const b = Buffer.from(body);
  f.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(b));
  const files = f.manifest(ws).files;
  files[rel] = { m: Date.now(), s: b.length, h: hashBuf(b) };
  f.setManifest(ws, files);
}

test('M11 플래그 꺼짐(기본) — 로컬만 바뀐 주기는 배포본처럼 매니페스트를 두 번 받는다(시작 읽기 + 쓰기 직전 재읽기)', async () => {
  const f = storage(); const ws = 'mr-off'; const dir = await company(ws, f);
  const r = await localChange(ws, dir, f, 'a');
  assert.equal(r.failed, 0);
  assert.equal(f.count('GET', ws), 2, '배포본과 같은 GET 2번');
  assert.equal(f.count('PUT', ws), 1);
});

test('M1 켜짐 — 내가 마지막으로 쓴 판이 그대로면 로컬만 바뀐 주기에 매니페스트 GET 0, 쓰기는 그대로 1번', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-on'; const dir = await company(ws, f, 40);
  for (const tag of ['a', 'bb', 'ccc']) {
    const r = await localChange(ws, dir, f, tag);
    assert.equal(r.failed, 0);
    assert.equal(f.count('GET', ws), 0, `주기 ${tag}: GET 0`);
    assert.equal(f.count('PUT', ws), 1, `주기 ${tag}: 매니페스트 쓰기 1번(변경 반영)`);
    assert.equal(f.manifest(ws).files['vault/notes/n0.md'].s, Buffer.byteLength(`# 노트 0 — 고침 ${tag} ${'.'.repeat(tag.length)}\n`), '원격 매니페스트에 이번 변경이 들어갔다');
  }
});

test('M5 다른 기기가 파일을 더한 뒤 — 켜져 있어도 반드시 받는다(etag 불일치 → GET)', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-other'; const dir = await company(ws, f);
  otherDeviceAdds(f, ws, 'vault/notes/from-other.md', '# 다른 기기 노트\n');
  const r = await localChange(ws, dir, f, 'x');
  assert.equal(r.failed, 0);
  assert.ok(f.count('GET', ws) >= 1, '매니페스트를 받는다');
  assert.equal(await readFile(join(dir, 'from-other.md'), 'utf8'), '# 다른 기기 노트\n', '다른 기기 파일이 이 기기에 왔다');
});

test('M2 같은 크기로 다른 기기가 덮어씀 — 길이가 같아도 내용 해시가 달라 받는다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-samesize'; const dir = await company(ws, f);
  const rel = 'vault/notes/n1.md';
  const nb = Buffer.from('# 노트 9\n'); // '# 노트 1\n'과 같은 길이
  f.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(nb));
  const files = f.manifest(ws).files; files[rel] = { ...files[rel], m: files[rel].m + 5_000, h: hashBuf(nb) };
  const before = f.store.get(MKEY(ws)).length;
  f.setManifest(ws, files);
  assert.equal(f.store.get(MKEY(ws)).length, before, '전제: 매니페스트 크기가 같다');
  await localChange(ws, dir, f, 'y');
  assert.equal(await readFile(join(dir, 'n1.md'), 'utf8'), '# 노트 9\n', '같은 크기 덮어쓰기도 받는다');
});

test('M6 삭제 전파 — 다른 기기가 지운 파일은 켜져 있어도 이 기기에서 지워진다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-del'; const dir = await company(ws, f);
  const rel = 'vault/notes/n2.md';
  f.store.delete(`${OWNER}/${ws}/${rel}`);
  const files = f.manifest(ws).files; delete files[rel]; f.setManifest(ws, files);
  await localChange(ws, dir, f, 'z');
  assert.equal((await readdir(dir)).includes('n2.md'), false, '삭제가 전파됐다');
  assert.equal('vault/notes/n2.md' in f.manifest(ws).files, false, '항목을 되살리지 않는다');
});

test('M7 동시 수정 — 시작 읽기 뒤 쓰기 전에 다른 기기가 항목을 더하면 재읽기가 알아채 병합한다(덮어써 잃지 않는다)', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-race'; const dir = await company(ws, f);
  let fired = false;
  f.state.afterUpload = (k) => { if (!fired && k.endsWith('/n0.md')) { fired = true; otherDeviceAdds(f, ws, 'vault/notes/race.md', '# 경합 노트\n'); } };
  await localChange(ws, dir, f, 'r');
  assert.ok(fired, '전제: 사이클 도중 다른 기기가 썼다');
  assert.ok('vault/notes/race.md' in f.manifest(ws).files, '다른 기기 항목이 원격 매니페스트에 남는다');
});

test('M3 CDN 옛 판 — 원본 판이 그대로면 옛 사본을 받지 않아, 지운 항목을 되살리지도 밀지도 않는다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-cdn'; const dir = await company(ws, f);
  const oldBuf = f.store.get(MKEY(ws)); // 지우기 전 판
  await rm(join(dir, 'n2.md'));
  _setSyncClientForTest(f.client); await syncCompany(ws, OWNER, false); // 이 기기가 n2를 지우고 항목을 뺀 매니페스트를 올렸다
  assert.equal('vault/notes/n2.md' in f.manifest(ws).files, false);
  f.state.staleGet = (k) => (k === MKEY(ws) ? oldBuf : undefined); // 이제 매니페스트 GET은 옛 판(CDN 사본)을 준다
  await localChange(ws, dir, f, 'c');
  assert.equal(f.count('GET', ws), 0, '옛 사본을 받지 않는다');
  assert.equal('vault/notes/n2.md' in f.manifest(ws).files, false, '지운 항목이 되살아나지 않는다');
});

test('M10 만료 토큰 — info가 실패하면 GET으로 떨어지고, GET이 Bucket not found면 지우지 않고 보류한다(보관본을 쓰지 않는다)', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-exp'; const dir = await company(ws, f);
  f.state.infoError = () => ({ message: '"exp" claim timestamp check failed', status: 400, statusCode: '403' });
  f.state.downloadError = (k) => (k === MKEY(ws) ? BUCKET_NOT_FOUND : null);
  await localChange(ws, dir, f, 'e').catch(() => {});
  assert.equal(f.count('PUT', ws), 0, '매니페스트를 쓰지 않는다');
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, 3, '로컬 파일을 지우지 않는다');
});

/** 응답이 끊긴 주기 뒤 다음 주기의 결과 — 플래그 켜짐·꺼짐을 같은 상황으로 돌려 비교한다(배포본 동작이 기준). */
async function lostResponseRun(ws, on) {
  if (on) process.env.ARGO_SYNC_MANIFEST_REUSE = '1'; else delete process.env.ARGO_SYNC_MANIFEST_REUSE;
  const f = storage(); const dir = await company(ws, f);
  f.state.lostResponse = (k) => k === MKEY(ws); // 저장은 되고 응답만 실패(네트워크 끊김)
  await localChange(ws, dir, f, 'u').catch(() => {});
  f.state.lostResponse = null;
  const r = await localChange(ws, dir, f, 'uu');
  const local = Object.fromEntries(await Promise.all((await readdir(dir)).sort().map(async (n) => [n, await readFile(join(dir, n), 'utf8')])));
  return { gets: f.count('GET', ws), files: f.manifest(ws).files, local, r: { failed: r.failed, conflicts: r.conflicts ?? 0 } };
}

test('M14 매니페스트가 서버에는 올라갔는데 응답이 실패한 뒤 — 보관본(옛 바이트)이 원격과 달라 다음 주기에는 받고, 결과가 배포본(꺼짐)과 같다', async () => {
  const off = await lostResponseRun('mr-lost-off', false);
  const on = await lostResponseRun('mr-lost-on', true);
  assert.ok(on.gets >= 1, '보관본이 원격과 달라 받는다');
  const norm = (name) => name.replace(/\.conflict-.+-\d+\./, '.conflict-X.'); // 충돌 사본 이름의 기기·시각 꼬리
  const strip = (files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [norm(k), { s: v.s, h: v.h }]));
  const normLocal = (local) => Object.fromEntries(Object.entries(local).map(([k, v]) => [norm(k), v]));
  assert.deepEqual(strip(on.files), strip(off.files), '원격 매니페스트 결과가 배포본과 같다');
  assert.deepEqual(normLocal(on.local), normLocal(off.local), '로컬 파일 결과가 배포본과 같다(충돌 사본 포함)');
  assert.deepEqual(on.r, off.r);
});

test('M14b 매니페스트 업로드가 거절된 뒤(원격 그대로) — 보관본이 원격과 같으니 받지 않아도 된다, 다음 주기에 변경을 올린다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-upreject'; const dir = await company(ws, f);
  f.state.uploadError = (k) => (k === MKEY(ws) ? { message: 'fetch failed', status: 500, statusCode: '500' } : null);
  await localChange(ws, dir, f, 'v').catch(() => {});
  f.state.uploadError = null;
  await localChange(ws, dir, f, 'vv');
  assert.equal(f.manifest(ws).files['vault/notes/n0.md'].s, Buffer.byteLength(`# 노트 0 — 고침 vv ${'.'.repeat(2)}\n`), '변경이 원격에 올라갔다');
});

test('M12 etag가 MD5 꼴이 아니면(여러 조각 업로드 등) 재사용하지 않는다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-multipart'; const dir = await company(ws, f);
  f.state.etagOf = (b) => `"${md5(b)}-2"`;
  await localChange(ws, dir, f, 'm');
  assert.equal(f.count('GET', ws), 2, '종전처럼 두 번 받는다');
});

test('M13 유휴 — 켜져 있어도 로컬·원격이 그대로인 반복 사이클은 쓰기 0', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-idle'; await company(ws, f);
  f.reset();
  for (let i = 0; i < 5; i++) await syncCompany(ws, OWNER, false); // 클라이언트를 다시 끼우지 않는다(끼우면 유휴 기록까지 지워져 매번 전체 사이클)
  assert.equal(f.log.ops.filter((x) => x.startsWith('PUT') || x.startsWith('DEL')).length, 0, '유휴 쓰기 0');
  assert.equal(f.count('GET', ws), 0, '유휴는 매니페스트도 받지 않는다(idle-probe)');
});

/* ── 부하 측정(가짜 저장소): 파일 2,000개 회사 — 로컬만 바뀐 주기 10번·다른 기기 변경 3번·유휴 10번을 꺼짐/켜짐으로 나란히 ── */
async function loadRun(ws, on) {
  if (on) process.env.ARGO_SYNC_MANIFEST_REUSE = '1'; else delete process.env.ARGO_SYNC_MANIFEST_REUSE;
  const f = storage(); const dir = await company(ws, f, 2000);
  const mbytes = f.store.get(MKEY(ws)).length;
  const tally = () => ({ get: f.count('GET', ws), info: f.count('INFO', ws), put: f.count('PUT', ws), bytes: f.log.bytes });
  const local = { get: 0, info: 0, put: 0, bytes: 0 }, prop = { ...local }, idle = { ...local };
  const add = (acc, t) => { for (const k in acc) acc[k] += t[k]; };
  for (let i = 0; i < 10; i++) { await localChange(ws, dir, f, 'L'.repeat(i + 1)); add(local, tally()); }
  for (let i = 0; i < 3; i++) { otherDeviceAdds(f, ws, `vault/notes/o${i}.md`, `# 다른 기기 ${i}\n`); await localChange(ws, dir, f, 'P'.repeat(i + 1)); add(prop, tally()); }
  f.reset(); for (let i = 0; i < 10; i++) await syncCompany(ws, OWNER, false); add(idle, tally());
  const allPuts = f.log.ops.filter((x) => x.startsWith('PUT') || x.startsWith('DEL')).length;
  for (let i = 0; i < 3; i++) assert.equal(await readFile(join(dir, `o${i}.md`), 'utf8'), `# 다른 기기 ${i}\n`, '다른 기기 변경은 모두 받았다');
  return { mbytes, local, prop, idle, idleWrites: allPuts };
}
test('부하 — 파일 2,000개 회사: 로컬만 바뀐 주기의 매니페스트 GET·바이트가 켜짐에서 0에 가깝고, 변경 전파는 받고, 유휴 쓰기는 0', async () => {
  const off = await loadRun('mr-load-off', false);
  const on = await loadRun('mr-load-on', true);
  console.log('[부하]', JSON.stringify({ manifestBytes: off.mbytes, off, on }));
  assert.equal(off.local.get, 20, '꺼짐: 로컬만 바뀐 주기 10번 × GET 2');
  assert.equal(on.local.get, 0, '켜짐: GET 0');
  assert.ok(on.local.bytes < off.local.bytes * 0.05, `켜짐 바이트 ${on.local.bytes} < 꺼짐 ${off.local.bytes}의 5%`);
  assert.equal(on.local.put, off.local.put, '매니페스트 쓰기 수는 같다');
  assert.ok(on.prop.get >= 3, '다른 기기 변경 주기는 받는다');
  assert.equal(on.idleWrites, 0); assert.equal(off.idleWrites, 0);
});

test('M17 info가 옛 판의 etag를 주는 CDN — cacheNonce가 원본을 준다고 가정할 때 다른 기기 변경을 덮지 않고 받는다(운영에서는 보장되지 않음 — 안전 근거는 운영 info가 EXPIRED·HIT 0인 것, 승격 조건으로 확인)', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-staleinfo'; const dir = await company(ws, f);
  const before = f.store.get(MKEY(ws)); // 이 기기가 마지막으로 올린 판(보관본과 같다)
  otherDeviceAdds(f, ws, 'vault/notes/other-stale.md', '# 옛 info 뒤 다른 기기 노트\n');
  f.state.staleInfo = (k) => (k === MKEY(ws) ? before : undefined); // 캐시된 info는 옛 판의 etag(= 보관본 MD5)를 준다
  await localChange(ws, dir, f, 's');
  assert.ok('vault/notes/other-stale.md' in f.manifest(ws).files, '다른 기기 항목이 원격 매니페스트에 남는다(덮지 않음)');
  assert.equal(await readFile(join(dir, 'other-stale.md'), 'utf8'), '# 옛 info 뒤 다른 기기 노트\n', '이 기기에 받았다');
});

test('M17b 꺼짐 — 매니페스트 info에 cacheNonce 쿼리를 붙이지 않는다(배포본과 같은 요청)', async () => {
  const f = storage(); const ws = 'mr-off-nonce'; const dir = await company(ws, f);
  await localChange(ws, dir, f, 'n');
  assert.equal(f.log.nonceInfo || 0, 0);
});

test('M17c 사이클 도중 다른 기기가 쓰고 info가 시작 때 판을 캐시해 주는 경우 — 재읽기 info에도 cacheNonce를 붙여, 그것이 원본을 줄 때 알아채고 병합한다(운영 보장 아님 — M17과 같은 전제)', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mr-staleinfo-race'; const dir = await company(ws, f);
  const start = f.store.get(MKEY(ws)); // 시작 읽기 때 원격 = 보관본
  let fired = false;
  f.state.afterUpload = (k) => {
    if (!fired && k.endsWith('/n0.md')) { fired = true; otherDeviceAdds(f, ws, 'vault/notes/race-stale.md', '# 경합 + 옛 info\n'); f.state.staleInfo = (kk) => (kk === MKEY(ws) ? start : undefined); }
  };
  await localChange(ws, dir, f, 'q');
  assert.ok(fired, '전제: 사이클 도중 다른 기기가 썼다');
  assert.ok('vault/notes/race-stale.md' in f.manifest(ws).files, '다른 기기 항목이 원격 매니페스트에 남는다(덮지 않음)');
});
