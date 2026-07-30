// free 복원 완결 계약(재검수 2026-07-30 HIGH-E·F) — 행동 테스트(fake storage로 syncCompany 실행).
// 계약: free 기기의 복원(pull)은 매니페스트 업로드가 RLS에 거부돼도 pull이 완결(failed=0)이면
// state를 기록하고 통과한다 → 다음 사이클부터 syncStateExists=true로 회사가 스킵돼 파일 루프
// 자체가 안 돌고, 삭제 전파(#6)·지운 노트 부활(HIGH-E)이 원천적으로 불가하다.
// 소스 스캔(sync-list-cadence)이 배선을, 이 파일이 행동을 잠근다 — MEMORY 교훈: 소스 문자열은
// "분기가 도는지"를 못 본다.
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-freerestore-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, syncStateExists, _setSyncClientForTest } = await import('../src/sync.mjs');

const OWNER = 'o';
const WS = 'ws1';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });

/** fake storage — download는 제공, upload는 RLS 거부(free 모사), remove는 기록만. */
function freeStorage(initial) {
  const store = new Map(Object.entries(initial));
  const removed = [];
  const bucket = {
    async download(key) {
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', status: 404 } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload() { return { error: { message: 'new row violates row-level security policy' } }; },
    async remove(keys) { removed.push(...keys); return { error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, removed };
}

test('free 복원: pull 완결이면 매니페스트 RLS 거부를 관용하고 state를 기록한다(HIGH-E 종결)', async () => {
  await mkdir(join(ROOT, WS), { recursive: true });
  const note = Buffer.from('# 복원 노트\n');
  const manifest = Buffer.from(JSON.stringify({ files: { 'vault/notes/a.md': meta(note) } }));
  const fake = freeStorage({
    [`${OWNER}/${WS}/__manifest__.json`]: manifest,
    [`${OWNER}/${WS}/vault/notes/a.md`]: note,
  });
  _setSyncClientForTest(fake.client);
  // 복원(pull) — 업로드 전멸 환경에서도 throw 없이 완결돼야 한다
  const r = await syncCompany(WS, OWNER, true, { tolerateManifestDenied: true });
  assert.equal(r.failed, 0, 'pull 실패 없음');
  assert.equal(r.manifestDenied, true, '매니페스트 거부가 관용으로 표기된다');
  assert.equal((await readFile(join(ROOT, WS, 'vault', 'notes', 'a.md'), 'utf8')).includes('복원 노트'), true, '실제 pull');
  assert.equal(await syncStateExists(WS), true, 'state 기록 = 다음 사이클부터 free 스킵(파일 루프 미가동 → 삭제 전파 불가)');
  // 사용자가 로컬에서 삭제해도, 스킵 술어가 true인 한 cycle이 syncCompany를 부르지 않아
  // 부활(HIGH-E)도 원격 삭제 전파(#6)도 일어나지 않는다 — 스킵 배선은 sync-list-cadence가 잠근다.
  await rm(join(ROOT, WS, 'vault', 'notes', 'a.md'));
  assert.equal(await syncStateExists(WS), true, '삭제 후에도 스킵 술어 유지');
});

test('관용은 pull 완결일 때만 — pull 실패가 남으면 throw해 복원 미완(state 미기록)으로 재시도된다', async () => {
  const WS2 = 'ws2';
  await mkdir(join(ROOT, WS2), { recursive: true });
  const note = Buffer.from('x');
  // 매니페스트는 파일을 선언하는데 blob이 없다 → pull 실패(failed>0) → 관용 불가
  const manifest = Buffer.from(JSON.stringify({ files: { 'vault/notes/missing.md': meta(note) } }));
  const fake = freeStorage({ [`${OWNER}/${WS2}/__manifest__.json`]: manifest });
  _setSyncClientForTest(fake.client);
  const r = await syncCompany(WS2, OWNER, true, { tolerateManifestDenied: true }).catch((e) => ({ threw: String(e.message) }));
  // 파일 실패는 루프 안 catch(failed++)로 삼켜지고 매니페스트 업로드에서 throw — 어느 쪽이든 state 미기록이 계약
  if (!r.threw) assert.ok((r.failed ?? 0) > 0, 'pull 실패가 집계된다');
  assert.equal(await syncStateExists(WS2), false, 'state 미기록 = 다음 사이클 재시도(복원 미완)');
});

test('관용 미지정(비free 계약)이면 매니페스트 거부는 그대로 throw — pro의 실패 가시성 유지', async () => {
  const WS3 = 'ws3';
  await mkdir(join(ROOT, WS3), { recursive: true });
  const fake = freeStorage({ [`${OWNER}/${WS3}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: {} })) });
  _setSyncClientForTest(fake.client);
  await assert.rejects(() => syncCompany(WS3, OWNER, true), /row-level security/);
  assert.equal(await syncStateExists(WS3), false);
  await rm(ROOT, { recursive: true, force: true });
});
