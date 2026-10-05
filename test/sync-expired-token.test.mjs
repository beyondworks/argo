// 만료 토큰이 '원격 없음'으로 읽히던 결함(운영 실측 2026-10-05 08:59:49Z) — 행동 테스트(가짜 저장소, 임시 ARGO_ROOT).
// 상주 사이클이 토큰 남은 시간보다 오래 돌아 끝부분 요청이 만료 토큰으로 나갔다. Storage는 만료 토큰 GET을 익명으로 처리해
// 비공개 버킷을 못 보고 'Bucket not found'(HTTP 400, statusCode '404')를 준다(storage_logs: role anon, NoSuchBucket). isNotFound가
// 메시지의 "not found"만 보고 이것을 '매니페스트 없음'으로 읽어, 빈 원격으로 판정하고 쓰기까지 시도했다(쓰기는 만료로 거절).
// 실제 파일이 있는 회사라면 같은 판정이 blobExists에도 걸려 로컬 파일을 지우고(대량 삭제 브레이크 미만이면), 그 사이클은 state를
// 못 써서 다음 정상 사이클이 그 파일들을 '이 기기가 지운 것'으로 읽어 원격까지 지운다.
// 계약(이유: 삭제는 비가역 — 확인 못 한 것은 없음이 아니다): 만료 토큰 사이클은 아무것도 지우지 않고 보류하며, 다음 정상 사이클도 지우지 않는다.
// 인접 핀: 진짜 '객체 없음'(Object not found)은 지금처럼 없음으로 읽는다(새 회사 첫 푸시·#832 빈 항목 건너뜀).
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

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

test('매니페스트를 못 본 사이클(정말 없음)도 기록이 있는 로컬 파일을 지우지 않고 다시 민다 — 분류가 또 틀려도 지우지 않는 두 번째 방어선', async () => {
  const WS = 'co-wiped';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {};
  for (let i = 0; i < 10; i++) {
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[`vault/notes/n${i}.md`] = meta(orig);
    await writeFile(join(dir, `n${i}.md`), i < 3 ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  const f = storage({}); // 매니페스트도 객체도 없다(Object not found) — 원격이 비었다
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.deletedL, 0, '로컬 삭제 0 — 수정 전엔 7개(브레이크 아래)를 지웠다');
  assert.equal((await readdir(dir)).filter((n) => n.endsWith('.md')).length, 10);
  assert.equal(r.pushed, 10, '열 개 모두 다시 민다');
  const manifest = JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
  assert.equal(Object.keys(manifest.files).length, 10, '원격 매니페스트가 열 개로 다시 채워진다');
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

