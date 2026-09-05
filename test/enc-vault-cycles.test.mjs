// 회사 데이터 전체 봉투(v2) 기본 켜짐 — 사이클 단위 행동 핀(#436 분리 검수 HIGH-3·CRITICAL-1·MEDIUM-4·HIGH-2).
// 실벤더·라이브 0: fake storage + 계정 키 캐시만. 관용 개봉(openSecretCompat)은 평문도 통과시키므로 여기서는 **바이트 접두**로 잠근다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-encv2-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_ENC_VAULT; // 기본 켜짐 경로
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { openSecretCompat } = await import('../src/secretbox.mjs');
const { ensureAccountKey, clearAccountKey } = await import('../src/accountkey.mjs');
const { fakeKeySb } = await import('./helpers/fake-account-key.mjs');
after(() => { clearAccountKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });
const V2 = 'argosecret.v2:';
const key = () => ensureAccountKey(fakeKeySb(Buffer.alloc(32, 21).toString('base64')), OWNER);

function storage(initial = {}) {
  const store = new Map(Object.entries(initial)); const removed = [];
  const bucket = {
    async download(k) { k = k.split('?')[0]; if (!store.has(k)) return { data: null, error: { message: 'Object not found', status: 404 } }; const b = store.get(k); return { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null }; },
    async upload(k, blob) { store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { removed.push(...keys); for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [], error: null }; },
  };
  return { client: { storage: { from: () => bucket } }, store, removed };
}
const stateOf = async (ws) => JSON.parse(await readFile(join(ROOT, ws, '.sync-state.json'), 'utf8')).files;
const K = (ws, rel) => `${OWNER}/${ws}/${rel}`;

test('V2-1 기본 켜짐 1사이클 — 파일 blob·매니페스트 모두 v2 봉투, 개봉하면 평문과 동일, 해시는 평문 기준(HIGH-3 a·M3·M4 핀)', async () => {
  const ws = 'v2a'; await mkdir(join(ROOT, ws, 'vault', 'notes'), { recursive: true });
  const plain = Buffer.from('# 기억 노트\n계정 키로 봉인된다\n'); await writeFile(join(ROOT, ws, 'vault/notes/a.md'), plain);
  await key(); const fake = storage(); _setSyncClientForTest(fake.client);
  const r = await syncCompany(ws, OWNER, false, {});
  assert.equal(r.pushed, 1); assert.equal(r.failed, 0);
  const blob = fake.store.get(K(ws, 'vault/notes/a.md')); assert.ok(blob.subarray(0, V2.length).toString() === V2, '파일은 v2 봉투');
  assert.deepEqual(openSecretCompat(blob), plain, '개봉하면 평문 동일');
  const man = fake.store.get(K(ws, '__manifest__.json')); assert.ok(man.subarray(0, V2.length).toString() === V2, '매니페스트도 v2');
  const files = JSON.parse(openSecretCompat(man).toString()).files;
  assert.equal(files['vault/notes/a.md'].h, hashBuf(plain), '해시는 평문 기준'); assert.equal(files['vault/notes/a.md'].s, plain.length);
  assert.equal((await stateOf(ws))['vault/notes/a.md'].h, hashBuf(plain), 'base는 디스크 실제 내용');
});

test('V2-2 계정 키 미확보 사이클 — 전체 보류(held)·삭제 0·base 미흡수, 키 회복 사이클이 원격 전용 파일을 pull하고 deletedR 0(CRITICAL-1·M2·HIGH-2 핀)', async () => {
  const ws = 'v2b'; await mkdir(join(ROOT, ws, 'vault', 'notes'), { recursive: true });
  const mine = Buffer.from('# 내 노트\n'); await writeFile(join(ROOT, ws, 'vault/notes/mine.md'), mine);
  const others = { 'vault/notes/other-A.md': Buffer.from('A'), 'vault/notes/other-B.md': Buffer.from('B'), 'vault/notes/other-C.md': Buffer.from('C') };
  const manifest = { files: { 'vault/notes/mine.md': meta(mine), ...Object.fromEntries(Object.entries(others).map(([k, v]) => [k, meta(v)])) } };
  await writeFile(join(ROOT, ws, '.sync-state.json'), JSON.stringify({ files: { 'vault/notes/mine.md': meta(mine) }, ts: 1 }));
  const fake = storage({ [K(ws, '__manifest__.json')]: Buffer.from(JSON.stringify(manifest)), [K(ws, 'vault/notes/mine.md')]: mine, ...Object.fromEntries(Object.entries(others).map(([k, v]) => [K(ws, k), v])) });
  _setSyncClientForTest(fake.client);
  clearAccountKey(); // 사이클 N — 키 없음(PostgREST 오류·RLS·마이그레이션 미적용 재현)
  const n = await syncCompany(ws, OWNER, false, {});
  assert.equal(n.deletedR, 0); assert.equal(n.deletedL, 0); assert.equal(n.pulled, 0); assert.ok(n.held >= 4, `보류가 결과에 실린다: ${JSON.stringify(n)}`);
  const base = await stateOf(ws);
  for (const k of Object.keys(others)) assert.equal(k in base, false, `못 받은 원격 항목은 base에 흡수되지 않는다: ${k}`);
  assert.ok(existsSync(join(ROOT, ws, 'vault/notes/mine.md')), '로컬 무접촉');
  await key(); // 사이클 N+1 — 키 회복
  const m = await syncCompany(ws, OWNER, false, {});
  assert.equal(m.deletedR, 0, '원격 삭제 없음(이전: 3건 소멸)'); assert.equal(m.pulled, 3, '원격 전용 파일을 받는다');
  for (const [k, v] of Object.entries(others)) assert.deepEqual(await readFile(join(ROOT, ws, k)), v, `내려왔다: ${k}`);
  assert.deepEqual(fake.removed, [], '클라우드 blob 삭제 없음');
  const man = JSON.parse(openSecretCompat(fake.store.get(K(ws, '__manifest__.json'))).toString()).files;
  for (const k of Object.keys(others)) assert.ok(man[k], `매니페스트 유지: ${k}`);
});

test('V2-3 옵트아웃 기기(ARGO_ENC_VAULT=0)도 계정 키가 있으면 매니페스트는 v2로 쓴다 — 세대 다운그레이드 금지(MEDIUM-4)', async () => {
  const ws = 'v2c'; await mkdir(join(ROOT, ws, 'vault', 'notes'), { recursive: true });
  const plain = Buffer.from('# 옵트아웃 노트\n'); await writeFile(join(ROOT, ws, 'vault/notes/o.md'), plain);
  await key(); const fake = storage(); _setSyncClientForTest(fake.client);
  process.env.ARGO_ENC_VAULT = '0';
  try { const r = await syncCompany(ws, OWNER, false, {}); assert.equal(r.pushed, 1); }
  finally { delete process.env.ARGO_ENC_VAULT; }
  assert.deepEqual(fake.store.get(K(ws, 'vault/notes/o.md')), plain, '옵트아웃이면 파일은 평문(사용자 선택)');
  assert.ok(fake.store.get(K(ws, '__manifest__.json')).subarray(0, V2.length).toString() === V2, '매니페스트는 v2 유지');
});
