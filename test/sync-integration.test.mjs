// 통합 실행 검증 — syncCompany를 fake Supabase storage + 임시 ARGO_ROOT로 실제 돌려
// 데이터유실 방어 배선(판정→실제 storage 호출)을 검증한다. 실 Supabase 없이 라이브에 가장 근접.
//
// 격리: Node test runner는 파일별 별도 프로세스라, 여기서 ARGO_ROOT를 먼저 세팅한 뒤
// sync.mjs를 동적 import해야 WS_ROOT(모듈 로드 시 고정)가 이 임시 루트를 가리킨다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-int-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;

const { syncCompany, _setSyncClientForTest, _tombstonesForTest, isDiscoverDue, syncFailedMessage, syncStatusFor } = await import('../src/sync.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const { openSecretCompat, sealSecret } = await import('../src/secretbox.mjs');
// 회사 데이터 전체 봉투(v2)가 기본 켜짐(2026-09-06) — 실환경처럼 계정 키를 확보해야 동기화가 돈다(미확보 = 전체 불가시 보류).
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-sync-integration');
/** 클라우드 사본 판독 — 업로드는 봉투이므로 관용 개봉 뒤 JSON */
const cloudJson = (buf) => JSON.parse(openSecretCompat(buf).toString());
const { archiveCompany, TOMBSTONE_DIR } = await import('../src/workspace.mjs');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

test('one idle hour bounds manifest reads to 57 with 8s ticks and never rewrites', async () => {
  const buf = Buffer.from('unchanged');
  const { fake } = await setup('idle-egress', { localFiles: { 'vault/a.md': buf }, state: { 'vault/a.md': meta(buf) }, remoteFiles: { 'vault/a.md': meta(buf) } });
  fake._store.set(`${OWNER}/idle-egress/__manifest__.json`, sealSecret(fake._store.get(`${OWNER}/idle-egress/__manifest__.json`)));
  const bucket = fake.storage.from(); let reads = 0, writes = 0, bytes = 0;
  const download = bucket.download.bind(bucket), upload = bucket.upload.bind(bucket);
  const size = fake._store.get(`${OWNER}/idle-egress/__manifest__.json`).length;
  bucket.download = async (key) => { if (key.endsWith('__manifest__.json')) { reads++; bytes += fake._store.get(key).length; } return download(key); };
  bucket.upload = async (...args) => { writes++; return upload(...args); };
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    for (let i = 0; i < 450; i++) { await syncCompany('idle-egress', OWNER); now += 8000; }
  } finally { Date.now = realNow; }
  assert.equal(reads, 57); assert.equal(writes, 0); assert.equal(bytes, size * 57);
});

test('partial blob download failure also backs off even when manifest write succeeds', async () => {
  const buf = Buffer.from('remote');
  const { fake } = await setup('partial-egress', { remoteFiles: { 'vault/a.md': meta(buf) } });
  let reads = 0; const bucket = fake.storage.from(), download = bucket.download.bind(bucket);
  bucket.download = async (key) => { reads++; return key.endsWith('a.md') ? { error: { status: 403, message: 'denied' } } : download(key); };
  assert.equal((await syncCompany('partial-egress', OWNER)).failed, 1);
  const before = reads;
  assert.equal((await syncCompany('partial-egress', OWNER)).skipped, 'retry-backoff');
  assert.equal(reads, before);
});

test('revision probe avoids full GET across an idle hour and detects remote revision changes', async () => {
  const { fake } = await setup('revision-egress', {});
  const key = `${OWNER}/revision-egress/__manifest__.json`;
  fake._store.set(key, sealSecret(fake._store.get(key)));
  const bucket = fake.storage.from(); let reads = 0, infos = 0, version = 'v1';
  const download = bucket.download.bind(bucket);
  bucket.info = async () => { infos++; return { data: { version, size: fake._store.get(key).length } }; };
  bucket.download = async (...args) => { reads++; return download(...args); };
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    for (let i = 0; i < 450; i++) { await syncCompany('revision-egress', OWNER); now += 8000; }
    assert.equal(reads, 1); assert.equal(infos, 57);
    version = 'v2'; now += 61_000;
    await syncCompany('revision-egress', OWNER);
    assert.equal(reads, 2);
    bucket.info = async () => ({ error: { status: 402, message: 'quota' } }); now += 61_000;
    await assert.rejects(syncCompany('revision-egress', OWNER), /quota/);
    assert.equal((await syncCompany('revision-egress', OWNER)).skipped, 'retry-backoff');
    assert.equal(reads, 2, 'metadata failure never falls through to full download');
  } finally { Date.now = realNow; }
});

test('local file changes bypass idle probe delay for immediate push', async () => {
  const buf = Buffer.from('before');
  const { fake, wsRoot } = await setup('changed-egress', { localFiles: { 'vault/a.md': buf }, state: { 'vault/a.md': meta(buf) }, remoteFiles: { 'vault/a.md': meta(buf) } });
  await syncCompany('changed-egress', OWNER);
  await writeFile(join(wsRoot, 'vault/a.md'), 'after');
  const r = await syncCompany('changed-egress', OWNER);
  assert.equal(r.pushed, 1);
  assert.equal(openSecretCompat(fake._store.get(`${OWNER}/changed-egress/vault/a.md`)).toString(), 'after');
});

test('a local edit during the remote read is not cached as already synced', async () => {
  const buf = Buffer.from('before');
  const { fake, wsRoot } = await setup('racing-egress', { localFiles: { 'vault/a.md': buf }, state: { 'vault/a.md': meta(buf) }, remoteFiles: { 'vault/a.md': meta(buf) } });
  const bucket = fake.storage.from(), upload = bucket.upload.bind(bucket);
  bucket.info = async () => ({ data: { version: 'same' } });
  let changed = false;
  bucket.upload = async (...args) => {
    if (!changed) { changed = true; await writeFile(join(wsRoot, 'vault/a.md'), 'concurrent edit'); }
    return upload(...args);
  };
  await syncCompany('racing-egress', OWNER);
  const result = await syncCompany('racing-egress', OWNER);
  assert.equal(result.pushed, 1);
  assert.equal(openSecretCompat(fake._store.get(`${OWNER}/racing-egress/vault/a.md`)).toString(), 'concurrent edit');
});

test('manifest write failure backs off repeated cycles and recovers after the deadline', async () => {
  const { fake } = await setup('retry-egress', {});
  const bucket = fake.storage.from(); let reads = 0, writes = 0;
  const download = bucket.download.bind(bucket), upload = bucket.upload.bind(bucket);
  bucket.download = async (...args) => { reads++; return download(...args); };
  bucket.upload = async (...args) => { writes++; return writes === 1 ? { error: { status: 402, message: 'quota unavailable' } } : upload(...args); };
  await assert.rejects(syncCompany('retry-egress', OWNER), /quota/);
  const atFailure = reads;
  for (let i = 0; i < 20; i++) assert.equal((await syncCompany('retry-egress', OWNER)).skipped, 'retry-backoff');
  assert.equal(reads, atFailure); assert.equal(writes, 1);
  const realNow = Date.now; Date.now = () => realNow() + 31_000;
  try { assert.equal((await syncCompany('retry-egress', OWNER)).skipped, undefined); }
  finally { Date.now = realNow; }
  assert.equal(writes, 2);
});

test('isolated HTTP storage: 402 downloads back off without further requests, then recover', async () => {
  const { fake } = await setup('http-egress', {});
  let requests = 0, blocked = true;
  const server = createServer((req, res) => {
    requests++;
    if (blocked) { res.writeHead(402); res.end('quota'); return; }
    res.end(fake._store.get(`${OWNER}/http-egress/__manifest__.json`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bucket = fake.storage.from();
  bucket.download = async () => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/manifest`);
    if (!r.ok) { await r.text(); return { error: { status: r.status, message: 'quota' } }; }
    return { data: new Blob([await r.arrayBuffer()]) };
  };
  const realNow = Date.now;
  try {
    await assert.rejects(syncCompany('http-egress', OWNER), /quota/);
    for (let i = 0; i < 10; i++) assert.equal((await syncCompany('http-egress', OWNER)).skipped, 'retry-backoff');
    assert.equal(requests, 1);
    blocked = false; Date.now = () => realNow() + 31_000;
    assert.equal((await syncCompany('http-egress', OWNER)).failed, 0);
    assert.ok(requests > 1);
  } finally { Date.now = realNow; await new Promise((resolve) => server.close(resolve)); }
});

test('browser cache signatures are invisible in both directions without excluding user Default documents', async () => {
  const junk = Buffer.from('cache'), doc = Buffer.from('keep');
  const cache = 'vault/검수-profile/Default/Cache/Cache_Data/data_0';
  const shader = 'vault/pdf-render-profile/GrShaderCache/index';
  const keep = 'vault/Default/Cache/notes.md';
  const { fake, wsRoot } = await setup('cache-egress', {
    localFiles: { [cache]: junk, [keep]: doc },
    remoteFiles: { [shader]: meta(junk) }, remoteBlobs: { [shader]: junk },
  });
  await syncCompany('cache-egress', OWNER);
  assert.equal(fake._store.has(`${OWNER}/cache-egress/${cache}`), false);
  assert.equal(existsSync(join(wsRoot, shader)), false);
  assert.equal(fake._store.has(`${OWNER}/cache-egress/${shader}`), true, 'no remote deletion');
  assert.equal(existsSync(join(wsRoot, cache)), true, 'no local deletion');
  assert.equal(fake._store.has(`${OWNER}/cache-egress/${keep}`), true);
});

// fake Supabase storage — 인메모리 Map<key, Buffer>. from(BUCKET).download/upload/remove만 구현.
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const bucket = {
    _listCalls: 0,
    async download(key) {
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) {
      store.set(key, Buffer.from(await blob.arrayBuffer()));
      return { error: null };
    },
    async remove(keys) {
      for (const k of keys) store.delete(k);
      return { error: null };
    },
    // Supabase storage list 모사 — prefix 바로 아래의 파일({id 있음})과 폴더({id: null})를 낸다.
    // 호출 수를 센다: 서버에서 list는 storage.search()로 실행되고 이게 DB CPU의 지배 항목이다
    // (프로덕션 실측 98.3%) — "몇 번 부르는가"가 이 코드의 비용 계약이라 테스트가 잠근다.
    async list(prefix) {
      bucket._listCalls++;
      const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
      const names = new Map(); // name → isFile
      for (const k of store.keys()) {
        if (!k.startsWith(p)) continue;
        const rest = k.slice(p.length);
        const seg = rest.split('/')[0];
        const isFile = !rest.includes('/');
        if (!names.has(seg) || isFile) names.set(seg, isFile);
      }
      return { data: [...names].map(([name, isFile]) => ({ name, id: isFile ? 'f' : null })) };
    },
  };
  return { _store: store, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

// 회사 하나 셋업 — 로컬 파일 + .sync-state(base) + fake 원격(매니페스트+blob).
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

/* ── [C] 손상 self-heal: 손상 백업이 있으면 삭제가 아니라 원격에서 복원 + 백업 청소 ── */
test('통합: 손상된 스레드는 삭제 전파가 아니라 원격 self-heal + .corrupt- 백업 청소', async () => {
  const wsId = 'coheal';
  const good = Buffer.from(JSON.stringify({ sessionId: 's1', messages: [{ who: 'user', text: 'hi', ts: 1 }] }));
  // 로컬: 정상 파일은 부재(손상돼 치워짐), .corrupt- 백업만 존재. 원격/ base는 정상본(무변경).
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'chats/sales.json.corrupt-111': Buffer.from('{ broken') },
    state: { 'chats/sales.json': meta(good) },
    remoteFiles: { 'chats/sales.json': meta(good) },
    remoteBlobs: { 'chats/sales.json': good },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.deletedR, 0, '원격 정상본을 삭제하지 않는다');
  assert.ok(existsSync(join(wsRoot, 'chats', 'sales.json')), '로컬 정상본이 복원된다(self-heal)');
  assert.deepEqual(JSON.parse(await readFile(join(wsRoot, 'chats', 'sales.json'), 'utf8')), JSON.parse(good.toString()));
  assert.ok(fake._store.has(`${OWNER}/${wsId}/chats/sales.json`), '원격 blob 유지');
  const leftovers = (await readdir(join(wsRoot, 'chats'))).filter((n) => n.includes('.corrupt-'));
  assert.equal(leftovers.length, 0, '소비한 .corrupt- 백업이 청소된다(부활 방지)');
});

/* ── [C] 대비군: 백업 없는 진짜 삭제는 여전히 원격으로 전파된다 ── */
test('통합: 백업 없는 진짜 삭제는 원격으로 정상 전파', async () => {
  const wsId = 'codel';
  const buf = Buffer.from(JSON.stringify({ sessionId: 's', messages: [{ who: 'user', text: 'x', ts: 1 }] }));
  // 로컬에 파일도 백업도 없음(사용자가 지움). 원격/base에는 존재.
  const { fake } = await setup(wsId, {
    localFiles: {},
    state: { 'chats/gone.json': meta(buf) },
    remoteFiles: { 'chats/gone.json': meta(buf) },
    remoteBlobs: { 'chats/gone.json': buf },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.deletedR, 1, '진짜 삭제는 원격 삭제로 전파');
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/chats/gone.json`), '원격 blob 삭제됨');
});

test('통합: 원격에서 발견된 빈 회사(재설치)는 대량삭제 브레이크 대신 전체 복원', async () => {
  const wsId = 'corestore';
  // 로컬 통째로 빔(재설치) · base엔 과거 매니페스트(21개 상당) · 원격 온전. isRestore=true 경로.
  const files = {}, blobs = {};
  for (let i = 0; i < 21; i++) {
    const b = Buffer.from(`# note ${i}\n`);
    files[`vault/notes/n${i}.md`] = meta(b);
    blobs[`vault/notes/n${i}.md`] = b;
  }
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: {},          // 로컬 비어 있음
    state: files,            // base = 원격과 동일(과거 pull 성공 기록, 로컬만 유실)
    remoteFiles: files,
    remoteBlobs: blobs,
  });
  const r = await syncCompany(wsId, OWNER, true); // isRestore

  assert.equal(r.deletedR, 0, '원격 삭제 전파 없음(브레이크 오탐 방지)');
  assert.equal(r.pulled, 21, '21개 전부 로컬로 복원');
  assert.ok(existsSync(join(wsRoot, 'vault', 'notes', 'n0.md')), '복원 파일이 실제로 로컬에 씀');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/notes/n0.md`), '원격은 그대로 보존');
});

/* ── [B] 스레드 충돌: 웹↔앱 동시 편집 turn을 union 병합(양쪽 보존) ── */
test('통합: 스레드 양쪽 편집 충돌은 union 병합으로 양쪽 turn 보존', async () => {
  const wsId = 'comerge';
  const base = { sessionId: 's', messages: [{ who: 'user', text: 'hi', ts: 1 }, { who: 'crew', text: 'hello', ts: 2 }] };
  const localObj = { ...base, sessionId: 'sess-app', sessionDevice: 'dev-app', messages: [...base.messages, { who: 'user', text: '앱턴', ts: 5 }] };
  const remoteObj = { ...base, sessionId: 'sess-web', sessionDevice: 'dev-web', messages: [...base.messages, { who: 'user', text: '웹턴', ts: 4 }] };
  const baseBuf = Buffer.from(JSON.stringify(base));
  const localBuf = Buffer.from(JSON.stringify(localObj));
  const remoteBuf = Buffer.from(JSON.stringify(remoteObj));
  // base 대비 로컬·원격 둘 다 변경 → 충돌 → isThread union.
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'chats/team.json': localBuf },
    state: { 'chats/team.json': meta(baseBuf) },
    remoteFiles: { 'chats/team.json': meta(remoteBuf, 2000) }, // 원격이 더 최근
    remoteBlobs: { 'chats/team.json': remoteBuf },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.merged, 1, '충돌이 병합으로 처리됨');
  const localMerged = JSON.parse(await readFile(join(wsRoot, 'chats', 'team.json'), 'utf8'));
  const texts = localMerged.messages.map((m) => m.text);
  assert.ok(texts.includes('앱턴') && texts.includes('웹턴'), '로컬에 양쪽 turn 보존(LWW 유실 없음)');
  assert.deepEqual(localMerged.messages.map((m) => m.ts), [1, 2, 4, 5], 'ts 오름차순 정렬');
  // 세션 소유 짝 — sessionId를 제공한 쪽(primary=원격이 최근)의 sessionDevice가 함께 온다
  assert.equal(localMerged.sessionId, 'sess-app', '세션은 최근 편집(로컬 mtime=now > 원격 2000) 쪽으로 수렴');
  assert.equal(localMerged.sessionDevice, 'dev-app', 'sessionDevice가 sessionId와 같은 쪽에서 짝으로 병합');
  const remoteMerged = cloudJson(fake._store.get(`${OWNER}/${wsId}/chats/team.json`));
  assert.deepEqual(remoteMerged.messages.map((m) => m.text).sort(), ['hello', 'hi', '앱턴', '웹턴'].sort(), '원격도 병합본으로 수렴');
});

test.after(async () => { clearAccountKey(); await rm(ROOT, { recursive: true, force: true }); });

/* ── [T] 회사 tombstone — 보관이 동기화 복원에 지지 않는다 ── */

test('통합 T1: 보관한 회사는 tombstone push + 발견 제외 — 8초 부활 루프 차단', async () => {
  const wsId = 'tomb-core';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: { 'company.json': Buffer.from('{}') },
  });
  await archiveCompany(wsId);
  assert.ok(!existsSync(join(ROOT, wsId)), '로컬 회사는 .archive로 이동');
  assert.ok(existsSync(join(TOMBSTONE_DIR, `${wsId}.json`)), 'archiveCompany가 로컬 tombstone 기록');

  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(tombs.has(wsId), 'tombstone 집합에 포함');
  assert.ok(fake._store.has(`${OWNER}/.tombstones/${wsId}.json`), '원격 tombstone push됨');

  const found = await _tombstonesForTest.discoverRemote([OWNER]);
  assert.ok(found.some((f) => f.wsId === wsId), '원격 사본 자체는 여전히 발견됨(데이터 보존)');
  assert.ok(!found.some((f) => f.wsId === '.tombstones'), '.tombstones 폴더를 회사로 오인하지 않음');
  // cycle의 차단 지점: 발견됐어도 tombs에 있으면 복원 대상에서 제외된다
  assert.ok(tombs.has(wsId), 'cycle 게이트(tombs.has → continue) 성립');
});

test('통합 T2: 원격 tombstone → 이 기기의 로컬 사본을 보관 처리(삭제 전파)', async () => {
  const wsId = 'tomb-prop';
  const future = Date.now() + 60_000; // 삭제가 이 기기의 마지막 수정보다 나중
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId, at: future })));

  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(tombs.has(wsId), 'tombstone 집합에 포함');
  assert.ok(!existsSync(join(ROOT, wsId)), '로컬 사본이 보관 처리됨(전파)');
  assert.ok(existsSync(join(TOMBSTONE_DIR, `${wsId}.json`)), '로컬 tombstone 기록됨');
});

test('통합 T3: 보관 이후 수정된 회사는 파기가 아니라 tombstone 철회(부활 방지 가드)', async () => {
  const wsId = 'tomb-rev';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  // 과거 시각의 tombstone — 회사 company.json이 그보다 나중에 수정된 상황
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId, at: 1000 })));

  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(!tombs.has(wsId), '철회 — tombstone 집합에 없음');
  assert.ok(existsSync(join(ROOT, wsId, 'company.json')), '회사는 그대로 살아 있음');
  assert.ok(!fake._store.has(`${OWNER}/.tombstones/${wsId}.json`), '원격 tombstone 제거됨');
});

test('통합 T4(회귀): tombstone 없는 원격 회사는 여전히 발견된다 — 재설치 복원 보존', async () => {
  const wsId = 'tomb-fresh';
  const fake = fakeStorage({ [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from('{"files":{}}') });
  _setSyncClientForTest(fake);
  const found = await _tombstonesForTest.discoverRemote([OWNER]);
  assert.ok(found.some((f) => f.wsId === wsId), '복원 경로 회귀 없음');
});

test('통합 T5: 로컬 tombstone + 잔존 사본(픽스 전 좀비)은 보관 재적용', async () => {
  const wsId = 'tomb-zombie';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  // tombstone이 회사 수정보다 나중(미래) — 재적용 대상
  await mkdir(TOMBSTONE_DIR, { recursive: true });
  await writeFile(join(TOMBSTONE_DIR, `${wsId}.json`), JSON.stringify({ wsId, ownerId: OWNER, at: Date.now() + 60_000 }));
  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(tombs.has(wsId), 'tombstone 유지');
  assert.ok(!existsSync(join(ROOT, wsId)), '잔존 사본이 보관 재적용됨');
  assert.ok(fake._store.has(`${OWNER}/.tombstones/${wsId}.json`), '원격 push도 됨');
});

test('통합 T6: 로컬 tombstone보다 나중에 수정된 회사는 철회(로컬+원격)', async () => {
  const wsId = 'tomb-edit';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId, at: 1000 })));
  await mkdir(TOMBSTONE_DIR, { recursive: true });
  await writeFile(join(TOMBSTONE_DIR, `${wsId}.json`), JSON.stringify({ wsId, ownerId: OWNER, at: 1000 }));
  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(!tombs.has(wsId), '철회됨');
  assert.ok(existsSync(join(ROOT, wsId, 'company.json')), '회사 보존');
  assert.ok(!existsSync(join(TOMBSTONE_DIR, `${wsId}.json`)), '로컬 마커 제거');
  assert.ok(!fake._store.has(`${OWNER}/.tombstones/${wsId}.json`), '원격 마커 제거');
});

test('통합 T7: 오너 불일치 tombstone은 남의 회사를 보관하지 않는다(테넌트 격리)', async () => {
  const wsId = 'tomb-other';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: 'owner2' })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  // owner(o)의 tombstone인데 로컬 회사는 owner2 소유 — wsId 재순환 충돌 시나리오
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId, at: Date.now() + 60_000 })));
  await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(existsSync(join(ROOT, wsId, 'company.json')), 'owner2의 회사는 그대로');
  assert.ok(fake._store.has(`${OWNER}/.tombstones/${wsId}.json`), 'owner1 신호도 파괴하지 않음');
});

test('통합 T8: at 결측 tombstone은 철회가 아니라 적용(신호 보존)', async () => {
  const wsId = 'tomb-noat';
  const { fake } = await setup(wsId, {
    localFiles: { 'company.json': Buffer.from(JSON.stringify({ id: wsId, ownerId: OWNER })) },
    remoteFiles: {}, remoteBlobs: {},
  });
  fake._store.set(`${OWNER}/.tombstones/${wsId}.json`, Buffer.from(JSON.stringify({ wsId })));
  const tombs = await _tombstonesForTest.syncTombstones(OWNER);
  assert.ok(tombs.has(wsId), '결측 at도 유효한 보관 신호');
  assert.ok(!existsSync(join(ROOT, wsId)), '보관 전파됨');
});

/* ── [M] 매니페스트 경합 — 동시 동기화가 새 파일을 오삭제하지 않는다 ── */

test('통합 M1: 매니페스트 항목만 유실(blob 생존)이면 삭제 대신 항목 복원(자기치유)', async () => {
  const wsId = 'race-heal';
  const card = Buffer.from('---\nname: Shuri\n---\n# Shuri\n');
  // base와 로컬엔 카드가 있고(무변경), 원격 매니페스트엔 항목이 없다(다른 기기가 덮어씀).
  // 단 blob은 스토리지에 살아 있다 — 진짜 삭제라면 blob도 지워졌을 것.
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'agents/shuri.md': card },
    state: { 'agents/shuri.md': meta(card) },
    remoteFiles: {}, remoteBlobs: {},
  });
  fake._store.set(`${OWNER}/${wsId}/agents/shuri.md`, card); // blob 생존
  const r = await syncCompany(wsId, OWNER);

  assert.ok(existsSync(join(wsRoot, 'agents', 'shuri.md')), '로컬 카드 오삭제 안 됨');
  assert.equal(r.deletedL, 0, '로컬 삭제 0');
  assert.equal(r.healed, 1, '자기치유 1건');
  const man = cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`));
  assert.ok(man.files['agents/shuri.md'], '매니페스트 항목 복원됨');
});

test('통합 M2(회귀): 진짜 삭제(blob도 없음)는 여전히 로컬로 전파된다', async () => {
  const wsId = 'race-del';
  const card = Buffer.from('---\nname: Gone\n---\n');
  const { wsRoot } = await setup(wsId, {
    localFiles: { 'agents/gone.md': card },
    state: { 'agents/gone.md': meta(card) },
    remoteFiles: {}, remoteBlobs: {}, // 매니페스트에도 blob에도 없음 = 다른 기기가 삭제 완료
  });
  const r = await syncCompany(wsId, OWNER);
  assert.ok(!existsSync(join(wsRoot, 'agents', 'gone.md')), '진짜 삭제는 로컬 반영');
  assert.equal(r.deletedL, 1);
  assert.equal(r.healed ?? 0, 0);
});

test('통합 M3: 업로드 직전 재읽기 병합 — 다른 기기가 방금 올린 항목을 보존하고 base에는 안 넣는다', async () => {
  const wsId = 'race-merge';
  const mine = Buffer.from('mine');
  const theirs = Buffer.from('theirs');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/notes/mine.md': mine }, // 내 신규 → push될 것
    state: {}, remoteFiles: {}, remoteBlobs: {},
  });
  // 다른 기기가 diff 도중 올린 항목 시뮬 — 매니페스트 2번째 다운로드(업로드 직전 재읽기)부터 보인다
  const manifestKey = `${OWNER}/${wsId}/__manifest__.json`;
  const origDownload = fake.storage.from().download.bind(fake.storage.from());
  let manifestReads = 0;
  const bucket = fake.storage.from();
  const patched = {
    ...bucket,
    async download(key) {
      if (key === manifestKey) {
        manifestReads++;
        if (manifestReads >= 2) {
          fake._store.set(`${OWNER}/${wsId}/vault/notes/theirs.md`, theirs);
          const cur = cloudJson(fake._store.get(manifestKey));
          cur.files['vault/notes/theirs.md'] = { m: 2000, s: theirs.length, h: 'x'.repeat(16) };
          fake._store.set(manifestKey, Buffer.from(JSON.stringify(cur)));
        }
      }
      return origDownload(key);
    },
  };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  await syncCompany(wsId, OWNER);

  const man = cloudJson(fake._store.get(manifestKey));
  assert.ok(man.files['vault/notes/mine.md'], '내 신규 항목 업로드됨');
  assert.ok(man.files['vault/notes/theirs.md'], '다른 기기의 동시 추가 항목 보존됨(lost-update 방지)');
  const st = JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8'));
  assert.ok(!st.files['vault/notes/theirs.md'], '병합 항목은 내 base에 없음 — 다음 사이클에 원격 신규로 pull');
  assert.ok(st.files['vault/notes/mine.md'], '내 항목은 base에 있음');
});

test('통합 M4(치명 회귀 가드): blob 확인이 네트워크 에러(비404)면 삭제가 아니라 보류', async () => {
  const wsId = 'race-neterr';
  const card = Buffer.from('---\nname: Keep\n---\n');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'agents/keep.md': card },
    state: { 'agents/keep.md': meta(card) },
    remoteFiles: {}, remoteBlobs: {},
  });
  // blob 다운로드만 503으로 실패시키는 패치 — 404가 아니므로 "확인 불가"
  const bucket = fake.storage.from();
  const orig = bucket.download.bind(bucket);
  const patched = { ...bucket, async download(key) {
    if (key.endsWith('agents/keep.md')) return { data: null, error: { message: 'Service Unavailable', status: 503 } };
    return orig(key);
  } };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  const r = await syncCompany(wsId, OWNER);

  assert.ok(existsSync(join(wsRoot, 'agents', 'keep.md')), '확인 불가 시 로컬 파일 보존(보류)');
  assert.equal(r.deletedL, 0, '오삭제 0');
  assert.ok(r.failed >= 1, '보류로 집계 — 다음 사이클 재시도');
});

test('통합 M5(회귀 가드): 원격 blob 삭제 실패 시 매니페스트 항목 유지 — 부활 오판 차단', async () => {
  const wsId = 'race-rmfail';
  const buf = Buffer.from('bye');
  const { fake } = await setup(wsId, {
    localFiles: {}, // 내가 로컬에서 지움
    state: { 'vault/notes/bye.md': meta(buf) },
    remoteFiles: { 'vault/notes/bye.md': meta(buf) },
    remoteBlobs: { 'vault/notes/bye.md': buf },
  });
  const bucket = fake.storage.from();
  const patched = { ...bucket, async remove() { return { error: { message: 'boom 500' } }; } };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.deletedR, 0, '삭제 전파 안 됨(보류)');
  assert.ok(r.failed >= 1, '보류 집계');
  const man = cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`));
  assert.ok(man.files['vault/notes/bye.md'], '항목 유지 — blob만 살아남아 부활 오판되는 상태를 안 만든다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/vault/notes/bye.md`), 'blob도 그대로');
});

test('통합 M6: 재읽기 병합은 blob이 죽은 항목(남의 삭제 진행 중)을 되살리지 않는다', async () => {
  const wsId = 'race-deadmerge';
  const mine = Buffer.from('mine2');
  const { fake } = await setup(wsId, {
    localFiles: { 'vault/notes/mine2.md': mine },
    state: {}, remoteFiles: {}, remoteBlobs: {},
  });
  const manifestKey = `${OWNER}/${wsId}/__manifest__.json`;
  const bucket = fake.storage.from();
  const orig = bucket.download.bind(bucket);
  let manifestReads = 0;
  const patched = { ...bucket, async download(key) {
    if (key === manifestKey) {
      manifestReads++;
      if (manifestReads >= 2) { // 재읽기 시점: 매니페스트엔 항목이 있지만 blob은 이미 제거된 상태
        const cur = cloudJson(fake._store.get(manifestKey));
        cur.files['vault/notes/dead.md'] = { m: 2000, s: 4, h: 'y'.repeat(16) };
        fake._store.set(manifestKey, Buffer.from(JSON.stringify(cur)));
      }
    }
    return orig(key);
  } };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  await syncCompany(wsId, OWNER);

  const man = cloudJson(fake._store.get(manifestKey));
  assert.ok(man.files['vault/notes/mine2.md'], '내 항목은 업로드');
  assert.ok(!man.files['vault/notes/dead.md'], '죽은 blob 항목은 병합하지 않음(삭제 미전파 방지)');
});

/* ── [TG] 텔레그램 토큰 유일성 — 한 토큰은 전 표면·전 회사에서 한 곳만 ── */

test('통합 TG1: 토큰 교차 사용 검사 — 게이트웨이↔직통 봇↔타 회사 전부 차단, 자기 자리는 허용', async () => {
  const { updateConnection, updateAgentBot, findTelegramTokenUse } = await import('../src/connections.mjs');
  const mk = async (ws, conn) => {
    await mkdir(join(ROOT, ws), { recursive: true });
    await writeFile(join(ROOT, ws, 'company.json'), JSON.stringify({ id: ws }));
    await writeFile(join(ROOT, ws, 'connections.json'), JSON.stringify(conn));
  };
  await mk('tg-a', { telegram: { token: 'T-GW', enabled: true, agents: { shuri: { token: 'T-CREW' } } }, slack: {} });
  await mk('tg-b', { telegram: { token: '', agents: {} }, slack: {} });

  await assert.rejects(() => updateAgentBot('tg-a', 'pepper', { token: 'T-GW' }), /텔레그램 연결.*사용 중/, '직통에 게이트웨이 토큰 차단');
  await assert.rejects(() => updateConnection('tg-a', 'telegram', { token: 'T-CREW' }), /직통 봇\(shuri\)/, '게이트웨이에 직통 토큰 차단');
  await assert.rejects(() => updateConnection('tg-b', 'telegram', { token: 'T-GW' }), /회사: tg-a/, '타 회사 토큰 차단');
  await updateAgentBot('tg-a', 'shuri', { token: 'T-CREW-2' }); // 자기 토큰 교체 허용
  const use = await findTelegramTokenUse('T-CREW-2');
  assert.deepEqual({ wsId: use.wsId, where: use.where, slug: use.slug }, { wsId: 'tg-a', where: 'agent', slug: 'shuri' });
});

test('통합 TG2: 켜기 토글도 중복이면 명시적으로 거절(레거시 중복 안내)', async () => {
  const { updateConnection } = await import('../src/connections.mjs');
  // 레거시 중복 상태 시뮬 — 같은 토큰이 게이트웨이(꺼짐)와 직통 봇에 이미 들어가 있음
  await mkdir(join(ROOT, 'tg-c'), { recursive: true });
  await writeFile(join(ROOT, 'tg-c', 'company.json'), JSON.stringify({ id: 'tg-c' }));
  await writeFile(join(ROOT, 'tg-c', 'connections.json'), JSON.stringify({
    telegram: { token: 'T-DUP', enabled: false, agents: { shuri: { token: 'T-DUP' } } }, slack: {},
  }));
  await assert.rejects(() => updateConnection('tg-c', 'telegram', { enabled: true }), /직통 봇\(shuri\)/, '켜기 전에 충돌 안내');
});

/* ── [MCP] 호스트 MCP 가져오기 + 런타임 실행 게이트 ── */
test('통합 MCP1: 런타임 게이트 — 호스팅 모드는 미검증 command 차단·url 통과, 로컬은 전부 통과', async () => {
  const { safeMcpServersForRuntime, MCP_CATALOG } = await import('../src/market.mjs');
  const catCmd = `${MCP_CATALOG[0].def.command} ${(MCP_CATALOG[0].def.args ?? []).join(' ')}`.trim().split(' ');
  const servers = {
    evil: { command: 'node', args: ['/tmp/x.js'] },
    good: { command: catCmd[0], args: catCmd.slice(1) },
    remote: { type: 'http', url: 'https://x.com/mcp' },
  };
  const prev = process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake'; // arbitraryMcpBlocked=true
  try {
    const hosted = safeMcpServersForRuntime(servers);
    assert.ok(!hosted.evil, '미검증 command 차단');
    assert.ok(hosted.good, '카탈로그 command 허용');
    assert.ok(hosted.remote, 'url 원격 허용(로컬 spawn 없음)');
  } finally { if (prev === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = prev; }
  const local = safeMcpServersForRuntime(servers); // 로컬(서비스 키 없음)
  assert.equal(Object.keys(local).length, 3, '로컬은 전부 통과');
});

test('통합 MCP2: 호스트 가져오기 — env 포함 복사, 이름 정규화, 목록은 env 값 미노출', async () => {
  const { listHostMcp, importHostMcp, loadMcp } = await import('../src/market.mjs');
  const home = join(ROOT, 'fakehome-mcp');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, '.claude.json'), JSON.stringify({ mcpServers: {
    'notion-agent': { command: 'node', args: ['/x.js'], env: { NOTION_TOKEN: 'secret-xyz' } },
  } }));
  const prevHome = process.env.HOME; const prevProfile = process.env.USERPROFILE;
  process.env.HOME = process.env.USERPROFILE = home; // win homedir()=USERPROFILE — 둘 다 심어야 격리
  try {
    const list = await listHostMcp();
    assert.ok(!JSON.stringify(list).includes('secret-xyz'), '목록에 env 값 미노출');
    await mkdir(join(ROOT, 'mcp-imp'), { recursive: true });
    await writeFile(join(ROOT, 'mcp-imp', 'company.json'), JSON.stringify({ id: 'mcp-imp' }));
    const r = await importHostMcp('mcp-imp', 'notion-agent');
    assert.equal(r.name, 'notion-agent');
    const cfg = await loadMcp('mcp-imp');
    assert.equal(cfg.servers['notion-agent'].env.NOTION_TOKEN, 'secret-xyz', 'env 토큰 복사됨');
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
  }
});

/* ── [GW] EXCLUDE 전환: 픽스 전 동기화된 큐 잔재가 많아도 브레이크 오탐 없이 원격만 청소 ── */
test('통합 GW1: 큐 잔재 대량(base 8개↑)도 mass-delete 브레이크를 발화시키지 않고 원격 정리', async () => {
  const wsId = 'gwtrans';
  const doc = Buffer.from('# 회사 노트\n');
  const qbuf = Buffer.from('{"text":"잔재","dev":"old-device"}');
  const localFiles = { 'vault/a.md': doc };
  const state = { 'vault/a.md': meta(doc) };
  const remoteFiles = { 'vault/a.md': meta(doc) };
  const remoteBlobs = { 'vault/a.md': doc };
  // 픽스 전 상태 재현: 큐 잡 9개가 로컬·base·원격에 모두 복제돼 있었다(q9만 타기기가 선정리해 원격 부재).
  for (let i = 1; i <= 9; i++) {
    const rel = `.gw-queue-telegram/${i}00.json`;
    localFiles[rel] = qbuf;
    state[rel] = meta(qbuf);
    if (i !== 9) { remoteFiles[rel] = meta(qbuf); remoteBlobs[rel] = qbuf; }
  }
  const { wsRoot, fake } = await setup(wsId, { localFiles, state, remoteFiles, remoteBlobs });
  // baseCount 10 · 원격 삭제 예정 8 = 임계(max(8, ceil(10*0.5)))와 동값 — 집계 제외가 없으면 브레이크가 발화한다
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.failed, 0, 'state에만 남은 큐 항목(q9)이 TypeError로 새지 않는다');
  assert.equal(r.deletedR, 8, '원격 큐 잔재 8개가 정리된다(브레이크 미발화)');
  const qKeys = [...fake._store.keys()].filter((k) => k.includes('.gw-queue'));
  assert.equal(qKeys.length, 0, '원격 스토리지에 큐 blob이 남지 않는다');
  const manifest = cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`));
  assert.ok(!Object.keys(manifest.files).some((k) => k.includes('.gw-queue')), '매니페스트에서도 큐 키 제거');
  assert.ok(manifest.files['vault/a.md'], '회사 데이터는 매니페스트에 유지');
  assert.ok(existsSync(join(wsRoot, 'vault', 'a.md')), '로컬 회사 데이터 무사');
  assert.ok(existsSync(join(wsRoot, '.gw-queue-telegram', '100.json')), '로컬 큐 파일은 동기화가 건드리지 않는다(정리는 드레이너 몫)');
});

/* ── [RS] 회의록 충돌 크루 카드(세척 후 slug 'room-main')는 diff 불가시 — 받지도·밀지도·지우지도 않는다(#393 LOW-6 반입 문) ── */
test('통합 RS1: 원격 room-main·별칭 카드는 안 내려오고 원격도 그대로, 로컬 잔존 충돌 카드는 안 밀린다 — room-service·pepper는 종전대로', async () => {
  const wsId = 'reserved';
  const card = (n) => Buffer.from(`---\nname: ${n}\nrole: r\n---\n\n# ${n}\n`);
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'agents/room-main.md': card('옛 기기 잔존'), 'agents/room-x.md': card('접두만 겹침') }, // 이 기기의 옛 버전이 만든 카드
    remoteFiles: { 'agents/Zroom-main.md': meta(card('별칭')), 'agents/room-service.md': meta(card('Room Service')), 'agents/pepper.md': meta(card('Pepper')) },
    remoteBlobs: { 'agents/Zroom-main.md': card('별칭'), 'agents/room-service.md': card('Room Service'), 'agents/pepper.md': card('Pepper') },
  });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0);
  assert.ok(existsSync(join(wsRoot, 'agents', 'pepper.md')), '대조군 — 일반 카드는 종전대로 내려온다');
  assert.ok(existsSync(join(wsRoot, 'agents', 'room-service.md')), '접두만 겹치는 정상 크루는 종전대로 동기화된다(검수 MEDIUM-1 — 조용한 동기화 중단 금지)');
  assert.ok(!existsSync(join(wsRoot, 'agents', 'Zroom-main.md')), '별칭 카드는 받지 않는다 — 받으면 그 크루 스레드가 chats/room-main.json(회의록)이 된다(검수 MEDIUM-2)');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/agents/Zroom-main.md`), '원격 blob은 그대로 — 옛 기기의 크루를 지우지 않는다(EXCLUDE 전환식 청소 금지)');
  assert.equal(r.deletedR, 0);
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/agents/room-main.md`), '로컬 잔존 충돌 카드는 밀지 않는다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/agents/room-x.md`), '접두만 겹치는 로컬 카드는 종전대로 밀린다');
  const manifest = cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`));
  assert.ok(manifest.files['agents/Zroom-main.md'], '매니페스트 항목도 유지');
  assert.ok(!manifest.files['agents/room-main.md']);
  // 두 번째 사이클(base에 원격 충돌 항목이 남은 상태) — 여기서 '로컬 삭제'로 읽혀 원격이 지워지는 게 EXCLUDE 방식의 결함이었다
  const realNow = Date.now; Date.now = () => realNow() + 61_000;
  let r2;
  try { r2 = await syncCompany(wsId, OWNER); } finally { Date.now = realNow; }
  assert.notEqual(r2.skipped, 'idle-probe', '보존 검사는 실제 원격 probe를 실행한다');
  assert.equal(r2.deletedR, 0, '2사이클에도 원격 삭제 0');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/agents/Zroom-main.md`));
  assert.ok(!existsSync(join(wsRoot, 'agents', 'Zroom-main.md')));
});

/* ── [DA] 개발 산출물 디렉터리(node_modules·.git류·크롬 프로필)는 walk가 안 내려가고, diff도 불가시(pull·삭제 전파 스킵) ──
   라이브 실측(2026-09-14): companies 버킷 25GB 중 약 7GB가 이런 디렉터리였고 8초 사이클마다 전부 읽고 해시했다. */
test('통합 DA1: 로컬 개발 산출물(node_modules·크롬 프로필·venv)은 walk에서 제외돼 원격에 밀리지 않는다', async () => {
  const wsId = 'devart-push';
  const { fake } = await setup(wsId, {
    localFiles: {
      'node_modules/x.js': Buffer.from('module.exports = 1;'),
      'chrome_profile_1/Cookies': Buffer.from('sqlite-binary-stub'),
      '.venv/lib/a.py': Buffer.from('# venv file'),
      'notes/keep.md': Buffer.from('# 대조군 — 일반 파일은 종전대로 밀린다'),
    },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.pushed, 1, '개발 산출물 3종은 밀지 않고, 대조군 1개만 밀린다');
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/node_modules/x.js`), 'node_modules는 원격에 올라가지 않는다');
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/chrome_profile_1/Cookies`), '크롬 프로필은 원격에 올라가지 않는다');
  assert.ok(!fake._store.has(`${OWNER}/${wsId}/.venv/lib/a.py`), '가상환경은 원격에 올라가지 않는다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/notes/keep.md`), '대조군 일반 파일은 종전대로 동기화된다');
});

test('통합 DA2: 원격에만 있는 개발 산출물은 받지도 않고 삭제 전파도 하지 않는다', async () => {
  const wsId = 'devart-pull';
  const buf = Buffer.from('module.exports = 2;');
  const { wsRoot, fake } = await setup(wsId, {
    // base 없음 = 통상 판정이면 '원격 신규 → 받기'가 되어야 할 상황(가드가 없으면 반드시 pull됨을 증명).
    remoteFiles: { 'node_modules/y.js': meta(buf) },
    remoteBlobs: { 'node_modules/y.js': buf },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.pulled, 0, '개발 산출물은 diff 자체에서 불가시라 받지 않는다');
  assert.equal(r.deletedR, 0, '원격 삭제 전파도 없다');
  assert.ok(!existsSync(join(wsRoot, 'node_modules', 'y.js')), '로컬에 새로 생기지 않는다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/node_modules/y.js`), '원격 blob은 그대로 보존된다');
});

test('통합 DA3: build 디렉터리는 개발 산출물 제외 대상이 아니라 종전대로 동기화된다(사용자 폴더 이름과 겹칠 수 있어 후보에서 제외)', async () => {
  const wsId = 'devart-build-control';
  const { fake } = await setup(wsId, {
    localFiles: { 'docs/build/notes.md': Buffer.from('# build는 제외 목록에 없다') },
  });
  const r = await syncCompany(wsId, OWNER);

  assert.equal(r.pushed, 1, 'build 세그먼트를 포함한 파일도 정상적으로 밀린다');
  assert.ok(fake._store.has(`${OWNER}/${wsId}/docs/build/notes.md`), '원격에 정상 업로드된다');
});

/* ─── 목록 조회 비용 계약 (프로덕션 실측 2026-07-26: Supabase CPU 80% 경보) ───
   Storage list()는 서버에서 storage.search()로 실행되고, 그 하나가 DB CPU의 98.3%를 먹고 있었다
   (107만 회 · 평균 177ms). 기기마다 8초 사이클에 목록 2회(발견 + tombstone)를 부르니 부하가
   동시 접속 기기 수에 선형으로 붙었다 — 12대에서 175회/분(코어 절반). 파일 push/pull은 준실시간을
   유지하되 목록 조회만 DISCOVER_MS 주기로 분리했다. 아래는 그 분리를 잠그는 가드다. */
test('원격 미조회 사이클: tombstone이 목록을 호출하지 않고 로컬 집합은 그대로 낸다', async () => {
  const wsId = 'listcost';
  await rm(TOMBSTONE_DIR, { recursive: true, force: true }).catch(() => {});
  const { fake } = await setup(wsId, { localFiles: { 'company.json': Buffer.from(JSON.stringify({ ownerId: OWNER })) } });
  _setSyncClientForTest(fake);
  await archiveCompany(wsId);                       // 로컬 tombstone 1건 생성
  const before = fake.storage.from()._listCalls;

  const local = await _tombstonesForTest.syncTombstones(OWNER, { remote: false });
  assert.equal(fake.storage.from()._listCalls, before, '원격 미조회 사이클인데 list를 호출했다 — 부하 분리가 깨졌다');
  assert.ok(local.has(wsId), '로컬 tombstone 집합은 그대로 나와야 한다(보관 회사 복원 차단이 유지된다)');

  const full = await _tombstonesForTest.syncTombstones(OWNER);   // 기본값 = 원격 조회
  assert.ok(fake.storage.from()._listCalls > before, '원격 조회 사이클은 list를 호출해야 한다');
  assert.ok(full.has(wsId), '원격 조회 사이클도 같은 로컬 집합을 낸다');
});

test('목록 조회 주기 판정: 첫 사이클은 항상, 그다음은 간격을 채워야 한다', () => {
  const T = 60_000;
  assert.equal(isDiscoverDue(1_000_000, undefined, T), true, '첫 사이클(기록 없음)을 건너뛰면 신규 기기가 자기 회사를 못 찾는다');
  assert.equal(isDiscoverDue(1_000_000, 0, T), true, '0도 기록 없음으로 본다');
  assert.equal(isDiscoverDue(1_000_000, 1_000_000 - T + 1, T), false, '간격 미달이면 건너뛴다 — 이게 부하 절감의 전부다');
  assert.equal(isDiscoverDue(1_000_000, 1_000_000 - T, T), true, '간격을 정확히 채우면 조회한다');
});

/* ─── CDN 옛 사본 · 객체 없는 매니페스트 항목 (라이브 실측 2026-09-26~10-05, lean-ax-wqou "동기화 파일 4건 실패") ───
   Supabase Storage는 인증 다운로드도 CDN에 캐시한다(cf_cache_status=HIT). 09-26 03:05:20Z에 html을 지우고 그 항목을 뺀 매니페스트를
   올렸는데 10초 뒤 다음 주기의 GET이 HIT로 이전 판을 받았다 → html이 '원격 신규'로 보여 받으려다 Object not found → 실패가 있으면
   매니페스트를 다시 올리는 규칙이 그 항목을 운영 매니페스트에 영구히 되살렸다. 그 뒤 이 항목이 없는 모든 기기가 매 주기 같은 4건에서 실패했다. */
/** CDN 모사 — cacheNonce 없는 다운로드는 처음 받은 사본을 계속 돌려준다(덮어쓴 직후의 HIT). noNonce = 캐시를 건너뛰지 않은 키. */
function withCdn(fake) {
  const bucket = fake.storage.from(), origin = bucket.download.bind(bucket);
  const cache = new Map(), noNonce = [];
  bucket.download = async (key, opts) => {
    if (opts?.cacheNonce != null) return origin(key);
    noNonce.push(key);
    if (!cache.has(key)) { const r = await origin(key); if (r.error) return r; cache.set(key, r); }
    return cache.get(key);
  };
  return { noNonce };
}

test('CDN이 옛 매니페스트를 돌려줘도 방금 지운 파일이 매니페스트에 되살아나지 않는다(09-26 재현)', async () => {
  const wsId = 'cdn-resurrect';
  const x = Buffer.from('<html>intermediate</html>'), k = Buffer.from('keep v1');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/x.html': x, 'vault/keep.md': k },
    state: { 'vault/x.html': meta(x), 'vault/keep.md': meta(k) },
    remoteFiles: { 'vault/x.html': meta(x), 'vault/keep.md': meta(k) },
    remoteBlobs: { 'vault/x.html': x, 'vault/keep.md': k },
  });
  const cdn = withCdn(fake);
  await syncCompany(wsId, OWNER);                                  // 매니페스트가 CDN에 실린다
  await rm(join(wsRoot, 'vault', 'x.html'));                        // PDF를 만든 뒤 중간 파일을 지운다
  assert.equal((await syncCompany(wsId, OWNER)).deletedR, 1, '객체를 지우고 항목을 뺀 매니페스트를 올린다');
  await writeFile(join(wsRoot, 'vault', 'keep.md'), 'keep v2');     // 크루가 계속 일한다 → 다음 주기도 전체 동기화
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0, '지운 파일을 원격 신규로 읽어 받으려다 실패하지 않는다');
  const files = cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`)).files;
  assert.equal('vault/x.html' in files, false, '지운 항목이 운영 매니페스트에 되살아나지 않는다');
  assert.deepEqual(cdn.noNonce, [], '동기화가 읽는 객체는 전부 CDN 사본을 건너뛴다(cacheNonce)');
});

test('객체 없는 매니페스트 항목은 실패가 아니라 건너뜀 — 항목은 남기고, 확인한 항목은 1시간 동안 다시 받지 않는다', async () => {
  const wsId = 'dangling';
  const k = Buffer.from('keep'), gone = 'vault/journal/2026-09-03-pepper.md';
  const { fake } = await setup(wsId, {
    localFiles: { 'vault/keep.md': k }, state: { 'vault/keep.md': meta(k) },
    remoteFiles: { 'vault/keep.md': meta(k), [gone]: meta(Buffer.from('archived elsewhere')) },
    remoteBlobs: { 'vault/keep.md': k },
  });
  const bucket = fake.storage.from(), download = bucket.download.bind(bucket), upload = bucket.upload.bind(bucket);
  let gets = 0, writes = 0;
  bucket.download = async (key, opts) => { if (key.endsWith(gone)) gets++; return download(key, opts); };
  bucket.upload = async (...a) => { writes++; return upload(...a); };
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    const r = await syncCompany(wsId, OWNER);
    assert.equal(r.failed, 0, '받을 내용이 없는 항목은 실패가 아니다 — 재시도 대기·lastError로 회사 전체를 묶지 않는다');
    assert.equal(r.missing, 1);
    assert.deepEqual(r.missingRels, [gone]);
    assert.ok(gone in cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`)).files,
      '항목은 지우지 않는다 — 그 파일을 가진 기기가 "다른 기기가 지웠다"로 읽어 로컬 사본을 지우게 된다(09-15 정리가 매니페스트를 남긴 이유)');
    writes = 0; now += 61_000;                                      // 유휴 확인을 넘겨 다음 전체 주기
    const r2 = await syncCompany(wsId, OWNER);
    assert.equal(r2.failed, 0); assert.equal(r2.missing, 1);
    assert.equal(gets, 1, '같은 빈 항목을 매 주기 다시 받으러 가지 않는다');
    assert.equal(writes, 0, '빈 항목 때문에 매니페스트를 다시 쓰지 않는다');
    now += 60 * 60_000 + 1;                                         // 1시간 뒤에는 다시 확인(다른 기기가 객체를 되살렸을 수 있다)
    await syncCompany(wsId, OWNER);
    assert.equal(gets, 2);
  } finally { Date.now = realNow; }
});

test('객체 없는 항목을 가진 기기: 받을 게 없으면 로컬을 그대로 두고 편집본도 밀지 않는다 — 항목이 내 base 그대로일 때만 밀어 복구(분리 검수 2차 HIGH-1)', async () => {
  const wsId = 'dangling-holder';
  const v1 = Buffer.from('v1'), ghost = Buffer.from('ghost meta');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/same.md': v1, 'vault/edited.md': Buffer.from('my edit'), 'vault/kept.md': v1, 'vault/repair.md': Buffer.from('fixed') },
    state: { 'vault/same.md': meta(v1), 'vault/edited.md': meta(v1), 'vault/kept.md': meta(v1), 'vault/repair.md': meta(v1) },
    // same·edited: 항목이 내 base보다 새로운데 객체가 없다(다른 기기가 올린 판이 유실). kept·repair: 항목이 내 base 그대로, 객체만 없다.
    remoteFiles: { 'vault/same.md': meta(ghost, 2000), 'vault/edited.md': meta(ghost, 2000), 'vault/kept.md': meta(v1), 'vault/repair.md': meta(v1) },
  });
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 0);
  assert.equal(r.deletedL, 0, '객체가 없어도 로컬 사본을 지우지 않는다');
  assert.equal(r.missing, 2);
  assert.equal(await readFile(join(wsRoot, 'vault', 'same.md'), 'utf8'), 'v1', '받을 게 없으면 로컬을 덮지 않는다');
  assert.equal(await readFile(join(wsRoot, 'vault', 'edited.md'), 'utf8'), 'my edit', '편집본은 로컬에 그대로 남는다');
  assert.equal(fake._store.has(`${OWNER}/${wsId}/vault/edited.md`), false,
    '항목이 내 base보다 새롭다 = 더 새 판을 가진 기기가 있을 수 있다 — 내 편집본으로 덮으면 그 기기가 받아서 자기 최신본을 잃는다');
  assert.equal(await readFile(join(wsRoot, 'vault', 'kept.md'), 'utf8'), 'v1', '변경 없는 보유 기기는 종전대로 손대지 않는다');
  assert.equal(r.pushed, 1);
  assert.equal(openSecretCompat(fake._store.get(`${OWNER}/${wsId}/vault/repair.md`)).toString(), 'fixed',
    '항목이 내 base 그대로면 기록된 새 판이 없다 — 종전 "로컬만 변경 → 밀기"가 객체를 되살린다');
});

test('파일 실패는 이름과 사유를 남기고, 재시도 대기 중에도 그대로 보인다', async () => {
  const wsId = 'fail-visible';
  const buf = Buffer.from('remote');
  const { fake } = await setup(wsId, { remoteFiles: { 'vault/a.md': meta(buf) }, remoteBlobs: { 'vault/a.md': buf } });
  const bucket = fake.storage.from(), download = bucket.download.bind(bucket);
  bucket.download = async (key, opts) => (key.endsWith('a.md') ? { error: { status: 403, message: 'permission denied' } } : download(key, opts));
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failures, [{ rel: 'vault/a.md', reason: 'permission denied' }]);
  assert.equal(syncFailedMessage(wsId, r), 'fail-visible: 동기화 파일 1건 실패 (vault/a.md: permission denied) — 잠시 후 재시도');
  assert.equal(syncFailedMessage(wsId, { failed: 4, failures: r.failures }), 'fail-visible: 동기화 파일 4건 실패 (vault/a.md: permission denied 외 3건) — 잠시 후 재시도');
  const again = await syncCompany(wsId, OWNER);
  assert.equal(again.skipped, 'retry-backoff');
  assert.deepEqual(again.failures, r.failures, '재시도 대기 중에도 마지막 실패 목록이 상태에 남는다');
});

// 격리 서버 실측(10/5): 로컬 쓰기 실패 사유에 원자 쓰기 임시 파일 이름(.tmp-<파일>-<pid>-<시각>-<순번>)이 들어가 재시도마다 사유가 달라졌고,
// '목록이 바뀔 때만 한 줄'인 로그가 재시도마다 새 줄을 썼다.
test('로컬 쓰기 실패 사유는 재시도해도 같다 — 임시 파일 꼬리를 떼어 로그는 한 줄만 남는다', async () => {
  const wsId = 'fail-stable';
  const buf = Buffer.from('remote');
  const { wsRoot } = await setup(wsId, { remoteFiles: { 'vault/blocked.md': meta(buf) }, remoteBlobs: { 'vault/blocked.md': buf } });
  await mkdir(join(wsRoot, 'vault', 'blocked.md'), { recursive: true }); // 받을 자리에 폴더 → 원자 쓰기의 rename 실패
  const warn = console.warn, lines = [], realNow = Date.now;
  console.warn = (line) => { lines.push(String(line)); };
  try {
    const r1 = await syncCompany(wsId, OWNER);
    Date.now = () => realNow() + 31_000; // 첫 재시도 대기(30초)를 지나 실제로 한 번 더 돈다
    const r2 = await syncCompany(wsId, OWNER);
    assert.equal(r1.failed, 1); assert.equal(r2.failed, 1);
    assert.doesNotMatch(r1.failures[0].reason, /\.tmp-blocked\.md-\d/, '사유에 pid·시각 꼬리가 남지 않는다');
    assert.equal(r2.failures[0].reason, r1.failures[0].reason, '같은 실패는 주기마다 같은 사유');
  } finally { Date.now = realNow; console.warn = warn; }
  assert.equal(lines.filter((l) => l.includes(`동기화(${wsId}): 파일 1건 실패`)).length, 1, '같은 실패는 로그 한 줄');
});

test('빈 항목 기억이 있어도 다른 기기가 객체를 먼저 올린 자리를 덮지 않고, 그 기기의 매니페스트가 오면 충돌 사본으로 수렴한다(분리 검수 MEDIUM-1·2차 HIGH-1)', async () => {
  const wsId = 'dangling-race';
  const v1 = Buffer.from('v1'), ghost = Buffer.from('ghost meta'), z = Buffer.from('Z from device B');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/n.md': v1 }, state: { 'vault/n.md': meta(v1) },
    remoteFiles: { 'vault/n.md': meta(ghost, 2000) },                 // 객체 없는 항목(메타만 다름)
  });
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    assert.equal((await syncCompany(wsId, OWNER)).missing, 1);         // 1주기: 빈 항목으로 기억
    fake._store.set(`${OWNER}/${wsId}/vault/n.md`, z);                  // 기기 B가 객체를 먼저 올림(매니페스트는 아직)
    await writeFile(join(wsRoot, 'vault', 'n.md'), 'v2 my edit');      // 이 기기도 같은 파일을 고침
    const r = await syncCompany(wsId, OWNER);
    assert.equal(r.pushed, 0, '객체 없음으로 본 자리는 어느 분기에서도 밀지 않는다');
    assert.equal(openSecretCompat(fake._store.get(`${OWNER}/${wsId}/vault/n.md`)).toString(), 'Z from device B', '기기 B의 객체를 덮지 않는다');
    assert.equal(await readFile(join(wsRoot, 'vault', 'n.md'), 'utf8'), 'v2 my edit', '이 기기 편집본은 로컬에 그대로');
    const mk = `${OWNER}/${wsId}/__manifest__.json`, man = cloudJson(fake._store.get(mk));
    man.files['vault/n.md'] = meta(z, 3000); fake._store.set(mk, Buffer.from(JSON.stringify(man))); // 기기 B의 매니페스트 도착
    now += 61_000;                                                      // 유휴 확인을 넘겨 다음 전체 주기
    const r2 = await syncCompany(wsId, OWNER);
    assert.equal(r2.conflicts, 1, '메타가 바뀌면 기억과 상관없이 바로 받아 종전 충돌 처리로');
    assert.equal(await readFile(join(wsRoot, 'vault', 'n.md'), 'utf8'), 'Z from device B');
    const copy = (await readdir(join(wsRoot, 'vault'))).find((n) => n.startsWith('n.conflict-'));
    assert.ok(copy, '이 기기 편집본은 충돌 사본으로 남는다');
    assert.equal(await readFile(join(wsRoot, 'vault', copy), 'utf8'), 'v2 my edit');
  } finally { Date.now = realNow; }
});

test('CDN에 남은 옛 객체(200)로 다른 기기의 삭제를 되돌리지 않는다 — blob 실존 검사도 원본을 본다(분리 검수 MEDIUM-2)', async () => {
  const wsId = 'cdn-heal';
  const y = Buffer.from('deleted on another device'), k = Buffer.from('keep');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/y.md': y, 'vault/keep.md': k },
    state: { 'vault/y.md': meta(y), 'vault/keep.md': meta(k) },
    remoteFiles: { 'vault/keep.md': meta(k) },                        // 다른 기기가 y를 지우고 항목을 뺐다
    remoteBlobs: { 'vault/y.md': y, 'vault/keep.md': k },
  });
  const cdn = withCdn(fake);
  await fake.storage.from().download(`${OWNER}/${wsId}/vault/y.md`); // 예전에 누가 받아 CDN에 실린 사본
  fake._store.delete(`${OWNER}/${wsId}/vault/y.md`);                 // 그 뒤 객체가 지워졌다
  cdn.noNonce.length = 0;
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.healed, 0, 'CDN의 옛 200을 "항목만 유실"로 읽어 되살리지 않는다');
  assert.equal(r.deletedL, 1, '다른 기기의 삭제가 이 기기에도 전파된다');
  assert.equal(existsSync(join(wsRoot, 'vault', 'y.md')), false);
  assert.equal('vault/y.md' in cloudJson(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`)).files, false);
  assert.deepEqual(cdn.noNonce, []);
});

test('CDN에 남은 옛 내용으로 원격 변경을 받지 않는다 — 파일 받기도 원본을 본다(분리 검수 MEDIUM-2)', async () => {
  const wsId = 'cdn-pull';
  const v1 = Buffer.from('v1'), v2 = Buffer.from('v2 from other device');
  const { wsRoot, fake } = await setup(wsId, {
    localFiles: { 'vault/z.md': v1 }, state: { 'vault/z.md': meta(v1) },
    remoteFiles: { 'vault/z.md': meta(v2, 2000) }, remoteBlobs: { 'vault/z.md': v1 },
  });
  const cdn = withCdn(fake);
  await fake.storage.from().download(`${OWNER}/${wsId}/vault/z.md`); // v1 사본이 CDN에 실림
  fake._store.set(`${OWNER}/${wsId}/vault/z.md`, v2);                // 다른 기기가 v2로 덮음
  cdn.noNonce.length = 0;
  const r = await syncCompany(wsId, OWNER);
  assert.equal(r.pulled, 1);
  assert.equal(await readFile(join(wsRoot, 'vault', 'z.md'), 'utf8'), 'v2 from other device', '옛 사본을 새 메타로 기록하지 않는다');
  assert.deepEqual(cdn.noNonce, []);
});

test('한 회사 화면용 상태: 다른 회사 결과는 빼고 오류는 자기 회사 몫을 보인다 — 여러 회사가 함께 실패해도 각자 카드에 남는다(분리 검수 LOW-1·2차 MEDIUM-1·보안 검토)', () => {
  // 회사 가드(guardCompany)는 그 회사만 본다 — 같은 기기의 게스트(주인 없는 회사)나 다른 계정이 자기 회사 화면을 열어도
  // 이 계정 회사의 실패·빈 항목 파일 경로가 보이면 안 된다. lastError는 기기 전체에 하나라 회사 오류는 회사 상태(error)에 따로 둔다.
  const st = globalThis.__argoSyncStatus; const saved = { lastError: st.lastError, companies: st.companies };
  try {
    st.companies = {
      a: { failed: 1, failures: [{ rel: 'vault/비공개-계획.md', reason: 'x' }], error: 'a: 동기화 파일 1건 실패 (vault/비공개-계획.md: x) — 잠시 후 재시도' },
      b: { skipped: 'retry-backoff', error: 'b: 동기화 파일 1건 실패 (vault/b.md: y) — 잠시 후 재시도' },
      c: { failed: 0 },
    };
    st.lastError = st.companies.b.error;                               // 기기 전체에 하나 — 루프에서 마지막으로 실패한 회사
    assert.equal(syncStatusFor('a').lastError, st.companies.a.error, '마지막이 아닌 실패 회사 카드에도 자기 오류가 보인다');
    assert.equal(syncStatusFor('b').lastError, st.companies.b.error, '재시도 대기 중인 회사도 자기 오류가 보인다');
    assert.equal(syncStatusFor('c').lastError, '', '성공한 회사 화면에는 다른 회사 몫 오류(파일 경로 포함)를 싣지 않는다');
    assert.deepEqual(Object.keys(syncStatusFor('a').companies), ['a']);
    assert.deepEqual(syncStatusFor('guest-local').companies, {}, '동기화 기록이 없는 회사는 빈 목록');
    assert.equal(syncStatusFor('guest-local').lastError, '');
    st.lastError = '동기화 자격 없음/만료 — 재로그인 필요';              // 기기 전체 오류(회사 접두 없음)
    assert.equal(syncStatusFor('a').lastError, st.lastError, '기기 전체 오류가 먼저 보인다');
    assert.equal(syncStatusFor('c').lastError, st.lastError);
  } finally { st.lastError = saved.lastError; st.companies = saved.companies; }
});
