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
  const man = JSON.parse(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`).toString());
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
          const cur = JSON.parse(fake._store.get(manifestKey).toString());
          cur.files['vault/notes/theirs.md'] = { m: 2000, s: theirs.length, h: 'x'.repeat(16) };
          fake._store.set(manifestKey, Buffer.from(JSON.stringify(cur)));
        }
      }
      return origDownload(key);
    },
  };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  await syncCompany(wsId, OWNER);

  const man = JSON.parse(fake._store.get(manifestKey).toString());
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
  const man = JSON.parse(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`).toString());
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
        const cur = JSON.parse(fake._store.get(manifestKey).toString());
        cur.files['vault/notes/dead.md'] = { m: 2000, s: 4, h: 'y'.repeat(16) };
        fake._store.set(manifestKey, Buffer.from(JSON.stringify(cur)));
      }
    }
    return orig(key);
  } };
  _setSyncClientForTest({ ...fake, storage: { from: () => patched } });
  await syncCompany(wsId, OWNER);

  const man = JSON.parse(fake._store.get(manifestKey).toString());
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
  const prevHome = process.env.HOME; process.env.HOME = home;
  try {
    const list = await listHostMcp();
    assert.ok(!JSON.stringify(list).includes('secret-xyz'), '목록에 env 값 미노출');
    await mkdir(join(ROOT, 'mcp-imp'), { recursive: true });
    await writeFile(join(ROOT, 'mcp-imp', 'company.json'), JSON.stringify({ id: 'mcp-imp' }));
    const r = await importHostMcp('mcp-imp', 'notion-agent');
    assert.equal(r.name, 'notion-agent');
    const cfg = await loadMcp('mcp-imp');
    assert.equal(cfg.servers['notion-agent'].env.NOTION_TOKEN, 'secret-xyz', 'env 토큰 복사됨');
  } finally { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
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
  const manifest = JSON.parse(fake._store.get(`${OWNER}/${wsId}/__manifest__.json`).toString());
  assert.ok(!Object.keys(manifest.files).some((k) => k.includes('.gw-queue')), '매니페스트에서도 큐 키 제거');
  assert.ok(manifest.files['vault/a.md'], '회사 데이터는 매니페스트에 유지');
  assert.ok(existsSync(join(wsRoot, 'vault', 'a.md')), '로컬 회사 데이터 무사');
  assert.ok(existsSync(join(wsRoot, '.gw-queue-telegram', '100.json')), '로컬 큐 파일은 동기화가 건드리지 않는다(정리는 드레이너 몫)');
});
