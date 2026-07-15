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

const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');

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
    async list() { return { data: [] }; },
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
