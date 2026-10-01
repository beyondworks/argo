// 앱 사이드카와 argo CLI가 같은 데이터 폴더의 JSON 파일을 동시에 고칠 때 한 쪽 변경이 사라지지 않는다 — 반대 검토 M-b(2026-10-01).
// withLock은 한 프로세스 안의 순서만 맞춘다(mutex.mjs). 대화·결재·크루 카드·company.json·교정·루틴·연결은 읽고-고쳐-쓰기라
// 두 프로세스가 겹치면 늦게 쓴 쪽이 먼저 쓴 쪽의 변경을 덮는다. 앱과 CLI가 앱 데이터 폴더를 같이 쓰게 되기 전에 막아야 한다.
// 이 파일의 테스트는 실제 모듈 함수를 **두 자식 프로세스**에서 같은 순간에 반복 호출하고, 끝난 파일에 두 프로세스의 변경이 모두 있는지 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';
import { childEnv, srcUrl } from './helpers/sync-child.mjs';

const WS = 'co-xlock';
const N = 40; // 프로세스당 반복 수

async function seed() {
  const root = await mkdtemp(join(tmpdir(), 'argo-xlock-'));
  mkdirSync(join(root, WS, 'chats'), { recursive: true });
  mkdirSync(join(root, WS, 'agents'), { recursive: true });
  writeFileSync(join(root, WS, 'company.json'), JSON.stringify({ id: WS, name: 'Fixture', ownerId: null, counter: 0, tags: [] }));
  writeFileSync(join(root, WS, 'agents', 'pepper.md'), '---\nname: Pepper\nrole: tester\n---\n\n# Pepper\n');
  writeFileSync(join(root, '.device-id'), 'fixture-device');
  return root;
}

/** 두 자식이 startAt에 동시에 출발해 body를 실행한다. body 안에서 id = 'a' | 'b', m = 모듈 묶음. */
function runPair(root, body) {
  const startAt = Date.now() + 1500;
  const one = (id) => new Promise((resolve, reject) => {
    const script = `
const m = {};
for (const n of ['thread','approvals','workspace','persona','corrections','routines','connections','scheduler','room']) m[n] = await import(${JSON.stringify(srcUrl(''))} + n + '.mjs');
await new Promise((r) => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
const id = ${JSON.stringify(id)}; const WS = ${JSON.stringify(WS)}; const N = ${N};
${body}
process.exit(0);`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', script], { env: childEnv(root), stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (c) => { err += c; });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`child ${id} timeout\n${err.slice(-1500)}`)); }, 100_000);
    p.on('exit', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`child ${id} exit ${code}\n${err.slice(-1500)}`)); });
  });
  return Promise.all([one('a'), one('b')]);
}
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const lockDirs = (dir) => readdirSync(dir).filter((n) => /\.lockd(\.reclaim)?$/.test(n));

test('대화 — 두 프로세스가 같은 크루 스레드에 턴을 쌓아도 한 줄도 사라지지 않는다(beginTurn·appendTurn)', { timeout: 120_000 }, async () => {
  const root = await seed();
  await runPair(root, `
for (let i = 0; i < N; i++) {
  const turnId = await m.thread.beginTurn(WS, 'pepper', { userMsg: id + i });
  await m.thread.appendTurn(WS, 'pepper', { turnId, userMsg: id + i, reply: 'r-' + id + i });
}`);
  const t = readJson(join(root, WS, 'chats', 'pepper.json'));
  assert.equal(t.messages.length, N * 4, `2프로세스 × ${N}턴 × (지시+답) = ${N * 4}줄이어야 한다 — 실제 ${t.messages.length}`);
  for (const id of ['a', 'b']) for (let i = 0; i < N; i++) {
    assert.ok(t.messages.some((x) => x.who === 'user' && x.text === id + i && !x.awaiting), `${id}${i} 지시가 마무리된 채 있어야 한다`);
    assert.ok(t.messages.some((x) => x.who === 'crew' && x.text === `r-${id}${i}`), `${id}${i} 답이 있어야 한다`);
  }
  assert.deepEqual(lockDirs(join(root, WS, 'chats')), [], '잠금 폴더는 끝나면 남지 않는다');
});

test('결재 — 두 프로세스가 동시에 결재를 올려도 모두 남는다', { timeout: 120_000 }, async () => {
  const root = await seed();
  await runPair(root, `for (let i = 0; i < N; i++) await m.approvals.addApproval(WS, { slug: 'pepper', action: id + i, reason: 'x' });`);
  const list = readJson(join(root, WS, 'approvals.json'));
  assert.equal(list.length, N * 2, `결재 ${N * 2}건이어야 한다 — 실제 ${list.length}`);
  assert.deepEqual(lockDirs(join(root, WS)), []);
});

test('company.json — 두 프로세스가 같은 필드를 번갈아 고쳐도 증가분이 사라지지 않는다', { timeout: 120_000 }, async () => {
  const root = await seed();
  await runPair(root, `for (let i = 0; i < N; i++) await m.workspace.updateCompany(WS, (cur) => ({ counter: (cur.counter ?? 0) + 1, tags: [...(cur.tags ?? []), id + i] }));`);
  const c = readJson(join(root, WS, 'company.json'));
  assert.equal(c.counter, N * 2, `counter ${N * 2} — 실제 ${c.counter}`);
  assert.equal(c.tags.length, N * 2);
});

test('크루 카드 — 한 프로세스는 규칙, 다른 프로세스는 섹션을 고쳐도 둘 다 남는다', { timeout: 120_000 }, async () => {
  const root = await seed();
  await runPair(root, `
for (let i = 0; i < N; i++) {
  if (id === 'a') await m.persona.setAgentRules(WS, 'pepper', ['규칙 ' + i]);
  else await m.persona.setAgentSection(WS, 'pepper', '섹션 ' + i, '내용 ' + i);
}`);
  const md = readFileSync(join(root, WS, 'agents', 'pepper.md'), 'utf8');
  assert.match(md, new RegExp(`규칙 ${N - 1}\\b`), '마지막 규칙 편집이 남아야 한다');
  for (let i = 0; i < N; i++) assert.ok(md.includes(`## 섹션 ${i}\n`), `섹션 ${i}이 남아야 한다 — 카드 읽고-고쳐-쓰기 유실`);
  assert.deepEqual(lockDirs(join(root, WS, 'agents')), []);
});

test('교정 대장 — 두 프로세스가 서로 다른 후보를 거절해도 둘 다 반영된다', { timeout: 120_000 }, async () => {
  const root = await seed();
  writeFileSync(join(root, WS, 'corrections.json'), JSON.stringify({ items: Array.from({ length: N * 2 }, (_, i) => ({ id: `c${i}`, rule: `r${i}`, count: 3, status: 'candidate', lastAt: '2026-10-01T00:00:00Z' })) }));
  await runPair(root, `for (let i = 0; i < N; i++) await m.corrections.dismissCorrection(WS, 'c' + ((id === 'a' ? 0 : N) + i));`);
  const left = readJson(join(root, WS, 'corrections.json')).items.filter((x) => x.status === 'candidate');
  assert.equal(left.length, 0, `거절 ${N * 2}건이 모두 반영돼야 한다 — 후보 ${left.length}개 남음`);
});

test('루틴·연결 — 두 프로세스의 추가·수정이 서로를 덮지 않는다', { timeout: 120_000 }, async () => {
  const root = await seed();
  await runPair(root, `
for (let i = 0; i < N; i++) {
  await m.routines.addRoutine(WS, { agentSlug: 'pepper', title: id + i, prompt: id + i, schedule: { type: 'daily', time: '09:00' } });
  await m.connections.updateAgentBot(WS, 'bot-' + id + i, { enabled: true });
}`);
  assert.equal(readJson(join(root, WS, 'routines.json')).length, N * 2, '루틴 추가분이 모두 남아야 한다');
  const bots = Object.keys(readJson(join(root, WS, 'connections.json')).telegram.agents);
  assert.equal(bots.length, N * 2, '크루 직통 봇 연결이 모두 남아야 한다');
});

test('없는 회사에 대한 company.json 수정은 폴더를 만들지 않는다(잠금이 부모 폴더를 새로 만들지 않음)', async () => {
  const root = await seed();
  await runPair(root, `await m.workspace.updateCompany('co-ghost', { x: 1 }).catch(() => {});`);
  assert.equal(existsSync(join(root, 'co-ghost')), false, '존재하지 않는 회사 폴더가 생기면 목록·동기화가 유령 회사를 본다');
});

test('스케줄러 선점(claimRoutine) 대 CLI addRoutine — 두 프로세스가 같은 routines.json을 고쳐도 CLI 루틴이 사라지지 않고 선점(lastRun)도 덮이지 않는다(독립 검수 #800 MEDIUM-1)', { timeout: 120_000 }, async () => {
  const root = await seed();
  const base = Date.UTC(2026, 9, 1, 0, 0, 0);
  writeFileSync(join(root, WS, 'routines.json'), JSON.stringify(['s1', 's2', 's3'].map((id) => ({ id, agentSlug: 'pepper', title: id, prompt: 'p', enabled: true, schedule: { type: 'interval', everyMinutes: 10 }, lastRun: null }))));
  // a = 앱 스케줄러: 매 반복마다 11분씩 지난 시각으로 runDueRoutines(세 루틴이 매번 due → 선점 쓰기 3회) / b = CLI: 루틴 추가
  await runPair(root, `
if (id === 'a') {
  for (let i = 0; i < N; i++) await m.scheduler.runDueRoutines(WS, new Date(${base} + (i + 1) * 11 * 60_000), { runFn: async () => {} });
} else {
  for (let i = 0; i < N; i++) await m.routines.addRoutine(WS, { agentSlug: 'pepper', title: 'cli' + i, prompt: 'p' + i, schedule: { type: 'daily', time: '09:00' } });
}`);
  const list = readJson(join(root, WS, 'routines.json'));
  const cli = list.filter((r) => r.title.startsWith('cli'));
  assert.equal(cli.length, N, `CLI 루틴 ${N}개가 모두 남아야 한다 — 실제 ${cli.length}(선점 쓰기가 낡은 목록으로 덮으면 사라진다)`);
  const last = new Date(base + N * 11 * 60_000).toISOString();
  for (const id of ['s1', 's2', 's3']) assert.equal(list.find((r) => r.id === id)?.lastRun, last, `${id}의 마지막 선점이 CLI 쓰기에 덮이면 같은 루틴이 두 번 실행된다`);
  assert.deepEqual(lockDirs(join(root, WS)), []);
});

test('회의실(room-main.json)의 변경도 같은 파일 잠금을 지킨다 — 동기화가 쥔 `<file>.lockd`가 풀릴 때까지 기다린다', { timeout: 60_000 }, async () => {
  const root = await seed();
  process.env.ARGO_ROOT = root;
  const { renameMeeting } = await import('../src/room.mjs');
  const { withFileLock } = await import('../src/mutex.mjs');
  mkdirSync(join(root, WS, 'chats', '.archive'), { recursive: true });
  writeFileSync(join(root, WS, 'chats', '.archive', '_room-123.json'), JSON.stringify({ messages: [{ who: 'user', text: 'x' }] }));
  const roomFile = join(root, WS, 'chats', 'room-main.json');
  let release; const held = new Promise((r) => { release = r; });
  let entered; const inside = new Promise((r) => { entered = r; });
  const holder = withFileLock(roomFile, async () => { entered(); await held; });
  await inside;
  let done = false;
  const op = renameMeeting(WS, '_room-123.json', '새 이름').then((v) => { done = true; return v; });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(done, false, '다른 프로세스(동기화)가 방 파일 잠금을 쥔 동안 방 변경이 끼어들면 안 된다');
  release(); await holder;
  assert.equal((await op).title, '새 이름');
});

// ── 위임 제한 스위치(#799)의 쓰기도 같은 파일 잠금 — 스위치는 스레드·방 파일 안의 한 필드라 앱의 토글과 CLI의 beginTurn/appendTurn이 같은 파일을 고친다.
test('위임 제한 스위치 — 한 프로세스가 토글하는 동안 다른 프로세스가 턴을 쌓아도 한 줄도 사라지지 않는다', { timeout: 120_000 }, async () => {
  const root = await seed();
  await Promise.all([
    runPair(root, `
if (id === 'a') { for (let i = 0; i < N; i++) await m.thread.setDelegationLimit(WS, 'pepper', i % 2 === 1); await m.thread.setDelegationLimit(WS, 'pepper', false); }
else { for (let i = 0; i < N; i++) { const turnId = await m.thread.beginTurn(WS, 'pepper', { userMsg: 'b' + i }); await m.thread.appendTurn(WS, 'pepper', { turnId, userMsg: 'b' + i, reply: 'r-b' + i }); } }`),
  ]);
  const t = readJson(join(root, WS, 'chats', 'pepper.json'));
  assert.equal(t.messages.length, N * 2, `b가 쌓은 ${N}턴(지시+답)이 모두 남아야 한다 — 실제 ${t.messages.length}`);
  assert.equal(t.delegationLimit, false, 'a의 마지막 토글도 남아야 한다(b의 재기록이 덮지 않는다)');
  assert.deepEqual(lockDirs(join(root, WS, 'chats')), []);
});

test('위임 제한 스위치 쓰기도 동기화가 쥔 `<file>.lockd`가 풀릴 때까지 기다린다(스레드·회의실)', { timeout: 60_000 }, async () => {
  process.env.ARGO_ROOT ??= await seed(); // 앞 테스트가 이미 모듈을 같은 루트로 불러왔으면 그 루트를 쓴다(경로는 모듈이 정한다)
  const { setDelegationLimit } = await import('../src/thread.mjs');
  const { setRoomDelegationLimit } = await import('../src/room.mjs');
  const { withFileLock } = await import('../src/mutex.mjs');
  const { paths } = await import('../src/workspace.mjs');
  mkdirSync(paths(WS).chats, { recursive: true });
  for (const [file, run] of [[join(paths(WS).chats, 'pepper.json'), () => setDelegationLimit(WS, 'pepper', false)], [join(paths(WS).chats, 'room-main.json'), () => setRoomDelegationLimit(WS, false)]]) {
    let release; const held = new Promise((r) => { release = r; });
    let entered; const inside = new Promise((r) => { entered = r; });
    const holder = withFileLock(file, async () => { entered(); await held; });
    await inside;
    let done = false;
    const op = run().then((v) => { done = true; return v; });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(done, false, `${file.split('/').pop()}: 다른 프로세스가 파일 잠금을 쥔 동안 스위치 쓰기가 끼어들면 안 된다`);
    release(); await holder;
    assert.deepEqual(await op, { limit: false });
  }
});

// ── 재발 방지(정적): 대화·회의실 파일을 고치는 쓰기는 파일 잠금 래퍼(lockThread·lockRoom)만 쓴다. 맨 withLock(lockKey(…)) / withLock(rkey(…))은
// 프로세스 안 순서만 맞추고 앱·CLI 프로세스 간 경쟁을 막지 못한다 — #799의 스위치 쓰기가 병합 때 정확히 이 모양으로 새로 들어왔다.
test('정적 — thread.mjs·room.mjs는 withLock(lockKey( / withLock(rkey( 를 래퍼 정의 한 줄 밖에서 쓰지 않는다', () => {
  for (const [name, re, wrapper] of [['thread.mjs', /withLock\(lockKey\(/g, 'const lockThread ='], ['room.mjs', /withLock\(rkey\(/g, 'const lockRoom =']]) {
    const src = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    const bad = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => (l.match(re) ?? []).length && !l.includes(wrapper)).map(([n, l]) => `${name}:${n} ${l.trim().slice(0, 90)}`);
    assert.deepEqual(bad, [], `파일 잠금 없는 withLock이 있다 — lockThread/lockRoom을 쓰라:\n${bad.join('\n')}`);
    assert.ok(src.includes(wrapper), `${name}: 래퍼 정의가 사라졌다`);
  }
});
