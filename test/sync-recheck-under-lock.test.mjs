// 동기화가 로컬 파일을 받아 쓰거나 지우기 직전에, 판단한 뒤 그 파일이 바뀌지 않았는지 잠금 안에서 다시 확인한다 — 반대 검토 M-b ①(2026-10-01).
// 앱 사이드카의 동기화는 사이클 시작 때 훑은 매니페스트(내용 해시)로 "원격만 바뀜"·"원격에서 삭제됨"을 판정한다. 그 사이 같은 폴더의 argo CLI가
// 대화에 턴을 쌓으면, 판정은 낡았는데 원격본으로 덮어써서 CLI가 쓴 턴이 사라졌다. 이제는 덮기 직전 해시를 다시 비교해 달라졌으면
// 그 파일만 이번 사이클에서 건너뛴다(다음 사이클이 양쪽 변경으로 보고 병합 — 실패가 아니라 미룸).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-recheck-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;

const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { openSecretCompat, sealSecret } = await import('../src/secretbox.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-sync-recheck');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });
const thread = (...texts) => Buffer.from(JSON.stringify({ sessionId: null, messages: texts.map((text, i) => ({ who: 'user', text, ts: 1 + i })) }));
const texts = async (f) => JSON.parse(await readFile(f, 'utf8')).messages.map((m) => m.text);

function fakeStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const bucket = {
    onDownload: null, // (key) => void|Promise — 다른 프로세스(CLI)가 그 사이 로컬 파일을 고치는 것을 흉내 낸다
    async download(key) {
      await bucket.onDownload?.(key);
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [] }; },
  };
  return { _store: store, bucket, storage: { from: () => bucket }, createBucket: async () => ({}) };
}

async function setup(wsId, { local, state, remoteFiles, remoteBlobs }) {
  const wsRoot = join(ROOT, wsId);
  await mkdir(join(wsRoot, 'chats'), { recursive: true });
  for (const [rel, buf] of Object.entries(local)) await writeFile(join(wsRoot, ...rel.split('/')), buf);
  await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: state, ts: 1000 }));
  const store = { [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: remoteFiles })) };
  for (const [rel, buf] of Object.entries(remoteBlobs ?? {})) store[`${OWNER}/${wsId}/${rel}`] = sealSecret(buf);
  const fake = fakeStorage(store);
  _setSyncClientForTest(fake);
  return { wsRoot, fake };
}
const cloudThread = (fake, wsId, rel) => JSON.parse(openSecretCompat(fake._store.get(`${OWNER}/${wsId}/${rel}`)).toString()).messages.map((m) => m.text);

test('원격만 바뀐 스레드를 받아 쓰는 사이 CLI가 턴을 쌓았다 — 덮어쓰지 않고 미루며, 다음 사이클이 둘 다 합친다', async () => {
  const ws = 'co-pull'; const rel = 'chats/pepper.json';
  const base = thread('기존'); const remote = thread('기존', '다른 기기 답');
  const { wsRoot, fake } = await setup(ws, { local: { [rel]: base }, state: { [rel]: meta(base) }, remoteFiles: { [rel]: meta(remote, 2000) }, remoteBlobs: { [rel]: remote } });
  const f = join(wsRoot, 'chats', 'pepper.json');
  // 사이클이 원격 blob을 내려받는 순간 CLI가 로컬 대화에 한 줄을 더한다(판정은 이미 끝난 뒤)
  fake.bucket.onDownload = async (key) => { if (key.endsWith(rel)) { fake.bucket.onDownload = null; await writeFile(f, thread('기존', 'CLI가 쓴 지시')); } };
  const r1 = await syncCompany(ws, OWNER);
  assert.deepEqual(await texts(f), ['기존', 'CLI가 쓴 지시'], 'CLI가 쓴 줄이 원격본에 덮여 사라지면 안 된다');
  assert.equal(r1.failed, 0, '미룸은 실패가 아니다 — 실패로 세면 재시도 백오프(30초~)에 걸린다');
  assert.equal(r1.pulled, 0);
  // 다음 사이클 — 양쪽이 바뀐 것으로 보고 메시지 합집합 병합
  const r2 = await syncCompany(ws, OWNER, false, {});
  assert.equal(r2.merged, 1, '다음 사이클은 양쪽 변경 병합');
  const merged = await texts(f);
  for (const t of ['기존', '다른 기기 답', 'CLI가 쓴 지시']) assert.ok(merged.includes(t), `병합본에 "${t}"가 있어야 한다 — ${merged.join('|')}`);
  assert.deepEqual(cloudThread(fake, ws, rel).sort(), merged.slice().sort(), '병합본이 클라우드에도 올라간다');
});

test('원격에서 삭제된 스레드를 지우는 사이 CLI가 턴을 쌓았다 — 지우지 않는다', async () => {
  const ws = 'co-del'; const rel = 'chats/pepper.json';
  const base = thread('기존');
  const { wsRoot, fake } = await setup(ws, { local: { [rel]: base }, state: { [rel]: meta(base) }, remoteFiles: {}, remoteBlobs: {} });
  const f = join(wsRoot, 'chats', 'pepper.json');
  fake.bucket.onDownload = async (key) => { if (key.endsWith(rel)) { fake.bucket.onDownload = null; await writeFile(f, thread('기존', 'CLI가 쓴 지시')); } };
  const r = await syncCompany(ws, OWNER);
  assert.ok(existsSync(f), 'CLI가 막 쓴 대화를 원격 삭제 전파로 지우면 안 된다');
  assert.deepEqual(await texts(f), ['기존', 'CLI가 쓴 지시']);
  assert.equal(r.failed, 0);
  assert.equal(r.deletedL, 0);
});

test('양쪽이 바뀐 스레드를 병합해 쓰는 사이 한 번 더 바뀌었다 — 낡은 로컬본으로 만든 병합본으로 덮지 않는다', async () => {
  const ws = 'co-merge'; const rel = 'chats/pepper.json';
  const base = thread('기존'); const local = thread('기존', '로컬 추가'); const remote = thread('기존', '원격 추가');
  const { wsRoot, fake } = await setup(ws, { local: { [rel]: local }, state: { [rel]: meta(base) }, remoteFiles: { [rel]: meta(remote, 2000) }, remoteBlobs: { [rel]: remote } });
  const f = join(wsRoot, 'chats', 'pepper.json');
  fake.bucket.onDownload = async (key) => { if (key.endsWith(rel)) { fake.bucket.onDownload = null; await writeFile(f, thread('기존', '로컬 추가', 'CLI가 쓴 지시')); } };
  const r = await syncCompany(ws, OWNER);
  assert.ok((await texts(f)).includes('CLI가 쓴 지시'), '병합 중 새로 쓴 줄이 사라지면 안 된다');
  assert.equal(r.failed, 0);
});

test('대조군 — 아무도 건드리지 않으면 종전대로 원격본을 받는다', async () => {
  const ws = 'co-plain'; const rel = 'chats/pepper.json';
  const base = thread('기존'); const remote = thread('기존', '다른 기기 답');
  const { wsRoot } = await setup(ws, { local: { [rel]: base }, state: { [rel]: meta(base) }, remoteFiles: { [rel]: meta(remote, 2000) }, remoteBlobs: { [rel]: remote } });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.pulled, 1);
  assert.deepEqual(await texts(join(wsRoot, 'chats', 'pepper.json')), ['기존', '다른 기기 답']);
  assert.equal(existsSync(join(wsRoot, 'chats', 'pepper.json.lockd')), false, '잠금 폴더는 남지 않는다');
});

test('thread 말고 코어 모듈이 잠그는 파일(approvals.json)도 같다 — 받아 쓰는 사이 CLI가 결재를 올렸다', async () => {
  const ws = 'co-appr'; const rel = 'approvals.json';
  const base = Buffer.from('[]'); const remote = Buffer.from(JSON.stringify([{ id: 'ap-remote', status: 'pending' }]));
  const { wsRoot, fake } = await setup(ws, { local: { [rel]: base }, state: { [rel]: meta(base) }, remoteFiles: { [rel]: meta(remote, 2000) }, remoteBlobs: { [rel]: remote } });
  const f = join(wsRoot, rel);
  fake.bucket.onDownload = async (key) => { if (key.endsWith(rel)) { fake.bucket.onDownload = null; await writeFile(f, JSON.stringify([{ id: 'ap-cli', status: 'pending' }])); } };
  const r = await syncCompany(ws, OWNER);
  assert.deepEqual(JSON.parse(await readFile(f, 'utf8')).map((a) => a.id), ['ap-cli'], 'CLI가 올린 결재가 원격본에 덮이면 안 된다');
  assert.equal(r.failed, 0);
  assert.equal(r.deferred, 1);
});
