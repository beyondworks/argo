// 원장 조각(ARGO_LEDGER_SPLIT=1)의 동기화 — 경우 표 S1~S4(공유 노트 ledger-split-case-table.md). sync.mjs는 바꾸지 않았다:
// 조각도 `.jsonl` 원장이라 기존 원장 규칙(파일 단위 업로드, 양쪽 변경 시 행 합집합 mergeLedger)을 그대로 탄다는 것을 가짜 저장소로 확인한다.
// ⚠ ARGO_ROOT는 sync.mjs(→workspace.mjs) 동적 임포트보다 먼저.
import { test, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-ledgersync-'));
process.env.ARGO_ROOT = ROOT;
delete process.env.ARGO_LEDGER_SPLIT;
await writeFile(join(ROOT, '.device-id'), 'dev-a-11111111');
const { syncCompany, _setSyncClientForTest } = await import('../src/sync.mjs');
const { appendEvent, readEvents } = await import('../src/events.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });
afterEach(() => { delete process.env.ARGO_LEDGER_SPLIT; });

const OWNER = 'o';
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };
const MKEY = (ws) => `${OWNER}/${ws}/__manifest__.json`;
const MONTH = new Date().toISOString().slice(0, 7);
const PIECE_A = `events.dev-a-11111111.${MONTH}.jsonl`;

/** 가짜 저장소 — 원장 객체(매니페스트 밖)의 받은·올린 바이트를 따로 센다. */
function storage() {
  const store = new Map();
  const log = { getBytes: 0, putBytes: 0, puts: [] };
  const isData = (k) => !k.endsWith('__manifest__.json');
  const bucket = {
    async download(k) {
      k = k.split('?')[0];
      const b = store.get(k);
      if (b && isData(k)) log.getBytes += b.length;
      return b ? { data: { arrayBuffer: async () => new Uint8Array(b).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async info(k) {
      const b = store.get(k.split('?')[0]);
      if (!b) return { data: null, error: { message: 'Object not found', status: 404, statusCode: '404' } };
      return { data: { etag: `"${createHash('md5').update(b).digest('hex')}"`, size: b.length, lastModified: new Date().toISOString() }, error: null };
    },
    async upload(k, blob) {
      const b = Buffer.from(await blob.arrayBuffer());
      if (isData(k)) { log.putBytes += b.length; log.puts.push(k.slice(k.lastIndexOf('/') + 1)); }
      store.set(k, b);
      return { error: null };
    },
    async remove(keys) { for (const k of keys) store.delete(k); return { data: [], error: null }; },
    async list() { return { data: [], error: null }; },
  };
  const manifest = (ws) => JSON.parse(openSecretCompat(store.get(MKEY(ws))).toString());
  const setManifest = (ws, files) => store.set(MKEY(ws), sealSecret(Buffer.from(JSON.stringify({ files }))));
  const remote = (ws, rel) => openSecretCompat(store.get(`${OWNER}/${ws}/${rel}`)).toString();
  const reset = () => { log.getBytes = 0; log.putBytes = 0; log.puts.length = 0; };
  return { client: { storage: { from: () => bucket } }, store, log, manifest, setManifest, remote, reset };
}
/** 다른 기기가 원격에 원장 파일을 올림(객체 + 매니페스트 항목). */
function otherDevicePuts(f, ws, rel, body) {
  const b = Buffer.from(body);
  f.store.set(`${OWNER}/${ws}/${rel}`, sealSecret(b));
  const files = f.manifest(ws).files;
  files[rel] = { m: Date.now() + 1000, s: b.length, h: hashBuf(b) };
  f.setManifest(ws, files);
}
const sync = async (ws, f) => { _setSyncClientForTest(f.client); const r = await syncCompany(ws, OWNER, false); assert.equal(r.failed, 0, '사이클 성공'); return r; };
const ev = (n, ts = new Date().toISOString()) => `${JSON.stringify({ ts, type: 'turn', n })}\n`;
async function company(ws) { await mkdir(join(ROOT, ws, 'vault'), { recursive: true }); await writeFile(join(ROOT, ws, 'vault', 'a.md'), '# a\n'); }

test('S1 두 기기가 같은 시각에 씀 — 서로 다른 조각이라 병합 0, 동기화 뒤 이 기기가 두 기기 줄을 모두 본다', async () => {
  process.env.ARGO_LEDGER_SPLIT = '1';
  const f = storage(); const ws = 'ls-s1';
  await company(ws);
  await appendEvent(ws, { type: 'turn', n: 'a1' });
  await sync(ws, f);
  otherDevicePuts(f, ws, `events.dev-b-22222222.${MONTH}.jsonl`, ev('b1'));
  await appendEvent(ws, { type: 'turn', n: 'a2' });
  f.reset();
  const r = await sync(ws, f);
  assert.equal(r.merged, 0, '충돌 병합 없음');
  assert.equal(r.conflicts, 0);
  assert.deepEqual(f.log.puts, [PIECE_A], '올린 원장은 이 기기 조각 하나');
  assert.deepEqual(new Set((await readEvents(ws, 10)).map((e) => e.n)), new Set(['a1', 'a2', 'b1']));
  assert.ok(f.remote(ws, PIECE_A).includes('"n":"a2"'));
});

test('S2 같은 기기 id 복제(백업 복원) — 같은 조각을 두 기기가 바꾸면 행 합집합으로 잃지 않는다', async () => {
  process.env.ARGO_LEDGER_SPLIT = '1';
  const f = storage(); const ws = 'ls-s2';
  await company(ws);
  await appendEvent(ws, { type: 'turn', n: 'base' });
  await sync(ws, f);
  const baseLine = (await readFile(join(ROOT, ws, PIECE_A), 'utf8'));
  otherDevicePuts(f, ws, PIECE_A, baseLine + ev('clone'));
  await appendEvent(ws, { type: 'turn', n: 'mine' });
  const r = await sync(ws, f);
  assert.equal(r.merged, 1, '원장 병합 1번');
  const local = await readFile(join(ROOT, ws, PIECE_A), 'utf8');
  for (const n of ['base', 'clone', 'mine']) assert.ok(local.includes(`"n":"${n}"`), `로컬에 ${n}`);
  assert.equal(f.remote(ws, PIECE_A), local, '원격과 로컬이 같아졌다');
});

test('S3 새 기기 복원 — 옛 파일과 모든 조각을 받고 활동 이력이 그대로', async () => {
  const f = storage(); const ws = 'ls-s3';
  f.setManifest(ws, {});
  otherDevicePuts(f, ws, 'events.jsonl', ev('old', '2026-08-01T00:00:00Z'));
  otherDevicePuts(f, ws, 'events.dev-b-22222222.2026-09.jsonl', ev('b9', '2026-09-01T00:00:00Z'));
  otherDevicePuts(f, ws, 'events.dev-c-33333333.2026-10.jsonl', ev('c10', '2026-10-01T00:00:00Z'));
  _setSyncClientForTest(f.client);
  const r = await syncCompany(ws, OWNER, true);
  assert.equal(r.failed, 0);
  assert.deepEqual((await readEvents(ws, 10)).map((e) => e.n), ['c10', 'b9', 'old']);
  assert.deepEqual((await readdir(join(ROOT, ws))).filter((n) => n.endsWith('.jsonl')).sort(), ['events.dev-b-22222222.2026-09.jsonl', 'events.dev-c-33333333.2026-10.jsonl', 'events.jsonl']);
});

/** S4 부하 — 옛 원장이 큰 회사에서 한 줄씩 덧붙이는 주기 N번. 꺼짐(배포본)은 매번 옛 파일 전체를 올리고, 켬은 이번 달 이 기기 조각만 올린다. */
async function loadRun(ws, split, { oldRows = 6000, cycles = 10 } = {}) {
  if (split) process.env.ARGO_LEDGER_SPLIT = '1'; else delete process.env.ARGO_LEDGER_SPLIT;
  const f = storage();
  await company(ws);
  const pad = 'x'.repeat(400); // 운영 활동 줄 크기 근처(gist·rel 포함)
  await writeFile(join(ROOT, ws, 'events.jsonl'), Array.from({ length: oldRows }, (_, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(), type: 'turn', n: i, pad })).join('\n') + '\n');
  await sync(ws, f);
  f.reset();
  for (let i = 0; i < cycles; i++) { await appendEvent(ws, { type: 'turn', n: `c${i}`, pad }); await sync(ws, f); }
  const events = await readEvents(ws, oldRows + cycles + 5);
  return { putBytes: f.log.putBytes, puts: f.log.puts.length, rows: events.length };
}

test('S4 부하 — 한 줄 덧붙이는 주기 10번: 꺼짐은 옛 파일 전체, 켬은 조각만 올린다(줄은 모두 남는다)', async () => {
  const off = await loadRun('ls-s4-off', false);
  const on = await loadRun('ls-s4-on', true);
  console.log(`# S4 원장 올린 바이트(주기 10번, 옛 줄 6,000개 ≈ ${(6000 * 470 / 1e6).toFixed(1)}MB): 꺼짐 ${off.putBytes} (${off.puts}번) / 켬 ${on.putBytes} (${on.puts}번)`);
  assert.equal(off.rows, 6010); assert.equal(on.rows, 6010, '켬에서도 옛 줄 + 새 줄이 모두 읽힌다');
  assert.equal(off.puts, 10); assert.equal(on.puts, 10, '올리는 횟수는 같다');
  assert.ok(on.putBytes * 100 < off.putBytes, `켬이 100분의 1 아래(${on.putBytes} vs ${off.putBytes})`);
});
