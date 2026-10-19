// 새 시작 — 클라우드 사본이 정리된 뒤 다시 Pro가 된 계정(2026-10-19, 검수 #1108 H2). 행동 시험(가짜 저장소, 임시 ARGO_ROOT).
// 계약(src/sync.mjs FRESH_START_MIN_APP 주석):
//  ① 장치가 켜져 있으면(서버 최소 앱 버전 ≥ FRESH_START_MIN_APP) 정리된 원격 + 옛 기록 → 로컬 파일 하나도 지우지 않고 로컬 기준으로 다시 올린다(.sync-state 있음/없음,
//     무변경/일부 수정). 매니페스트·기록에 새 시작 표지(epoch)를 남긴다. 도중에 끊겨도 다음 사이클이 이어 간다(영구 보류 없음).
//  ② 다른 기기는 epoch가 다르면 기록을 비우고 합친다 — 삭제 0, 양쪽이 다른 노트는 수정 시각이 늦은 쪽이 정본·다른 쪽은 .conflict.
//  ③ 범위: '늦은 쪽 정본'은 새 시작 합치기에서만 — 평소 충돌은 종전처럼 원격 정본.
//  ④ 장치가 꺼져 있으면 종전과 같다(보류) — 기존 시험(test/sync-expired-token.test.mjs)은 무변경으로 통과해야 한다. 여기서는 대표 경우만 다시 잠근다.
//  ⑤ 일부 blob만 없으면(정리 중·부분 유실) 켜져 있어도 종전 보류.
// ⚠ ARGO_ROOT는 sync.mjs 동적 임포트보다 먼저.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, rm, rename, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-freshstart-'));
process.env.ARGO_ROOT = ROOT;
const { syncCompany, _setSyncClientForTest, FRESH_START_MIN_APP } = await import('../src/sync.mjs');
const { useFakeAccountKey } = await import('./helpers/fake-account-key.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const { _resetAppGateForTest } = await import('../src/app-gate.mjs');
const restoreKey = await useFakeAccountKey(3, 'o');
after(() => { restoreKey(); return rm(ROOT, { recursive: true, force: true }); });

const OWNER = 'o';
const hashBuf = (b) => createHash('sha1').update(b).digest('hex').slice(0, 16);
const meta = (b, m = 1000) => ({ m, s: b.length, h: hashBuf(b) });
const OBJECT_NOT_FOUND = { message: 'Object not found', status: 400, statusCode: '404' };
const NET_FAIL = { message: 'fetch failed', name: 'StorageUnknownError' };
const isManifest = (k) => k.endsWith('/__manifest__.json');

async function gate(min, sinceAgoMs = 2 * 3600_000) { // 서버 최소 앱 버전(.app-gate.json) — null이면 파일 없음(장치 꺼짐). since = 그 값을 처음 본 시각
  if (min) await writeFile(join(ROOT, '.app-gate.json'), JSON.stringify({ min, checkedAt: Date.now(), since: Date.now() - sinceAgoMs }));
  else await rm(join(ROOT, '.app-gate.json'), { force: true });
  _resetAppGateForTest();
}

function storage(initial = {}) {
  const store = new Map(Object.entries(initial));
  const state = {};
  const log = { uploads: [], removed: [] };
  const bucket = {
    async download(k) {
      k = k.split('?')[0];
      const forced = state.downloadError?.(k);
      if (forced) return { data: null, error: forced };
      return store.has(k) ? { data: { arrayBuffer: async () => new Uint8Array(store.get(k)).buffer }, error: null } : { data: null, error: OBJECT_NOT_FOUND };
    },
    async upload(k, blob) {
      log.uploads.push(k);
      const forced = state.uploadError?.(k);
      if (forced) return { error: forced };
      store.set(k, Buffer.from(await blob.arrayBuffer())); return { error: null };
    },
    async remove(keys) { log.removed.push(...keys); for (const k of keys) store.delete(k); return { data: [], error: null }; },
    async list() { return { data: [], error: null }; },
  };
  // 플랜 조회(rpc my_plan) — 새 시작 직전의 캐시 건너뛴 확인(F3). 기본 pro, state.plan으로 바꾼다
  const rpc = async (name) => (name === 'my_plan' ? { data: { plan: state.plan ?? 'pro' }, error: null } : { data: null, error: { message: 'no rpc' } });
  return { client: { storage: { from: () => bucket }, rpc }, store, state, log };
}
const manifestOf = (f, WS) => JSON.parse(openSecretCompat(f.store.get(`${OWNER}/${WS}/__manifest__.json`)).toString());
const remoteText = (f, WS, rel) => openSecretCompat(f.store.get(`${OWNER}/${WS}/${rel}`)).toString();
const stateOf = async (WS) => JSON.parse(await readFile(join(ROOT, WS, '.sync-state.json'), 'utf8'));

/** 정리된 원격을 겪은 기기 — 기록(base) n개, edited(i)면 이 기기에서 고친 내용. withState=false면 기록 없음. */
async function seedWiped(WS, n, { edited = () => false, withState = true } = {}) {
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const base = {};
  for (let i = 0; i < n; i++) {
    const orig = Buffer.from(`# 원본 ${i}\n`);
    base[`vault/notes/n${i}.md`] = meta(orig);
    await writeFile(join(dir, `n${i}.md`), edited(i) ? `# 이 기기에서 고침 ${i}\n` : orig);
  }
  if (withState) await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  return { dir, count: async () => (await readdir(dir)).filter((x) => x.endsWith('.md')).length };
}

for (const [idx, [name, opts]] of [
  ['기록 있음 · 10개 무변경', { withState: true, edited: () => false }],
  ['기록 있음 · 10개 중 3개 수정', { withState: true, edited: (i) => i < 3 }],
  ['기록 없음 · 10개', { withState: false, edited: () => false }],
].entries()) {
  test(`① 장치 켜짐 — 사본 정리 뒤 재결제(${name}): 로컬 삭제 0, 로컬 기준으로 전부 다시 올리고 다음 사이클은 할 일 없음`, async () => {
    await gate(FRESH_START_MIN_APP);
    const WS = `fs-case-${idx}`;
    const { count } = await seedWiped(WS, 10, opts);
    const f = storage({});
    _setSyncClientForTest(f.client);
    const r = await syncCompany(WS, OWNER, false);
    assert.equal(r.deletedL, 0); assert.equal(r.deletedR, 0); assert.equal(r.failed, 0);
    assert.equal(r.pushed, 10, '10개 모두 올린다');
    assert.equal(await count(), 10, '로컬 파일 그대로');
    assert.deepEqual(f.log.removed, []);
    for (let i = 0; i < 10; i++) assert.equal(remoteText(f, WS, `vault/notes/n${i}.md`), opts.edited(i) ? `# 이 기기에서 고침 ${i}\n` : `# 원본 ${i}\n`, `n${i}는 이 기기 내용`);
    const man = manifestOf(f, WS);
    assert.equal(Object.keys(man.files).length, 10);
    if (opts.withState) {
      assert.match(man.epoch ?? '', /^[0-9a-z]+-[0-9a-f]{8}$/, '정리된 원격을 새로 채우면 새 시작 표지를 남긴다');
      assert.equal((await stateOf(WS)).epoch, man.epoch, '기록에도 같은 표지');
      assert.equal((await stateOf(WS)).freshStart, undefined, '끝난 새 시작은 표시를 지운다');
    } else assert.equal(man.epoch, undefined, '기록 없는 첫 동기화는 새 시작이 아니다(종전 첫 동기화)');
    _setSyncClientForTest(f.client);
    const r2 = await syncCompany(WS, OWNER, false);
    assert.equal(r2.pushed + r2.pulled + r2.deletedL + r2.deletedR, 0, '다음 사이클 할 일 없음');
    await gate(null);
  });
}

test('① 새 시작 도중 끊김(3개 올린 뒤 네트워크 실패) — 다음 사이클이 같은 표지로 이어 가 모두 올린다(영구 보류 없음, 삭제 0)', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-cut';
  const { count } = await seedWiped(WS, 10);
  const f = storage({});
  let ok = 0;
  f.state.uploadError = (k) => (isManifest(k) || ++ok > 3 ? NET_FAIL : null);
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false));
  const mid = await stateOf(WS);
  assert.equal(mid.freshStart, true); assert.deepEqual(mid.files, {}, '기록은 먼저 비워져 있다');
  f.state.uploadError = null;
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.failed, 0); assert.equal(r.deletedL, 0);
  assert.equal(await count(), 10);
  assert.equal(manifestOf(f, WS).epoch, mid.epoch, '끊기기 전에 정한 표지 그대로');
  await gate(null);
});

test('⑤ 장치 켜짐이어도 일부 blob만 없으면 종전 보류(지우지도 다시 밀지도 않음)', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-partial';
  const { count } = await seedWiped(WS, 10);
  const store = {};
  for (let i = 0; i < 10; i += 2) store[`${OWNER}/${WS}/vault/notes/n${i}.md`] = Buffer.from(`# 원본 ${i}\n`); // 반만 남음
  const f = storage(store);
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /대량 삭제 감지|클라우드 사본이 비어|새로 올리는 중/);
  assert.deepEqual(f.log.uploads, []); assert.deepEqual(f.log.removed, []);
  assert.equal(await count(), 10);
  await gate(null);
});

test('F1 장치 켜짐 + 매니페스트 없음 + 기록 있음 + blob 일부 있음(다른 기기의 새 시작이 매니페스트 전) — 치유하지 않고 보류, 내 편집 그대로', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-f1';
  const { dir } = await seedWiped(WS, 5, { edited: (i) => i < 3 }); // 무변경 2개 — 대량 삭제 브레이크 아래
  const f = storage({ [`${OWNER}/${WS}/vault/notes/n3.md`]: Buffer.from('# 다른 기기의 옛 판 3\n'), [`${OWNER}/${WS}/vault/notes/n4.md`]: Buffer.from('# 다른 기기의 옛 판 4\n') });
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /새로 올리는 중/);
  assert.deepEqual(f.log.uploads, []); assert.deepEqual(f.log.removed, []);
  assert.equal(await readFile(join(dir, 'n0.md'), 'utf8'), '# 이 기기에서 고침 0\n');
  assert.equal((await stateOf(WS)).files['vault/notes/n3.md'].h, meta(Buffer.from('# 원본 3\n')).h, '기록을 다른 기기 blob에 맞춰 고치지 않는다');
  await gate(null);
});

test('F3 장치 켜짐 + 정리된 원격처럼 보여도 캐시 건너뛴 플랜 확인이 Pro·체험이 아니면(무료: 서버가 읽기를 막음) 새 시작하지 않는다 — 종전 보류', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-f3';
  const { count } = await seedWiped(WS, 10);
  const f = storage({});
  f.state.plan = 'free';
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /대량 삭제 감지|클라우드 사본이 비어/);
  assert.deepEqual(f.log.uploads, []);
  assert.equal(await count(), 10);
  assert.equal((await stateOf(WS)).freshStart, undefined, '기록을 비우지 않는다');
  await gate(null);
});

test('F2-b 최소 버전을 본 지 FRESH_START_SETTLE_MS가 안 됐으면 새 시작을 열지 않는다(다른 기기가 알아챌 시간) — 종전 보류', async () => {
  await gate(FRESH_START_MIN_APP, 60_000);
  const WS = 'fs-settle';
  await seedWiped(WS, 10);
  const f = storage({});
  _setSyncClientForTest(f.client);
  await assert.rejects(() => syncCompany(WS, OWNER, false), /대량 삭제 감지|클라우드 사본이 비어/);
  assert.deepEqual(f.log.uploads, []);
  await gate(null);
});

test('F2 장치가 아직 꺼진 기기도 다른 기기의 새 시작 매니페스트(epoch)를 보면 합친다 — 자기만 가진 파일을 지우지 않고 올린다', async () => {
  await gate(null); // 이 기기는 아직 최소 버전을 모른다
  const WS = 'fs-f2';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const a = Buffer.from('# a\n'), b = Buffer.from('# b만\n');
  await writeFile(join(dir, 'a.md'), a); await writeFile(join(dir, 'b-only.md'), b);
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: { 'vault/notes/a.md': meta(a), 'vault/notes/b-only.md': meta(b) }, ts: 1 }));
  const f = storage({ // 다른 기기가 새로 시작해 a만 올렸다(b-only는 정리돼 없음)
    [`${OWNER}/${WS}/vault/notes/a.md`]: a,
    [`${OWNER}/${WS}/__manifest__.json`]: sealSecret(Buffer.from(JSON.stringify({ epoch: 'e9-bbbbbbbb', files: { 'vault/notes/a.md': meta(a) } }))),
  });
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.deletedL, 0, '종전 규칙이면 b-only를 다른 기기가 지운 것으로 읽어 지웠다');
  assert.equal(await readFile(join(dir, 'b-only.md'), 'utf8'), '# b만\n');
  assert.equal(remoteText(f, WS, 'vault/notes/b-only.md'), '# b만\n', '자기만 가진 파일을 올린다');
  assert.equal((await stateOf(WS)).epoch, 'e9-bbbbbbbb');
});

for (const [name, min] of [['파일 없음', null], ['최소 버전이 낮음', '0.1.113']]) {
  test(`④ 장치 꺼짐(${name}) — 종전처럼 보류: 업로드 0·삭제 0·표지 없음`, async () => {
    await gate(min);
    const WS = `fs-off-${min ? 'low' : 'none'}`;
    const { count } = await seedWiped(WS, 10, { edited: (i) => i < 3 });
    const f = storage({});
    _setSyncClientForTest(f.client);
    await assert.rejects(() => syncCompany(WS, OWNER, false), /대량 삭제 감지|클라우드 사본이 비어/);
    assert.deepEqual(f.log.uploads, []); assert.deepEqual(f.log.removed, []);
    assert.equal(await count(), 10);
    assert.equal((await stateOf(WS)).epoch, undefined);
    await gate(null);
  });
}

// ② 기기 2대 — 늦게 동기화한 옛 사본 기기 B가 먼저 새로 올려도, 최신 기기 A의 편집·A만 가진 파일이 남는다(wipe2와 같은 장면, 장치 켜짐)
test('② 기기 2대, 옛 사본 기기가 먼저 새로 시작 — A는 합치기(삭제 0): A의 최신 편집이 정본, B의 옛 판은 .conflict, A만 가진 파일 올라감, B도 수렴', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-two';
  const devA = join(ROOT, `${WS}.A`), devB = join(ROOT, `${WS}.B`);
  const old = new Date(Date.now() - 3 * 86400_000), recent = new Date(Date.now() - 60_000);
  const seed = async (files, edits) => {
    const dir = join(ROOT, WS, 'vault', 'notes');
    await mkdir(dir, { recursive: true });
    const base = {};
    for (const [rel, b] of Object.entries(files)) {
      base[rel] = meta(Buffer.from(b));
      const p = join(ROOT, WS, rel);
      await writeFile(p, edits[rel] ?? b);
      await utimes(p, edits[rel] ? recent : old, edits[rel] ? recent : old);
    }
    await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: base, ts: 1 }));
  };
  const files = {}; for (let i = 0; i < 5; i++) files[`vault/notes/n${i}.md`] = `# n${i} v0\n`;
  await seed({ ...files, 'vault/notes/x0.md': '# x0 A만 가진 파일\n' }, { 'vault/notes/n0.md': '# n0 vA\n', 'vault/notes/n1.md': '# n1 vA\n' }); await rename(join(ROOT, WS), devA);
  await seed(files, {}); await rename(join(ROOT, WS), devB);
  const f = storage({}); // 정리된 원격
  const as = async (dev, fn) => { await rename(dev, join(ROOT, WS)); try { return await fn(); } finally { await rename(join(ROOT, WS), dev); } };
  _setSyncClientForTest(f.client);
  const rb = await as(devB, () => syncCompany(WS, OWNER, false));
  assert.equal(rb.pushed, 5, 'B가 먼저 자기 옛 사본으로 새로 시작');
  const epoch = manifestOf(f, WS).epoch;
  assert.ok(epoch);
  _setSyncClientForTest(f.client);
  const ra = await as(devA, () => syncCompany(WS, OWNER, false));
  assert.equal(ra.deletedL, 0, 'A 로컬 삭제 0'); assert.equal(ra.deletedR, 0);
  for (const i of [0, 1]) {
    assert.equal(await readFile(join(devA, 'vault/notes', `n${i}.md`), 'utf8'), `# n${i} vA\n`, `A의 최신 편집 n${i}가 정본으로 남는다`);
    assert.equal(remoteText(f, WS, `vault/notes/n${i}.md`), `# n${i} vA\n`, `원격 n${i}도 A의 편집`);
  }
  const conflicts = (await readdir(join(devA, 'vault/notes'))).filter((x) => x.includes('.conflict-'));
  assert.equal(conflicts.length, 2, 'B의 옛 판 두 개는 .conflict 사본으로 남는다');
  for (const c of conflicts) assert.match(await readFile(join(devA, 'vault/notes', c), 'utf8'), /v0/);
  assert.equal(remoteText(f, WS, 'vault/notes/x0.md'), '# x0 A만 가진 파일\n', 'A만 가진 파일이 올라간다');
  // B의 다음 사이클 — A의 편집을 받고, 아무것도 지우지 않는다
  _setSyncClientForTest(f.client);
  const rb2 = await as(devB, () => syncCompany(WS, OWNER, false));
  assert.equal(rb2.deletedL, 0);
  assert.equal(await readFile(join(devB, 'vault/notes/n0.md'), 'utf8'), '# n0 vA\n', 'B가 A의 편집을 받는다');
  assert.equal(await readFile(join(devB, 'vault/notes/x0.md'), 'utf8'), '# x0 A만 가진 파일\n');
  assert.equal((await readdir(join(devB, 'vault/notes'))).filter((x) => x.endsWith('.md')).length, 8, 'B = n0~n4 + x0 + .conflict 2');
  assert.equal(manifestOf(f, WS).epoch, epoch, '표지는 이어진다');
  await gate(null);
});

// ③ 범위 — 평소 충돌(표지 변화 없음)은 종전처럼 원격 정본, 로컬본이 .conflict(로컬이 더 새것이어도)
test('③ 평소 충돌은 종전 규칙 그대로 — 원격 정본, 로컬본은 .conflict(장치 켜짐·표지 같음·로컬이 더 새것이어도)', async () => {
  await gate(FRESH_START_MIN_APP);
  const WS = 'fs-normal-conflict';
  const dir = join(ROOT, WS, 'vault', 'notes');
  await mkdir(dir, { recursive: true });
  const orig = Buffer.from('# 원본\n'), theirs = Buffer.from('# 다른 기기\n');
  await writeFile(join(dir, 'a.md'), '# 이 기기(더 새것)\n');
  await writeFile(join(ROOT, WS, '.sync-state.json'), JSON.stringify({ files: { 'vault/notes/a.md': meta(orig) }, ts: 1, epoch: 'e1-aaaaaaaa' }));
  const f = storage({
    [`${OWNER}/${WS}/vault/notes/a.md`]: theirs,
    [`${OWNER}/${WS}/__manifest__.json`]: sealSecret(Buffer.from(JSON.stringify({ epoch: 'e1-aaaaaaaa', files: { 'vault/notes/a.md': meta(theirs, 1) } }))),
  });
  _setSyncClientForTest(f.client);
  const r = await syncCompany(WS, OWNER, false);
  assert.equal(r.conflicts, 1);
  assert.equal(await readFile(join(dir, 'a.md'), 'utf8'), '# 다른 기기\n', '평소 충돌은 원격 정본(종전)');
  const c = (await readdir(dir)).find((x) => x.includes('.conflict-'));
  assert.equal(await readFile(join(dir, c), 'utf8'), '# 이 기기(더 새것)\n');
  await gate(null);
});
