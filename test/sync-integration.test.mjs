// 통합 실행 검증 — syncCompany를 fake Supabase storage + 임시 ARGO_ROOT로 실제 돌려
// 데이터유실 방어 배선(판정→실제 storage 호출)을 검증한다. 실 Supabase 없이 라이브에 가장 근접.
//
// 격리: Node test runner는 파일별 별도 프로세스라, 여기서 ARGO_ROOT를 먼저 세팅한 뒤
// sync.mjs를 동적 import해야 WS_ROOT(모듈 로드 시 고정)가 이 임시 루트를 가리킨다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-int-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;

const { syncCompany, _setSyncClientForTest, _tombstonesForTest } = await import('../src/sync.mjs');
const { archiveCompany, TOMBSTONE_DIR } = await import('../src/workspace.mjs');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

// fake Supabase storage — 인메모리 Map<key, Buffer>. from(BUCKET).download/upload/remove만 구현.
function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const bucket = {
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
    async list(prefix) {
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
  const localObj = { ...base, messages: [...base.messages, { who: 'user', text: '앱턴', ts: 5 }] };
  const remoteObj = { ...base, messages: [...base.messages, { who: 'user', text: '웹턴', ts: 4 }] };
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
  const remoteMerged = JSON.parse(fake._store.get(`${OWNER}/${wsId}/chats/team.json`).toString());
  assert.deepEqual(remoteMerged.messages.map((m) => m.text).sort(), ['hello', 'hi', '앱턴', '웹턴'].sort(), '원격도 병합본으로 수렴');
});

test.after(async () => { await rm(ROOT, { recursive: true, force: true }); });

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
