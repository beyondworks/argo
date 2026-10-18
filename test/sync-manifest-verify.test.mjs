// 결함 B(2026-10-17): 매니페스트 시작 읽기·쓰기 직전 재읽기는 fresh()(cacheNonce GET)로 원본을 읽는다고 전제했지만(#832), 운영 CDN은 cacheNonce가 붙어도
// 매니페스트 GET의 59%를 캐시로 응답했다(24시간 HIT 1,654·MISS 1,140, 업로드 뒤 13.5·15.7초에 옛 판). 같은 기간 info는 HIT 0(EXPIRED 11,952).
// 처방: 받은 매니페스트 바이트의 MD5를 같은 사이클 info의 etag와 비교하고, 다르면 한 번 더 받은 뒤에도 다르면 그 바이트를 쓰지 않고 이번 사이클을 가볍게 보류한다
// (실패 대기 없음). 판정할 수 없으면(info 오류·MD5 꼴 아닌 etag) 종전대로. ARGO_SYNC_MANIFEST_VERIFY=0이면 배포본 경로. 경우 표: artifacts/manifest-verify/case-table.md.
// 인접 핀: 정상 경합(info와 GET 사이 다른 기기 쓰기)은 그대로 받는다·첫 실행·만료 토큰 보류·유휴 쓰기 0·끄는 스위치는 배포본 요청.
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-mverify-'));
process.env.ARGO_ROOT = ROOT;
for (const k of ['ARGO_SYNC_MANIFEST_REUSE', 'ARGO_SYNC_MANIFEST_VERIFY']) delete process.env[k];
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });
afterEach(() => { for (const k of ['ARGO_SYNC_MANIFEST_REUSE', 'ARGO_SYNC_MANIFEST_VERIFY']) delete process.env[k]; });

const OWNER = 'o';
const md5 = (b) => createHash('md5').update(b).digest('hex');
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const BUCKET_NOT_FOUND = { message: 'Bucket not found', status: 400, statusCode: '404' };
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };
const MKEY = (ws) => `${OWNER}/${ws}/__manifest__.json`;

/** 가짜 저장소 — info는 원본(운영 HIT 0), GET은 staleGet이 있으면 CDN 옛 판을 준다(cacheNonce와 무관 — 운영 59%). */
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
      const stale = state.staleGet?.(k);
      const b = stale !== undefined ? stale : store.get(k);
      note('GET', k, b?.length ?? 0);
      return b ? { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async info(k) {
      k = k.split('?')[0];
      note('INFO', k, 400);
      const forced = state.infoError?.(k);
      if (forced) return { data: null, error: forced };
      const b = store.get(k);
      const out = b ? { data: { etag: state.etagOf ? state.etagOf(b) : `"${md5(b)}"`, version: randomUUID(), size: b.length, lastModified: new Date().toISOString() }, error: null }
        : { data: null, error: { message: 'Object not found', status: 400, statusCode: '404' } };
      state.afterInfo?.(k);
      return out;
    },
    async upload(k, blob, opts) {
      const b = Buffer.from(await blob.arrayBuffer());
      note('PUT', k); (state.putOpts ??= []).push([k, opts]);
      store.set(k, b); state.afterUpload?.(k); return { error: null };
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
async function company(ws, f, n = 3) {
  const dir = join(ROOT, ws, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(dir, `n${i}.md`), `# 노트 ${i}\n`);
  _setSyncClientForTest(f.client);
  const r = await syncCompany(ws, OWNER, false);
  assert.equal(r.failed, 0, '첫 사이클 성공');
  return dir;
}
async function localChange(ws, dir, f, tag, { reset = true } = {}) {
  await writeFile(join(dir, 'n0.md'), `# 노트 0 — 고침 ${tag} ${'.'.repeat(tag.length)}\n`);
  if (reset) _setSyncClientForTest(f.client);
  f.reset();
  return syncCompany(ws, OWNER, false);
}
function otherDeviceAdds(f, ws, rel, body) {
  const b = Buffer.from(body);
  f.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(b));
  const files = f.manifest(ws).files;
  files[rel] = { m: Date.now(), s: b.length, h: hashBuf(b) };
  f.setManifest(ws, files);
}

test('V1 시작 읽기 GET이 옛 판(다른 기기가 항목을 더한 직후) — 옛 목록으로 덮지 않고 보류, 옛 판이 걷히면 받는다', async () => {
  const f = storage(); const ws = 'mv-start'; const dir = await company(ws, f);
  const old = f.store.get(MKEY(ws));
  otherDeviceAdds(f, ws, 'vault/notes/other.md', '# 다른 기기\n');
  f.state.staleGet = (k) => (k === MKEY(ws) ? old : undefined);
  const r = await localChange(ws, dir, f, 'a');
  assert.equal(r.skipped, 'manifest-stale', '이번 사이클은 보류');
  assert.equal(f.count('PUT', ws), 0, '매니페스트를 쓰지 않는다');
  assert.ok('vault/notes/other.md' in f.manifest(ws).files, '다른 기기 항목이 원격에 남는다');
  f.state.staleGet = null;
  const r2 = await syncCompany(ws, OWNER, false);
  assert.notEqual(r2.skipped, 'retry-backoff', 'V14 보류는 실패 대기를 만들지 않는다 — 바로 다음 사이클이 돈다');
  assert.equal(await readFile(join(dir, 'other.md'), 'utf8'), '# 다른 기기\n', '옛 판이 걷히자 받았다');
  assert.ok('vault/notes/other.md' in f.manifest(ws).files);
});

test('V2 쓰기 직전 재읽기 GET이 옛 판(사이클 도중 다른 기기가 씀 — 흔한 순서 "시작 MISS → 재읽기 HIT") — 덮지 않고 보류', async () => {
  const f = storage(); const ws = 'mv-reread'; const dir = await company(ws, f);
  const start = f.store.get(MKEY(ws));
  let fired = false;
  f.state.afterUpload = (k) => {
    if (!fired && k.endsWith('/n0.md')) { fired = true; otherDeviceAdds(f, ws, 'vault/notes/race.md', '# 경합\n'); f.state.staleGet = (kk) => (kk === MKEY(ws) ? start : undefined); }
  };
  const r = await localChange(ws, dir, f, 'b');
  assert.ok(fired, '전제: 사이클 도중 다른 기기가 썼다');
  assert.equal(r.skipped, 'manifest-stale');
  assert.ok('vault/notes/race.md' in f.manifest(ws).files, '다른 기기 항목을 덮지 않는다');
});

test('V3 정상 경합 — info와 GET 사이에 다른 기기가 쓰면 한 번 더 확인해 새 판을 그대로 쓴다(보류 아님)', async () => {
  const f = storage(); const ws = 'mv-race-ok'; const dir = await company(ws, f);
  let fired = false;
  f.state.afterInfo = (k) => { if (!fired && k === MKEY(ws)) { fired = true; otherDeviceAdds(f, ws, 'vault/notes/between.md', '# 사이\n'); } };
  const r = await localChange(ws, dir, f, 'c');
  assert.ok(fired);
  assert.notEqual(r.skipped, 'manifest-stale', '정상 경합은 보류하지 않는다');
  assert.equal(r.failed, 0);
  assert.equal(await readFile(join(dir, 'between.md'), 'utf8'), '# 사이\n', '새 판을 받았다');
});

test('V4 삭제 전파 뒤 옛 판 — 이 기기가 지운 항목을 옛 판이 되살리지 않는다', async () => {
  const f = storage(); const ws = 'mv-del'; const dir = await company(ws, f);
  const before = f.store.get(MKEY(ws));
  await rm(join(dir, 'n2.md'));
  _setSyncClientForTest(f.client); await syncCompany(ws, OWNER, false);
  assert.equal('vault/notes/n2.md' in f.manifest(ws).files, false);
  f.state.staleGet = (k) => (k === MKEY(ws) ? before : undefined);
  await localChange(ws, dir, f, 'd');
  assert.equal('vault/notes/n2.md' in f.manifest(ws).files, false, '지운 항목이 되살아나지 않는다');
});

test('V8b info는 있다는데 GET이 "없음"(음성 캐시) — 빈 원격으로 읽고 남의 목록을 덮지 않는다', async () => {
  const f = storage(); const ws = 'mv-negcache'; const dir = await company(ws, f);
  otherDeviceAdds(f, ws, 'vault/notes/keep.md', '# 지켜야 할 항목\n');
  f.state.downloadError = (k) => (k === MKEY(ws) ? OBJECT_NOT_FOUND : null);
  const r = await localChange(ws, dir, f, 'e');
  assert.equal(r.skipped, 'manifest-stale');
  assert.ok('vault/notes/keep.md' in f.manifest(ws).files, '남의 항목이 남는다(첫 밀기로 덮지 않음)');
});

test('V8c info는 없다는데 GET이 바이트를 줌(지운 매니페스트의 옛 사본) — 그 바이트를 쓰지 않고 보류', async () => {
  const f = storage(); const ws = 'mv-ghost'; const dir = await company(ws, f);
  const ghost = f.store.get(MKEY(ws));
  f.store.delete(MKEY(ws));
  f.state.staleGet = (k) => (k === MKEY(ws) ? ghost : undefined);
  const r = await localChange(ws, dir, f, 'g');
  assert.equal(r.skipped, 'manifest-stale');
  assert.equal(f.count('PUT', ws), 0);
});

test('V8 첫 실행(원격 없음) — info도 GET도 없음이면 종전처럼 첫 밀기', async () => {
  const f = storage(); const ws = 'mv-first';
  await company(ws, f);
  assert.ok(f.store.has(MKEY(ws)), '매니페스트를 올렸다');
});

test('V7 만료 토큰 — info 오류 + GET Bucket not found면 종전처럼 보류(쓰기·삭제 0)', async () => {
  const f = storage(); const ws = 'mv-exp'; const dir = await company(ws, f);
  f.state.infoError = () => ({ message: '"exp" claim timestamp check failed', status: 400, statusCode: '403' });
  f.state.downloadError = (k) => (k === MKEY(ws) ? BUCKET_NOT_FOUND : null);
  await localChange(ws, dir, f, 'h').catch(() => {});
  assert.equal(f.count('PUT', ws), 0);
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, 3);
});

test('V9·V10 판정할 수 없으면(MD5 꼴 아닌 etag / info 5xx) 배포본처럼 받은 바이트를 쓴다(보류하지 않는다)', async () => {
  for (const [name, setup] of [['etag', (f) => { f.state.etagOf = (b) => `"${md5(b)}-2"`; }], ['5xx', (f) => { f.state.infoError = () => ({ message: 'upstream', status: 502, statusCode: '502' }); }]]) {
    const f = storage(); const ws = `mv-undecided-${name}`; const dir = await company(ws, f);
    setup(f);
    const r = await localChange(ws, dir, f, 'i').catch((e) => ({ thrown: String(e.message) }));
    assert.notEqual(r.skipped, 'manifest-stale', `${name}: 판정 불가는 보류하지 않는다`);
  }
});

test('V11 끄는 스위치(ARGO_SYNC_MANIFEST_VERIFY=0) — 배포본과 같은 요청(로컬만 바뀐 주기 INFO 1·GET 2·PUT 1)', async () => {
  process.env.ARGO_SYNC_MANIFEST_VERIFY = '0';
  const f = storage(); const ws = 'mv-off'; const dir = await company(ws, f);
  await localChange(ws, dir, f, 'j');
  assert.deepEqual([f.count('INFO', ws), f.count('GET', ws), f.count('PUT', ws)], [1, 2, 1]);
});

test('V13 유휴 — 반복 사이클 쓰기 0', async () => {
  const f = storage(); const ws = 'mv-idle'; await company(ws, f);
  f.reset();
  for (let i = 0; i < 5; i++) await syncCompany(ws, OWNER, false);
  assert.equal(f.log.ops.filter((x) => x.startsWith('PUT') || x.startsWith('DEL')).length, 0);
});

test('V12 #1068 재사용 켜짐과 함께 — 시작 읽기 옛 판 상황에서도 다른 기기 항목을 지킨다', async () => {
  process.env.ARGO_SYNC_MANIFEST_REUSE = '1';
  const f = storage(); const ws = 'mv-reuse'; const dir = await company(ws, f);
  const old = f.store.get(MKEY(ws));
  otherDeviceAdds(f, ws, 'vault/notes/other2.md', '# 다른 기기 2\n');
  f.state.staleGet = (k) => (k === MKEY(ws) ? old : undefined);
  await localChange(ws, dir, f, 'k');
  assert.ok('vault/notes/other2.md' in f.manifest(ws).files);
});

test('V1b 시작 읽기만 옛 판이고 재읽기는 원본 — 다른 기기가 고친 항목의 메타를 옛 값으로 덮지 않는다(재읽기 병합은 빠진 항목만 더하므로 시작 읽기 검증이 막아야 한다)', async () => {
  const f = storage(); const ws = 'mv-start-only'; const dir = await company(ws, f);
  const old = f.store.get(MKEY(ws));
  const rel = 'vault/notes/n1.md'; const nb = Buffer.from('# 노트 1 — 다른 기기가 고침\n');
  f.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(nb));
  const files = f.manifest(ws).files; files[rel] = { m: files[rel].m + 60_000, s: nb.length, h: hashBuf(nb) }; f.setManifest(ws, files);
  let served = false;
  f.state.staleGet = (k) => { if (k === MKEY(ws) && !served) { served = true; return old; } return undefined; }; // 첫 GET(시작 읽기)만 옛 판
  await localChange(ws, dir, f, 'm');
  assert.equal(f.manifest(ws).files[rel].h, hashBuf(nb), '다른 기기가 고친 메타가 원격에 남는다');
  f.state.staleGet = null;
  await syncCompany(ws, OWNER, false);
  assert.equal(await readFile(join(dir, 'n1.md'), 'utf8'), '# 노트 1 — 다른 기기가 고침\n', '이 기기도 고친 내용을 받는다');
});

/* ── 부하 측정(가짜 저장소, 파일 2,000개): 검증 꺼짐(배포본 경로) / 켜짐 / 켜짐 + #1068 재사용 ── */
async function loadRun(ws, mode) {
  if (mode === 'off') process.env.ARGO_SYNC_MANIFEST_VERIFY = '0'; else delete process.env.ARGO_SYNC_MANIFEST_VERIFY;
  if (mode === 'reuse') process.env.ARGO_SYNC_MANIFEST_REUSE = '1'; else delete process.env.ARGO_SYNC_MANIFEST_REUSE;
  const f = storage(); const dir = await company(ws, f, 2000);
  const tally = () => ({ get: f.count('GET', ws), info: f.count('INFO', ws), put: f.count('PUT', ws), bytes: f.log.bytes });
  const local = { get: 0, info: 0, put: 0, bytes: 0 }, prop = { ...local }, idle = { ...local };
  const add = (acc, t) => { for (const k in acc) acc[k] += t[k]; };
  for (let i = 0; i < 10; i++) { await localChange(ws, dir, f, 'L'.repeat(i + 1)); add(local, tally()); }
  for (let i = 0; i < 3; i++) { otherDeviceAdds(f, ws, `vault/notes/o${i}.md`, `# 다른 기기 ${i}\n`); await localChange(ws, dir, f, 'P'.repeat(i + 1)); add(prop, tally()); }
  f.reset(); for (let i = 0; i < 10; i++) await syncCompany(ws, OWNER, false); add(idle, tally());
  const idleWrites = f.log.ops.filter((x) => x.startsWith('PUT') || x.startsWith('DEL')).length;
  return { mbytes: f.store.get(MKEY(ws)).length, local, prop, idle, idleWrites };
}
test('부하 — 검증 켜짐은 로컬이 바뀐 주기에 info 1건만 더하고 GET·PUT은 같다, 유휴 쓰기 0', async () => {
  const off = await loadRun('mv-load-off', 'off');
  const on = await loadRun('mv-load-on', 'on');
  const reuse = await loadRun('mv-load-reuse', 'reuse');
  console.log('[부하]', JSON.stringify({ off, on, reuse }));
  assert.equal(on.local.get, off.local.get); assert.equal(on.local.put, off.local.put);
  assert.equal(on.local.info, off.local.info + 10, '로컬이 바뀐 주기 10번 × info +1');
  assert.equal(on.idleWrites, 0); assert.equal(off.idleWrites, 0); assert.equal(reuse.idleWrites, 0);
});

/* ── 엄격 검수 지적 1(M2 총괄 독립 에이전트, 2026-10-17 22:09 KST): 보류가 이어질 때 횟수 상한·실패 대기·화면 표시가 없었다 ──
   S1: etag가 32자리 hex인데 내용 MD5가 아닌 저장소 — 사이클마다 보류(PUT 0)하며 info 2·GET 2를 끝없이 불렀다.
   S2: CDN 옛 판이 안 걷힘 — 유휴 기기도 10사이클에 GET 20·info 20(배포본은 GET 1·info 1 뒤 유휴).
   처방: 같은 회사에서 3번 연속 보류되면 실패 대기(30초부터 두 배, 최대 5분). 검증 없이 진행하지 않는다(옛 판으로 덮으면 다른 기기 항목 유실). */
const STALE_CAP = { get: 6, info: 6 }; // 연달아 돈 10사이클: 3번 보류 × (info 2·GET 2) — 그 뒤는 실패 대기라 요청 0
const STALE_CAP_8S = { get: 8, info: 8 }; // 8초 주기 10사이클(80초): 3번 보류 + 30초 대기 뒤 1번 = 4번 × 2 (지적 전 20·20, 배포본 1·1 뒤 유휴)

test('S1 etag가 32자리 hex인데 내용 MD5가 아님 — 10사이클 내내 덮지 않고(PUT 0), 3번 보류 뒤 실패 대기로 GET·info 각 6건 이하', async () => {
  const f = storage(); const ws = 'mv-s1'; const dir = await company(ws, f);
  f.state.etagOf = (b) => `"${md5(Buffer.concat([b, Buffer.from('-not-content')]))}"`; // MD5 꼴이지만 내용 MD5가 아니다
  await writeFile(join(dir, 'n0.md'), '# 노트 0 — S1 로컬 변경\n');
  f.reset();
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push(await syncCompany(ws, OWNER, false));
  assert.equal(f.count('PUT', ws), 0, '검증 없이 진행하지 않는다 — 매니페스트를 덮지 않는다');
  assert.ok(f.count('GET', ws) <= STALE_CAP.get && f.count('INFO', ws) <= STALE_CAP.info, `요청 상한: GET ${f.count('GET', ws)}·info ${f.count('INFO', ws)}`);
  assert.deepEqual(rs.slice(0, 3).map((r) => [r.skipped, r.staleStrikes]), [['manifest-stale', 1], ['manifest-stale', 2], ['manifest-stale', 3]]);
  assert.ok(rs[2].retryAt > Date.now() && rs[2].retryAt - Date.now() <= 30_000 + 1000, '3번째 보류에서 실패 대기 시작(30초)');
  assert.ok(rs.slice(3).every((r) => r.skipped === 'retry-backoff'), '대기 중에는 요청하지 않는다');
});

test('S2 CDN 옛 판이 안 걷힘 — 유휴 기기도 8초 주기 10사이클에 GET·info 각 8건 이하(지적 전 20·20), 다른 기기 항목은 원격에 남는다', async () => {
  const realNow = Date.now; let off = 0;
  Date.now = () => realNow() + off;
  try {
    const f = storage(); const ws = 'mv-s2'; await company(ws, f);
    const old = f.store.get(MKEY(ws));
    otherDeviceAdds(f, ws, 'vault/notes/s2.md', '# 다른 기기 S2\n');
    f.state.staleGet = (k) => (k === MKEY(ws) ? old : undefined);
    f.reset();
    for (let i = 0; i < 10; i++) { off = 61_000 + i * 8000; await syncCompany(ws, OWNER, false); } // 유휴 확인(60초) 뒤부터 8초 주기
    assert.ok(f.count('GET', ws) >= 2, `전제: 유휴 확인이 판이 바뀐 것을 보고 받으러 갔다(GET ${f.count('GET', ws)})`);
    assert.ok(f.count('GET', ws) <= STALE_CAP_8S.get && f.count('INFO', ws) <= STALE_CAP_8S.info, `요청 상한: GET ${f.count('GET', ws)}·info ${f.count('INFO', ws)}`);
    assert.equal(f.count('PUT', ws), 0);
    assert.ok('vault/notes/s2.md' in f.manifest(ws).files);
  } finally { Date.now = realNow; }
});

test('S2b 실패 대기는 30초부터 두 배·최대 5분 — 한 시간(8초 주기 450번) 동안 보류 사이클 20번 이하, 옛 판이 걷히면 받고 보류 횟수는 처음부터', async () => {
  const realNow = Date.now; let off = 0;
  Date.now = () => realNow() + off;
  try {
    const f = storage(); const ws = 'mv-s2b'; const dir = await company(ws, f);
    const old = f.store.get(MKEY(ws));
    otherDeviceAdds(f, ws, 'vault/notes/s2b.md', '# 다른 기기 S2b\n');
    f.state.staleGet = (k) => (k === MKEY(ws) ? old : undefined);
    f.reset();
    const waits = []; let held = 0;
    for (let t = 0; t < 3_600_000; t += 8000) {
      off = t;
      const r = await syncCompany(ws, OWNER, false);
      if (r.skipped === 'manifest-stale') { held++; if (r.retryAt) waits.push(r.retryAt - Date.now()); }
    }
    console.log('[보류 한 시간]', JSON.stringify({ held, get: f.count('GET', ws), info: f.count('INFO', ws), waits }));
    assert.ok(held <= 20, `보류 사이클 ${held}번(상한 없으면 450번)`);
    assert.ok(f.count('GET', ws) <= 2 * held && f.count('INFO', ws) <= 2 * held);
    assert.equal(Math.max(...waits), 300_000, `최대 대기 5분: ${waits.join(',')}`);
    assert.deepEqual(waits.slice(0, 4), [30_000, 60_000, 120_000, 240_000], '30초부터 두 배');
    // 옛 판이 걷힘 — 대기가 끝나면 받는다, 보류 횟수는 0부터
    f.state.staleGet = null; off += 300_001;
    const ok = await syncCompany(ws, OWNER, false);
    assert.equal(ok.skipped, undefined, `걷히면 동기화: ${JSON.stringify(ok)}`);
    assert.equal(await readFile(join(dir, 's2b.md'), 'utf8'), '# 다른 기기 S2b\n');
    f.state.staleGet = (k) => (k === MKEY(ws) ? old : undefined);
    otherDeviceAdds(f, ws, 'vault/notes/s2c.md', '# 다른 기기 S2c\n');
    off += 8000;
    const again = await syncCompany(ws, OWNER, false);
    assert.deepEqual([again.skipped, again.staleStrikes], ['manifest-stale', 1], '검증된 매니페스트를 읽으면 보류 횟수는 처음부터');
  } finally { Date.now = realNow; }
});

test('매니페스트 업로드만 짧은 cacheControl(0) — 파일 업로드는 기본값 그대로(옵션 없음)', async () => {
  const f = storage(); const ws = 'mv-cc'; await company(ws, f);
  const opts = f.state.putOpts;
  const man = opts.filter(([k]) => k === MKEY(ws));
  const files = opts.filter(([k]) => k !== MKEY(ws));
  assert.ok(man.length >= 1 && files.length >= 1, '전제: 매니페스트와 파일을 올렸다');
  assert.ok(man.every(([, o]) => o?.cacheControl === '0'), `매니페스트: ${JSON.stringify(man.map(([, o]) => o))}`);
  assert.ok(files.every(([, o]) => o?.cacheControl === undefined), '파일 업로드는 바꾸지 않는다(storage-js 기본 3600)');
});
