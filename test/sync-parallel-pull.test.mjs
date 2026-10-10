// 동기화 받기 동시 실행(2026-10-10) — 원격 신규·원격만 바뀐 파일의 내려받기를 상한 있는 동시 실행으로 앞당기고, 쓰기·판정·집계는 사이클 루프가 종전 순서 그대로 한다.
// 운영 실측(VPS 첫 동기화): 파일마다 한 번에 하나씩 받아 분당 약 65개 — 3,734개 회사가 1시간 가까이 걸렸고 로그에는 아무것도 없어 멈춘 것처럼 보였다.
// 이 파일은 지연을 넣은 가짜 Storage로 (1) 받기 시간이 줄고 (2) 동시 요청이 상한을 넘지 않으며 (3) 실패 하나가 나머지를 막지 않고 분류가 같으며
// (4) 같은 파일을 두 번 받지 않고 (5) 미리 받은 뒤 쓰기 직전의 로컬 변경을 덮지 않으며 (6) 사이클 보류 때 미리 받기가 멈추는 것을 잠근다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-sync-par-'));
process.env.ARGO_ROOT = ROOT;
process.env.ARGO_SYNC = '1';
delete process.env.ARGO_SYNC_ALLOW_MASS_DELETE;

const syncMod = await import('../src/sync.mjs');
const { syncCompany, _setSyncClientForTest } = syncMod;
const CAP = syncMod.PULL_CONCURRENCY ?? 8;
const AHEAD = syncMod.PULL_AHEAD_MAX ?? 16;
const { ensureAccountKey } = await import('../src/accountkey.mjs');
const { sealSecret, openSecretCompat } = await import('../src/secretbox.mjs');
const fakeKeySb = (b64) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { key_b64: b64 }, error: null }) }) }) }) });
await ensureAccountKey(fakeKeySb(Buffer.alloc(32, 9).toString('base64')), 'owner-sync-parallel');

const OWNER = 'o';
const hashBuf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16);
const meta = (buf, m = 1000) => ({ m, s: buf.length, h: hashBuf(buf) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thread = (...texts) => Buffer.from(JSON.stringify({ sessionId: null, messages: texts.map((text, i) => ({ who: 'user', text, ts: 1 + i })) }));

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

/** 지연을 넣은 가짜 Storage — 키별 GET 수·동시 요청 최대치를 센다. fail(key) = 그 키에 돌려줄 오류(없으면 정상). */
function slowStorage(initial, { latency = 30, fail = () => null, onDownload = null, onUpload = null } = {}) {
  const store = new Map(Object.entries(initial));
  const gets = new Map();
  const done = new Set(); // 응답을 돌려준 키
  const s = { inflight: 0, maxInflight: 0, gets, done, store };
  const bucket = {
    async download(key) {
      gets.set(key, (gets.get(key) ?? 0) + 1);
      s.inflight++; s.maxInflight = Math.max(s.maxInflight, s.inflight);
      try {
        await sleep(latency);
        await onDownload?.(key);
        const err = fail(key);
        if (err) return { data: null, error: err };
        if (!store.has(key)) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
        const buf = store.get(key);
        return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
      } finally { s.inflight--; done.add(key); }
    },
    async upload(key, blob) { await onUpload?.(key); store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [] }; },
  };
  s.client = { storage: { from: () => bucket } };
  return s;
}

/** 회사 하나 — 로컬 파일·base·원격(매니페스트 + 봉투 blob). */
async function setup(wsId, { local = {}, state = {}, remote = {}, blobs = {}, latency, fail, onDownload, onUpload }) {
  const wsRoot = join(ROOT, wsId);
  await mkdir(wsRoot, { recursive: true });
  for (const [rel, buf] of Object.entries(local)) {
    const full = join(wsRoot, ...rel.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, buf);
  }
  if (Object.keys(state).length) await writeFile(join(wsRoot, '.sync-state.json'), JSON.stringify({ files: state, ts: 1000 }));
  const init = { [`${OWNER}/${wsId}/__manifest__.json`]: Buffer.from(JSON.stringify({ files: remote })) };
  for (const [rel, buf] of Object.entries(blobs)) init[`${OWNER}/${wsId}/${rel}`] = sealSecret(buf);
  const st = slowStorage(init, { latency, fail, onDownload, onUpload });
  _setSyncClientForTest(st.client);
  return { wsRoot, st };
}
const manyRemote = (n, prefix = 'vault/notes/n', tag = 'r') => {
  const remote = {}, blobs = {};
  for (let i = 0; i < n; i++) {
    const rel = `${prefix}${i}.md`;
    const b = Buffer.from(`# ${tag} ${i}\n`);
    remote[rel] = meta(b, 2000 + i); blobs[rel] = b;
  }
  return { remote, blobs };
};
const fileGets = (st, ws) => [...st.gets].filter(([k]) => !k.endsWith('__manifest__.json') && k.startsWith(`${OWNER}/${ws}/`));

test('새 기기 첫 동기화 — 원격 파일 80개를 동시에(상한 안에서) 받고, 파일마다 GET 1, state는 받은 파일 전부', async () => {
  const ws = 'par-first';
  // 시간은 단언하지 않는다(Windows 러너 디스크가 느려 여유가 흔들린다 — 분리 검수 LOW). 동시 수·GET 수로 본다. 시간 비교는 PR의 벤치 숫자로.
  const N = 80, LAT = 40;
  const { remote, blobs } = manyRemote(N);
  const { wsRoot, st } = await setup(ws, { remote, blobs, latency: LAT });
  const r = await syncCompany(ws, OWNER, true, {});
  assert.equal(r.pulled, N); assert.equal(r.failed, 0);
  for (const [rel, b] of Object.entries(blobs)) assert.equal(await readFile(join(wsRoot, ...rel.split('/')), 'utf8'), b.toString(), rel);
  assert.ok(st.maxInflight > 1, `받기가 동시에 일어나야 한다(최대 동시 ${st.maxInflight})`);
  assert.ok(st.maxInflight <= CAP, `동시 요청 상한 ${CAP}을 넘으면 안 된다(최대 동시 ${st.maxInflight})`);
  const gets = fileGets(st, ws);
  assert.equal(gets.length, N); assert.ok(gets.every(([, c]) => c === 1), '같은 파일을 두 번 받지 않는다');
  const state = JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8')).files;
  assert.deepEqual(Object.keys(state).sort(), Object.keys(remote).sort(), 'state는 받은 파일 전부를 원격 메타로 기록');
  for (const rel of Object.keys(remote)) assert.deepEqual(state[rel], remote[rel]);
});

test('원격만 바뀐 파일 60개도 동시에 받는다 — 판정·카운터는 종전과 같다(받기 60, 밀기 0)', async () => {
  const ws = 'par-changed';
  const local = {}, state = {}, remote = {}, blobs = {};
  for (let i = 0; i < 60; i++) {
    const rel = `vault/notes/c${i}.md`, old = Buffer.from(`old ${i}`), neu = Buffer.from(`new ${i}`);
    local[rel] = old; state[rel] = meta(old); remote[rel] = meta(neu, 3000 + i); blobs[rel] = neu;
  }
  const { wsRoot, st } = await setup(ws, { local, state, remote, blobs, latency: 30 });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.pulled, 60); assert.equal(r.pushed, 0); assert.equal(r.failed, 0); assert.equal(r.conflicts, 0);
  for (let i = 0; i < 60; i++) assert.equal(await readFile(join(wsRoot, 'vault', 'notes', `c${i}.md`), 'utf8'), `new ${i}`);
  assert.ok(st.maxInflight > 1 && st.maxInflight <= CAP, `최대 동시 ${st.maxInflight}`);
  assert.ok(fileGets(st, ws).every(([, c]) => c === 1));
});

test('실패 하나가 나머지를 막지 않는다 — 5xx·만료 토큰(Bucket not found)은 그 파일만 실패, Object not found는 건너뜀(종전 분류), 나머지는 받는다', async () => {
  const ws = 'par-fail';
  const { remote, blobs } = manyRemote(40);
  const k = (i) => `${OWNER}/${ws}/vault/notes/n${i}.md`;
  const fail = (key) => (key === k(5) ? { message: 'Internal Server Error', statusCode: '500' }
    : key === k(10) ? { message: 'Bucket not found', statusCode: '404' } // 만료 토큰 GET — Storage가 익명으로 처리(2026-10-05 운영 실측)
      : key === k(15) ? { message: 'Object not found', statusCode: '404' } : null);
  const { wsRoot, st } = await setup(ws, { remote, blobs, latency: 20, fail });
  const r = await syncCompany(ws, OWNER, true, {});
  assert.equal(r.pulled, 37);
  assert.equal(r.failed, 2, '5xx·만료 토큰은 실패');
  assert.equal(r.missing, 1, '진짜 객체 없음만 건너뜀');
  assert.deepEqual(r.missingRels, ['vault/notes/n15.md']);
  assert.deepEqual(r.failures.map((f) => f.rel).sort(), ['vault/notes/n10.md', 'vault/notes/n5.md']);
  assert.match(r.failures.find((f) => f.rel.endsWith('n10.md')).reason, /Bucket not found/);
  for (const i of [5, 10, 15]) assert.equal(existsSync(join(wsRoot, 'vault', 'notes', `n${i}.md`)), false, `n${i}는 받지 못했다`);
  const state = JSON.parse(await readFile(join(wsRoot, '.sync-state.json'), 'utf8')).files;
  for (const i of [5, 10, 15]) assert.equal(state[`vault/notes/n${i}.md`], undefined, '받지 못한 파일은 base에 넣지 않는다(다음 사이클이 다시 받는다)');
  assert.equal(Object.keys(state).length, 37);
  assert.ok(st.maxInflight > 1, '실패가 섞여도 나머지는 동시에 받는다');
  assert.ok(fileGets(st, ws).every(([, c]) => c === 1));
});

test('같은 파일을 두 번 받지 않는다 — 신규·원격 변경·충돌(md·스레드·원장·json)·밀기·삭제가 섞인 사이클도 파일 키마다 GET 최대 1', async () => {
  const ws = 'par-mix';
  const local = {}, state = {}, remote = {}, blobs = {};
  const put = (rel, { l, base, r }) => { if (l) local[rel] = l; if (base) state[rel] = meta(base); if (r) { remote[rel] = meta(r, 5000); blobs[rel] = r; } };
  for (let i = 0; i < 20; i++) put(`vault/notes/new${i}.md`, { r: Buffer.from(`new ${i}`) });
  for (let i = 0; i < 10; i++) put(`vault/notes/chg${i}.md`, { l: Buffer.from(`a${i}`), base: Buffer.from(`a${i}`), r: Buffer.from(`b${i}`) });
  put('vault/notes/both.md', { l: Buffer.from('mine'), base: Buffer.from('base'), r: Buffer.from('theirs') });
  put('chats/t.json', { l: thread('x', 'mine'), base: thread('x'), r: thread('x', 'theirs') });
  put('usage.jsonl', { l: Buffer.from('a\nmine\n'), base: Buffer.from('a\n'), r: Buffer.from('a\ntheirs\n') });
  put('settings.json', { l: Buffer.from('{"v":1}'), base: Buffer.from('{"v":0}'), r: Buffer.from('{"v":2}') });
  put('vault/notes/push.md', { l: Buffer.from('local only') });
  put('vault/notes/gone.md', { l: Buffer.from('same'), base: Buffer.from('same') }); // 다른 기기가 지움(blob 없음)
  // 미리 받기 대상이 아닌 '로컬에 없음' 분기 셋(분리 검수 MEDIUM-2 — 대상 조건에서 !base를 빼도 시험이 통과하던 빈틈):
  put('vault/notes/revive.md', { base: Buffer.from('예전'), r: Buffer.from('다른 기기가 고침') }); // 내가 지웠는데 원격이 바뀜 → 되살리기(루프가 직접 GET 1)
  put('vault/notes/delprop.md', { base: Buffer.from('그대로'), r: Buffer.from('그대로') }); // 내가 지움·원격 그대로 → 원격 삭제 전파(GET 0)
  put('vault/notes/healme.md', { base: Buffer.from('정상본'), r: Buffer.from('정상본') }); // 로컬 손상(.corrupt- 백업) → 원격으로 자가 치유(루프가 직접 GET 1)
  local['vault/notes/healme.md.corrupt-111'] = Buffer.from('{ broken');
  const { wsRoot, st } = await setup(ws, { local, state, remote, blobs, latency: 15 });
  const r = await syncCompany(ws, OWNER);
  assert.equal(r.failed, 0);
  assert.equal(r.deletedL, 1, '다른 기기가 지운 파일은 로컬에서도 지운다(매니페스트 재확인 뒤)');
  assert.equal(r.deletedR, 1, '내가 지운 파일은 원격에서도 지운다');
  assert.equal(r.merged, 2, '스레드·원장 병합');
  assert.ok(r.pulled >= 30);
  const g = (rel) => st.gets.get(`${OWNER}/${ws}/${rel}`) ?? 0;
  assert.equal(g('vault/notes/revive.md'), 1, '되살리기는 정확히 GET 1');
  assert.equal(g('vault/notes/delprop.md'), 0, '삭제 전파는 받지 않는다(GET 0)');
  assert.equal(g('vault/notes/healme.md'), 1, '자가 치유는 정확히 GET 1');
  assert.equal(await readFile(join(wsRoot, 'vault', 'notes', 'revive.md'), 'utf8'), '다른 기기가 고침');
  assert.equal(await readFile(join(wsRoot, 'vault', 'notes', 'healme.md'), 'utf8'), '정상본');
  const over = fileGets(st, ws).filter(([, c]) => c > 1);
  assert.deepEqual(over, [], '파일 키마다 GET 최대 1');
  assert.ok(existsSync(join(wsRoot, 'vault', 'notes', 'new19.md')));
  assert.equal(await readFile(join(wsRoot, 'vault', 'notes', 'chg9.md'), 'utf8'), 'b9');
  const conflicts = (await readdir(join(wsRoot, 'vault', 'notes'))).filter((n) => n.startsWith('both.conflict-'));
  assert.equal(conflicts.length, 1, '텍스트 충돌은 로컬본을 사본으로 남긴다');
});

/** 루프 순서에서 밀기(로컬 전용 파일)가 먼저 오고, 그 업로드 사이에 — 대상 파일을 미리 받아 둔 뒤 — 다른 프로세스(CLI)가 대상 파일을 쓴다. */
const editAfterPrefetch = (getSt, ws, rel, pushRel, write) => async (key) => {
  if (!key.endsWith(`/${pushRel}`)) return;
  const st = getSt();
  for (let i = 0; i < 50 && !st.done.has(`${OWNER}/${ws}/${rel}`); i++) await sleep(10);
  st.downloadedBeforeEdit = st.done.has(`${OWNER}/${ws}/${rel}`);
  await write();
};

test('미리 받은 원격 신규 스레드 — 쓰기 직전에 CLI가 같은 대화를 만들었으면 덮지 않고 미룬다, 다음 사이클이 병합한다', async () => {
  const ws = 'par-recheck-new';
  const rel = 'chats/pepper.json', f = join(ROOT, ws, 'chats', 'pepper.json');
  const remoteT = thread('다른 기기 답');
  let st;
  // 로컬 키가 원격 키보다 먼저 돈다(allRels 순서) — 로컬 전용 파일 하나뿐이라 밀기가 반드시 스레드보다 먼저다
  const onUpload = editAfterPrefetch(() => st, ws, rel, 'a-push.md', async () => { await mkdir(join(ROOT, ws, 'chats'), { recursive: true }); await writeFile(f, thread('CLI가 쓴 지시')); });
  ({ st } = await setup(ws, { local: { 'a-push.md': Buffer.from('local only') }, remote: { [rel]: meta(remoteT, 2000) }, blobs: { [rel]: remoteT }, latency: 10, onUpload }));
  const r1 = await syncCompany(ws, OWNER);
  assert.ok(st.downloadedBeforeEdit, '스레드를 미리 받은 뒤에 로컬이 바뀐 상황이어야 이 시험의 뜻이 있다');
  const texts = async () => JSON.parse(await readFile(f, 'utf8')).messages.map((m) => m.text);
  assert.deepEqual(await texts(), ['CLI가 쓴 지시'], 'CLI가 쓴 대화를 미리 받은 원격본으로 덮으면 안 된다');
  assert.equal(r1.deferred, 1); assert.equal(r1.failed, 0); assert.equal(r1.pulled, 0); assert.equal(r1.pushed, 1);
  const r2 = await syncCompany(ws, OWNER);
  assert.equal(r2.merged, 1);
  for (const t of ['다른 기기 답', 'CLI가 쓴 지시']) assert.ok((await texts()).includes(t), t);
});

test('미리 받은 원격 변경 결재 파일(approvals.json) — 쓰기 직전에 CLI가 결재를 올렸으면 덮지 않고 미룬다', async () => {
  const ws = 'par-recheck-chg';
  const rel = 'approvals.json';
  const base = Buffer.from('[]'), remoteA = Buffer.from(JSON.stringify([{ id: 'ap-remote' }]));
  // 둘 다 로컬 파일이라 순서는 walk(readdir) 순서다 — 밀기 파일이 approvals.json보다 먼저 읽히는 이름을 고른다(파일 시스템마다 순서가 달라서)
  // (setup과 같은 순서로 만든다 — 밀기 파일 먼저, 그다음 approvals.json. 작은 폴더를 만든 순서대로 읽는 파일 시스템도 있다)
  let pushRel = null;
  for (const [i, name] of ['0-push.md', 'a0-push.md', 'aa.md', 'push.md', 'b.md', 'zz.md', 'm1.md', 'q7.md', 'x3.md', 'c9.md'].entries()) {
    const probe = join(ROOT, `${ws}-order-${i}`);
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, name), 'x');
    await writeFile(join(probe, rel), '[]');
    const order = await readdir(probe);
    if (order.indexOf(name) < order.indexOf(rel)) { pushRel = name; break; }
  }
  assert.ok(pushRel, 'approvals.json보다 먼저 읽히는 이름이 있어야 한다');
  let st;
  const onUpload = editAfterPrefetch(() => st, ws, rel, pushRel, () => writeFile(join(ROOT, ws, rel), JSON.stringify([{ id: 'ap-cli' }])));
  ({ st } = await setup(ws, { local: { [pushRel]: Buffer.from('local only'), [rel]: base }, state: { [rel]: meta(base) }, remote: { [rel]: meta(remoteA, 2000) }, blobs: { [rel]: remoteA }, latency: 10, onUpload }));
  const r = await syncCompany(ws, OWNER);
  assert.ok(st.downloadedBeforeEdit, 'approvals.json을 미리 받은 뒤에 로컬이 바뀐 상황이어야 이 시험의 뜻이 있다');
  assert.deepEqual(JSON.parse(await readFile(join(ROOT, ws, rel), 'utf8')).map((a) => a.id), ['ap-cli'], 'CLI가 올린 결재가 미리 받은 원격본에 덮이면 안 된다');
  assert.equal(r.deferred, 1); assert.equal(r.failed, 0); assert.equal(r.pulled, 0);
});

test('사이클 보류(로컬 삭제 전 매니페스트 재확인 실패) — 로컬 삭제 0·받은 파일 쓰기 0, 미리 받기는 멈추고 돌아온 뒤 진행 중인 요청이 없다', async () => {
  const ws = 'par-hold';
  const { remote, blobs } = manyRemote(80, 'z/n');
  const keep = Buffer.from('keep me');
  let manifestReads = 0;
  const fail = (key) => (key.endsWith('__manifest__.json') && ++manifestReads >= 2 ? { message: 'fetch failed', statusCode: '500' } : null);
  const { wsRoot, st } = await setup(ws, {
    local: { 'a/keep.md': keep }, state: { 'a/keep.md': meta(keep) }, // 원격 항목·blob 없음 = 다른 기기가 지움 → 로컬 삭제 후보(루프 첫 항목)
    remote, blobs, latency: 20, fail,
  });
  await assert.rejects(syncCompany(ws, OWNER), /매니페스트 재확인 실패/);
  assert.equal(st.inflight, 0, '보류로 돌아온 뒤 진행 중인 받기가 남지 않는다');
  assert.equal(await readFile(join(wsRoot, 'a', 'keep.md'), 'utf8'), 'keep me', '로컬 삭제 0');
  assert.equal(existsSync(join(wsRoot, 'z')), false, '보류된 사이클은 받은 파일을 쓰지 않는다');
  const pulledGets = fileGets(st, ws).filter(([k]) => k.includes('/z/')).length;
  assert.ok(pulledGets <= AHEAD, `미리 받기는 앞서 받기 상한(${AHEAD}) 안에서 멈춘다 — ${pulledGets}건`);
  const after = st.gets.size;
  await sleep(100);
  assert.equal(st.gets.size, after, '돌아온 뒤 새 요청이 생기지 않는다');
  assert.equal(unhandled, 0, '버린 미리 받기 결과가 처리 안 된 거부로 새지 않는다');
});

test('받을 것이 많으면 진행을 몇십 초에 한 번 로그로 남긴다 — 시작·끝 줄, 파일마다 찍지 않는다', async () => {
  const ws = 'par-log';
  const { remote, blobs } = manyRemote(150);
  await setup(ws, { remote, blobs, latency: 2 });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await syncCompany(ws, OWNER, true, {}); } finally { console.log = orig; }
  const mine = lines.filter((l) => l.includes(`동기화(${ws})`));
  assert.ok(mine.some((l) => /파일 150개 받는 중 \(0\/150 — 받음 0 · 실패 0 · 없음 0\)/.test(l)), `시작 줄 — ${mine.join(' / ')}`);
  assert.ok(mine.some((l) => /파일 150개 받기 끝 — 받음 150 · 실패 0 · 없음 0/.test(l)), `끝 줄 — ${mine.join(' / ')}`);
  assert.ok(mine.length <= 4, `파일마다 찍지 않는다 — ${mine.length}줄`);
});

/** console.log·warn을 모아 이 회사 줄만 돌려준다 */
const captureLines = async (ws, fn) => {
  const lines = [], ol = console.log, ow = console.warn;
  console.log = (...a) => { lines.push(a.join(' ')); }; console.warn = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = ol; console.warn = ow; }
  return lines.filter((l) => l.includes(`동기화(${ws})`));
};

test('객체 없는 항목 150개 — 첫 사이클은 실제로 받으러 가서 "없음 150"으로 끝나고, 다음 사이클은(1시간 기억) GET 0·진행 로그 0줄', async () => {
  const ws = 'par-log-missing';
  const { remote } = manyRemote(150); // 매니페스트에만 있고 blob은 없다
  const { st } = await setup(ws, { remote, blobs: {}, latency: 1 });
  const first = await captureLines(ws, () => syncCompany(ws, OWNER, true, {}));
  assert.ok(first.some((l) => /받기 끝 — 받음 0 · 실패 0 · 없음 150/.test(l)), first.join(' / '));
  const gets1 = fileGets(st, ws).length;
  const again = await captureLines(ws, async () => { const r = await syncCompany(ws, OWNER, false, {}); assert.equal(r.missing, 150); });
  assert.equal(again.filter((l) => /받는 중|받기 끝/.test(l)).length, 0, `받으러 가지 않는 사이클에 "150개 받는 중"을 찍지 않는다 — ${again.join(' / ')}`);
  assert.equal(fileGets(st, ws).length, gets1, '다음 사이클 GET 0');
});

test('만료 토큰으로 전부 실패 — 끝 줄이 받은 것처럼 보이지 않는다("받음 0 · 실패 120")', async () => {
  const ws = 'par-log-expired';
  const { remote, blobs } = manyRemote(120);
  await setup(ws, { remote, blobs, latency: 1, fail: (key) => (key.endsWith('__manifest__.json') ? null : { message: 'Bucket not found', statusCode: '404' }) });
  let r;
  const lines = await captureLines(ws, async () => { r = await syncCompany(ws, OWNER, true, {}); });
  assert.equal(r.failed, 120); assert.equal(r.pulled, 0);
  assert.ok(lines.some((l) => /받기 끝 — 받음 0 · 실패 120 · 없음 0/.test(l)), lines.join(' / '));
});

/** 회선을 나눠 쓰는 가짜 Storage(분리 검수 HIGH-1 재현 모형) — 받는 중인 요청들이 대역폭(bytesPerMs)을 똑같이 나누고, 요청마다 timeoutMs가 지나면
    본문을 받는 중이어도 시간 초과로 던진다(클라이언트 30초 AbortSignal.timeout과 같은 모양 — .blob()이 던지는 DOMException TimeoutError).
    전송 시간은 매니페스트에 적힌 크기(sizes)로 센다. 멈추기 신호(signal)를 받으면 그 요청을 회선에서 뺀다. */
function bandwidthStorage(initial, sizes, { bytesPerMs, timeoutMs }) {
  const store = new Map(Object.entries(initial));
  const active = new Set();
  const s = { gets: new Map(), maxInflight: 0, timeouts: 0, store };
  let timer = null, last = 0;
  const tick = () => {
    const now = performance.now(), dt = now - last; last = now;
    if (active.size) { const share = (bytesPerMs * dt) / active.size; for (const a of [...active]) { a.left -= share; if (a.left <= 0) { active.delete(a); a.resolve(); } } }
    for (const a of [...active]) if (now - a.start >= timeoutMs) { active.delete(a); s.timeouts++; a.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')); }
    if (!active.size && timer) { clearInterval(timer); timer = null; }
  };
  const bucket = {
    async download(key, _opts, params) {
      s.gets.set(key, (s.gets.get(key) ?? 0) + 1);
      const size = sizes.get(key) ?? 0;
      if (size > 0) {
        await new Promise((resolve, reject) => {
          if (timer) tick(); else last = performance.now();
          const a = { left: size, start: performance.now(), resolve, reject };
          active.add(a); s.maxInflight = Math.max(s.maxInflight, active.size);
          params?.signal?.addEventListener('abort', () => { if (active.delete(a)) reject(new DOMException('This operation was aborted', 'AbortError')); }, { once: true });
          if (!timer) timer = setInterval(tick, 5);
        });
      }
      if (!store.has(key)) return { data: null, error: { message: 'Object not found', statusCode: '404' } };
      const buf = store.get(key);
      return { data: { arrayBuffer: async () => new Uint8Array(buf).buffer }, error: null };
    },
    async upload(key, blob) { store.set(key, Buffer.from(await blob.arrayBuffer())); return { error: null }; },
    async remove(keys) { for (const k of keys) store.delete(k); return { error: null }; },
    async list() { return { data: [] }; },
  };
  s.bucket = bucket; s.client = { storage: { from: () => bucket } };
  return s;
}
/** 매니페스트에 큰 크기를 적은 원격 파일 n개(내용은 작다 — 전송 시간만 크기로 흉내) */
const declaredRemote = (ws, n, declared, prefix) => {
  const remote = {}, init = {}, sizes = new Map();
  for (let i = 0; i < n; i++) {
    const rel = `${prefix}${i}.md`, b = Buffer.from(`# ${prefix} ${i}\n`);
    remote[rel] = { m: 2000 + i, s: declared, h: createHash('sha1').update(b).digest('hex').slice(0, 16) };
    init[`${OWNER}/${ws}/${rel}`] = sealSecret(b); sizes.set(`${OWNER}/${ws}/${rel}`, declared);
  }
  return { remote, init, sizes };
};
const MiBms = 2 ** 20 / 1000; // 1MiB/s

test('느린 회선 — 512KB보다 큰 파일은 혼자 받는다: 하나씩이면 시간 안에 받는 파일을 여럿이 나눠 받다 시간 초과로 잃지 않는다', async () => {
  const ws = 'par-slow-big';
  const { remote, init, sizes } = declaredRemote(ws, 4, 700 * 1024, 'big/f'); // 1MiB/s에서 하나 약 0.68초 < 제한 0.9초. 넷이 나누면 2.7초
  init[`${OWNER}/${ws}/__manifest__.json`] = Buffer.from(JSON.stringify({ files: remote }));
  const st = bandwidthStorage(init, sizes, { bytesPerMs: MiBms, timeoutMs: 900 });
  await mkdir(join(ROOT, ws), { recursive: true });
  _setSyncClientForTest(st.client);
  const r = await syncCompany(ws, OWNER, true, {});
  assert.equal(r.failed, 0, `종전(하나씩)이 받는 파일은 새 코드도 받는다 — 시간 초과 ${st.timeouts}`);
  assert.equal(r.pulled, 4); assert.equal(st.timeouts, 0); assert.equal(st.maxInflight, 1, '큰 파일은 혼자');
});

test('느린 회선 — 작은 파일을 함께 받다 시간 초과가 나면 하나씩으로 바꿔 이 사이클 안에 모두 받고, 다음 사이클도 하나씩으로 시작한다', async () => {
  const ws = 'par-slow-small';
  const decl = 120 * 1024; // 1MiB/s에서 하나 약 0.12초 < 제한 0.4초. 8개(960KB, 받는 중 크기 상한 1MB 안)가 나누면 0.94초 → 모두 시간 초과
  const { remote, init, sizes } = declaredRemote(ws, 8, decl, 'small/f');
  init[`${OWNER}/${ws}/__manifest__.json`] = Buffer.from(JSON.stringify({ files: remote }));
  // 대조 — 종전처럼 하나씩 받으면 모두 시간 안이다(이 상황에서 배포본은 8개를 다 받는다)
  const ctl = bandwidthStorage(init, sizes, { bytesPerMs: MiBms, timeoutMs: 400 });
  for (const key of sizes.keys()) await ctl.bucket.download(key);
  assert.equal(ctl.timeouts, 0, '하나씩이면 시간 초과 없음');
  const st = bandwidthStorage(init, sizes, { bytesPerMs: MiBms, timeoutMs: 400 });
  await mkdir(join(ROOT, ws), { recursive: true });
  _setSyncClientForTest(st.client);
  let r;
  const lines = await captureLines(ws, async () => { r = await syncCompany(ws, OWNER, true, {}); });
  assert.equal(r.failed, 0, '이 사이클 안에서 모두 받는다'); assert.equal(r.pulled, 8);
  assert.ok(st.timeouts >= 1, '이 시험은 실제로 시간 초과를 만들어야 뜻이 있다');
  for (const key of sizes.keys()) assert.ok((st.gets.get(key) ?? 0) <= 2, `${key}: 시간 초과 뒤 다시 받기는 한 번뿐`);
  assert.ok(lines.some((l) => /시간 초과 — 이 회사는 \d+분 동안 하나씩 받습니다/.test(l)), lines.join(' / '));
  // 다음 사이클 — 새로 생긴 원격 파일도 하나씩(동시 1)으로 받는다
  const more = declaredRemote(ws, 6, decl, 'small/g');
  st.store.set(`${OWNER}/${ws}/__manifest__.json`, Buffer.from(JSON.stringify({ files: { ...remote, ...more.remote } })));
  for (const [k, v] of Object.entries(more.init)) st.store.set(k, v);
  for (const [k, v] of more.sizes) sizes.set(k, v);
  st.maxInflight = 0; st.timeouts = 0;
  const r2 = await syncCompany(ws, OWNER, false, {});
  assert.equal(r2.pulled, 6); assert.equal(r2.failed, 0); assert.equal(st.maxInflight, 1, '기억한 회사는 하나씩 받는다'); assert.equal(st.timeouts, 0);
});

test('받을 것이 적으면 진행 로그를 남기지 않는다(평소 8초 사이클)', async () => {
  const ws = 'par-quiet';
  const { remote, blobs } = manyRemote(5);
  await setup(ws, { remote, blobs, latency: 1 });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await syncCompany(ws, OWNER, true, {}); } finally { console.log = orig; }
  assert.equal(lines.filter((l) => l.includes('받는 중')).length, 0);
});

test('못 읽은 로컬 폴더(walk 실패) 아래의 원격 신규는 종전처럼 받지 않는다 — 미리 받기도 GET 0', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX 권한 비트 필요' }, async () => {
  const ws = 'par-walkfail';
  const { remote, blobs } = manyRemote(6, 'locked/n');
  const more = manyRemote(6, 'open/n');
  const { wsRoot, st } = await setup(ws, { local: { 'locked/.keep': Buffer.from('') }, remote: { ...remote, ...more.remote }, blobs: { ...blobs, ...more.blobs }, latency: 5 });
  const { chmod } = await import('node:fs/promises');
  await chmod(join(wsRoot, 'locked'), 0o000);
  try {
    const r = await syncCompany(ws, OWNER);
    assert.equal(r.pulled, 6, '읽을 수 있는 쪽만 받는다');
    assert.equal(fileGets(st, ws).filter(([k]) => k.includes('/locked/')).length, 0, '못 읽은 폴더 아래는 받으러 가지도 않는다');
  } finally { await chmod(join(wsRoot, 'locked'), 0o755); }
  assert.equal(existsSync(join(wsRoot, 'locked', 'n0.md')), false);
});

test('미리 받은 봉투는 그 파일의 차례에 연다 — 사이클 도중 열쇠가 바뀌거나 도착해도 종전처럼 그 뒤 차례 파일은 새 열쇠로 열린다(분리 검수 26번)', async () => {
  const ws = 'par-keylate';
  const { ensureAccountKey: ensureKey, clearAccountKey } = await import('../src/accountkey.mjs');
  const K1 = Buffer.alloc(32, 9).toString('base64'), K2 = Buffer.alloc(32, 7).toString('base64');
  const useKey = async (b64, owner) => { clearAccountKey(); await ensureKey(fakeKeySb(b64), owner); };
  try {
    await useKey(K2, 'owner-k2'); // 원격 blob은 K2로 봉인돼 있다
    const remote = {}, init = {};
    for (let i = 0; i < 6; i++) { const rel = `late/n${i}.md`, b = Buffer.from(`late ${i}`); remote[rel] = meta(b, 2000 + i); init[`${OWNER}/${ws}/${rel}`] = sealSecret(b); }
    await useKey(K1, 'owner-sync-parallel'); // 사이클은 K1로 시작한다(평문 매니페스트는 어느 열쇠로도 읽힌다)
    init[`${OWNER}/${ws}/__manifest__.json`] = Buffer.from(JSON.stringify({ files: remote }));
    let st;
    // 루프 첫 항목(로컬 전용 밀기)을 올리는 사이 — 원격 파일은 이미 미리 받아 둔 뒤 — 열쇠가 K2로 바뀐다(사이클 도중 열쇠 도착과 같은 모양)
    const onUpload = async (key) => {
      if (!key.endsWith('/a-push.md')) return;
      for (let i = 0; i < 50 && ![...st.done].some((k) => k.endsWith('late/n5.md')); i++) await sleep(10);
      st.allDownloadedBeforeKey = [...st.done].filter((k) => k.includes('/late/')).length === 6;
      await useKey(K2, 'owner-k2');
    };
    ({ st } = await setup(ws, { local: { 'a-push.md': Buffer.from('local only') }, latency: 5, onUpload }));
    for (const [k, v] of Object.entries(init)) st.store.set(k, v);
    const r = await syncCompany(ws, OWNER);
    assert.ok(st.allDownloadedBeforeKey, '원격 파일을 모두 미리 받은 뒤에 열쇠가 바뀐 상황이어야 이 시험의 뜻이 있다');
    assert.equal(r.failed, 0, '미리 받은 봉투를 받을 때 열었다면(옛 열쇠) 6개 모두 실패했다');
    assert.equal(r.pulled, 6);
    assert.equal(await readFile(join(ROOT, ws, 'late', 'n3.md'), 'utf8'), 'late 3');
  } finally { await useKey(K1, 'owner-sync-parallel'); }
});

test('봉투 blob을 받아 평문으로 쓴다 — 미리 받기도 같은 개봉(pullBuf)을 거친다', async () => {
  const ws = 'par-seal';
  const { remote, blobs } = manyRemote(12);
  const { wsRoot, st } = await setup(ws, { remote, blobs, latency: 5 });
  await syncCompany(ws, OWNER, true, {});
  const key = `${OWNER}/${ws}/vault/notes/n3.md`;
  assert.notEqual(st.store.get(key).toString(), '# r 3\n', '원격은 봉투');
  assert.equal(openSecretCompat(st.store.get(key)).toString(), '# r 3\n');
  assert.equal(await readFile(join(wsRoot, 'vault', 'notes', 'n3.md'), 'utf8'), '# r 3\n', '로컬은 평문');
});
