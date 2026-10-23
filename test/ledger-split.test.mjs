// 원장 나누기(기기별 + 월 조각, ARGO_LEDGER_SPLIT=1) — 경우 표 W·R·S·V·G(공유 노트 ledger-split-case-table.md).
// 앞 절(핀)은 플래그 꺼짐 = 배포본(0.1.116) 동작을 고정한다 — 고치기 전 코드에서 먼저 통과시켰다.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-ledgerhome-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-ledger-'));
delete process.env.ARGO_LEDGER_SPLIT;
// 기기 id에 대문자·밑줄을 넣어 파일 이름 조각 정리(deviceSlug)까지 함께 본다
await writeFile(join(process.env.ARGO_ROOT, '.device-id'), 'Mac_Two-1a2b3c4d');
const DEV = 'mac-two-1a2b3c4d';
const { paths } = await import('../src/workspace.mjs');
const { appendEvent, readEvents } = await import('../src/events.mjs');
const { appendUsage, monthCost, readUsageSummary, readActivity } = await import('../src/usage.mjs');
const { makePermissionGate, makeIsForbidden, shellLedgerHit } = await import('../src/permission-gate.mjs');

const { ledgerAppendPath, deviceSlug } = await import('../src/ledger.mjs');
afterEach(() => { delete process.env.ARGO_LEDGER_SPLIT; });

const U = { input_tokens: 1, output_tokens: 1 };
const nowIso = () => new Date().toISOString();
async function fresh(ws) { await mkdir(paths(ws).root, { recursive: true }); return paths(ws).root; }
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/* ─── 핀: 플래그 꺼짐(기본) = 배포본 ─── */

test('W1 핀: 꺼짐이면 events.jsonl·usage.jsonl 두 파일에만 쓴다', async () => {
  const root = await fresh('pin-w1');
  await appendEvent('pin-w1', { type: 'turn', slug: 'a', ok: true });
  await appendUsage('pin-w1', { kind: 'chat', slug: 'a', usage: U, costUsd: 0.5, billed: true });
  assert.deepEqual((await readdir(root)).sort(), ['events.jsonl', 'usage.jsonl']);
});

test('W1 핀: 꺼짐이고 조각이 없으면 readEvents는 파일 순서를 뒤집은 것(ts로 다시 정렬하지 않음)', async () => {
  const root = await fresh('pin-order');
  // 동기화 병합(mergeLedger)은 원격 줄을 앞에 두므로 파일 순서가 ts 순서가 아닐 수 있다 — 배포본은 파일 순서를 그대로 쓴다
  await writeFile(join(root, 'events.jsonl'), jsonl([{ ts: '2026-10-02T00:00:00Z', n: 1 }, { ts: '2026-10-01T00:00:00Z', n: 2 }, { ts: '2026-10-03T00:00:00Z', n: 3 }]));
  assert.deepEqual((await readEvents('pin-order', 2)).map((e) => e.n), [3, 2]);
});

test('W1 핀: 꺼짐이면 월 사용액은 usage.jsonl의 이번 달 청구 행 합', async () => {
  const root = await fresh('pin-month');
  await writeFile(join(root, 'usage.jsonl'), jsonl([
    { ts: nowIso(), kind: 'chat', slug: 'a', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, costUsd: 1.5, billed: true },
    { ts: '2020-01-01T00:00:00Z', kind: 'chat', slug: 'a', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, costUsd: 9, billed: true },
  ]));
  assert.equal((await monthCost('pin-month')).costUsd, 1.5);
  assert.equal((await readUsageSummary('pin-month')).total.turns, 2);
  assert.equal((await readActivity('pin-month', 10)).length, 2);
});

test('G 핀: 원장은 파일 도구 쓰기만 막고 읽기는 연다, 셸은 이름만 나와도 막는다', async () => {
  const root = await fresh('pin-gate');
  const f = makeIsForbidden(root);
  for (const n of ['events.jsonl', 'usage.jsonl']) {
    assert.equal(await f(join(root, n), 'write'), true, `${n} 쓰기`);
    assert.equal(await f(join(root, n)), false, `${n} 읽기`);
  }
  const gate = makePermissionGate('pin-gate', 'crew-a', root);
  assert.equal((await gate('Write', { file_path: join(root, 'events.jsonl'), content: 'x' })).behavior, 'deny');
  assert.equal((await gate('Read', { file_path: join(root, 'usage.jsonl') })).behavior, 'allow');
  assert.equal((await gate('Bash', { command: 'echo x >> events.jsonl' })).behavior, 'deny');
  // 원장이 아닌 비슷한 이름은 파일 도구에서 열려 있다(G3)
  for (const n of ['myevents.md', 'events-notes.md', 'usage.md', 'events.json']) {
    assert.equal(await f(join(root, n), 'write'), false, `${n}는 원장이 아니다`);
  }
  assert.equal((await gate('Bash', { command: 'cat events-notes.md' })).behavior, 'allow', '원장이 아닌 이름의 셸 명령');
});

/* ─── 켬(ARGO_LEDGER_SPLIT=1) ─── */
const on = () => { process.env.ARGO_LEDGER_SPLIT = '1'; };
const month = () => new Date().toISOString().slice(0, 7);
const urow = (ts, costUsd, extra = {}) => ({ ts, kind: 'chat', slug: 'a', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, costUsd, billed: true, ...extra });

test('W2 켬 — 이 기기·이번 달(UTC) 조각에 쓰고 옛 파일은 건드리지 않는다', async () => {
  on();
  const root = await fresh('on-w2');
  await writeFile(join(root, 'events.jsonl'), jsonl([{ ts: '2026-01-01T00:00:00Z', n: 0 }]));
  const before = await readFile(join(root, 'events.jsonl'), 'utf8');
  await appendEvent('on-w2', { type: 'turn', slug: 'a', ok: true });
  await appendUsage('on-w2', { kind: 'chat', slug: 'a', usage: U, costUsd: 0.5, billed: true });
  const names = (await readdir(root)).sort();
  assert.deepEqual(names, ['events.jsonl', `events.${DEV}.${month()}.jsonl`, `usage.${DEV}.${month()}.jsonl`].sort());
  assert.equal(await readFile(join(root, 'events.jsonl'), 'utf8'), before, '옛 파일은 그대로');
});

test('W3·W4 월 경계와 시간대 — 조각의 월은 줄 ts의 UTC 월이다', async () => {
  on();
  await fresh('on-w3');
  const p = (ts) => ledgerAppendPath('on-w3', 'events', ts).then((x) => x.split(/[\\/]/).pop());
  assert.equal(await p('2026-10-31T23:59:59.999Z'), `events.${DEV}.2026-10.jsonl`);
  assert.equal(await p('2026-11-01T00:00:00.000Z'), `events.${DEV}.2026-11.jsonl`, 'UTC 자정이 지나면 새 조각');
  // 한국 시각 11월 1일 08시 = UTC 10월 31일 23시 — 기기 시간대와 무관하게 10월 조각(ts는 늘 toISOString)
  const prevTZ = process.env.TZ;
  process.env.TZ = 'Asia/Seoul';
  try { assert.equal(await p(new Date(Date.UTC(2026, 9, 31, 23)).toISOString()), `events.${DEV}.2026-10.jsonl`); }
  finally { if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ; }
  assert.equal(deviceSlug('맥북 Pro_2'), 'pro-2', '이름 글자 밖은 -로, 앞뒤 -는 지운다');
  assert.equal(deviceSlug(''), 'device');
});

test('R1·R2 합쳐 읽기 — 옛 파일 + 여러 기기·여러 월 조각을 ts로 정렬, 같은 줄은 한 번, 최근 N개', async () => {
  const root = await fresh('on-r1');
  const e = (ts, n) => ({ ts, n, type: 'turn' });
  await writeFile(join(root, 'events.jsonl'), jsonl([e('2026-09-03T00:00:00Z', 'old3'), e('2026-09-01T00:00:00Z', 'old1')]));
  await writeFile(join(root, 'events.dev-a.2026-09.jsonl'), jsonl([e('2026-09-02T00:00:00Z', 'a2'), e('2026-09-30T00:00:00Z', 'a30')]));
  await writeFile(join(root, 'events.dev-b.2026-10.jsonl'), jsonl([e('2026-10-05T00:00:00Z', 'b5'), e('2026-09-02T00:00:00Z', 'a2')].map((x, i) => (i === 1 ? { ...x, n: 'a2' } : x))));
  await writeFile(join(root, 'events.notes.md'), 'x'); // 원장 조각이 아닌 이름은 읽지 않는다
  await writeFile(join(root, 'usage.dev-a.2026-10.jsonl'), jsonl([urow('2026-10-01T00:00:00Z', 1)])); // 다른 종류는 섞지 않는다
  // 꺼짐이어도 조각을 읽는다(V3: 켰다 끈 기기, V1: 다른 새 기기가 올린 조각)
  assert.deepEqual((await readEvents('on-r1', 10)).map((x) => x.n), ['b5', 'a30', 'old3', 'a2', 'old1'], '최신순, 같은 줄(a2)은 한 번');
  assert.deepEqual((await readEvents('on-r1', 2)).map((x) => x.n), ['b5', 'a30'], '최근 N개는 파일 끝이 아니라 합친 ts 기준');
});

test('R3 월 예산 — 이번 달은 모든 기기 조각 + 옛 파일의 이번 달 행을 더한다', async () => {
  const root = await fresh('on-r3');
  const now = nowIso();
  await writeFile(join(root, 'usage.jsonl'), jsonl([urow(now, 1), urow('2020-01-01T00:00:00Z', 100)]));
  await writeFile(join(root, `usage.${DEV}.${month()}.jsonl`), jsonl([urow(now, 2)]));
  await writeFile(join(root, `usage.other-dev.${month()}.jsonl`), jsonl([urow(now, 4)]));
  assert.equal((await monthCost('on-r3')).costUsd, 7, '다른 기기 지출까지(자기 조각만 읽으면 3)');
});

test('R4 같은 자료를 옛 형식·조각 형식으로 두면 집계가 같다', async () => {
  // 옛 파일은 덧붙인 순서(= ts 순서)로 둔다 — 조각이 없을 때 파일 순서를 그대로 쓰는 것은 W1 핀이 따로 고정한다
  const t = Date.now();
  const rows = [urow('2026-01-15T00:00:00Z', 1, { slug: 'a', kind: 'delegate', from: 'b' }), urow(new Date(t - 1000).toISOString(), 0.25, { slug: 'a' }), urow(new Date(t).toISOString(), 0.5, { slug: 'b', billed: false })];
  const r1 = await fresh('r4-legacy');
  await writeFile(join(r1, 'usage.jsonl'), jsonl(rows));
  const r2 = await fresh('r4-split');
  await writeFile(join(r2, `usage.dev-b.${month()}.jsonl`), jsonl(rows.slice(2)));
  await writeFile(join(r2, `usage.dev-a.${month()}.jsonl`), jsonl(rows.slice(1, 2)));
  await writeFile(join(r2, 'usage.dev-a.2026-01.jsonl'), jsonl(rows.slice(0, 1)));
  const { agentStats, monthCostByCrew, monthCostByRunner, readDelegations } = await import('../src/usage.mjs');
  for (const fn of [readUsageSummary, monthCost, monthCostByCrew, monthCostByRunner, (w) => agentStats(w, 'a'), (w) => readDelegations(w), (w) => readActivity(w, 10)]) {
    assert.deepEqual(await fn('r4-split'), await fn('r4-legacy'), fn.name || 'agentStats/delegations');
  }
});

test('V3 켰다 끄기 — 조각은 계속 읽히고 새 줄은 옛 파일로', async () => {
  on();
  const root = await fresh('on-v3');
  await appendEvent('on-v3', { type: 'turn', n: 'on' });
  delete process.env.ARGO_LEDGER_SPLIT;
  await new Promise((r) => setTimeout(r, 5)); // ts가 같은 밀리초면 순서는 읽은 순서(옛 파일 먼저) — 시험은 다른 시각으로 둔다
  await appendEvent('on-v3', { type: 'turn', n: 'off' });
  assert.deepEqual((await readEvents('on-v3', 10)).map((x) => x.n), ['off', 'on']);
  assert.ok((await readFile(join(root, 'events.jsonl'), 'utf8')).includes('"n":"off"'));
});

test('G1~G3 권한 — 조각도 원장이다(파일 도구 쓰기·MCP·셸 거부, 읽기는 파일 도구로 열림), 비슷한 이름은 종전대로', async () => {
  const root = await fresh('gate-split');
  const piece = `events.${DEV}.2026-10.jsonl`;
  const f = makeIsForbidden(root);
  for (const n of [piece, `usage.${DEV}.2026-10.jsonl`, 'USAGE.X.2026-10.JSONL', `${piece}.`]) {
    assert.equal(await f(join(root, n), 'write'), true, `${n} 쓰기 거부`);
  }
  assert.equal(await f(join(root, piece)), false, '파일 도구 읽기는 연다(옛 원장과 같다)');
  const gate = makePermissionGate('gate-split', 'crew-a', root);
  assert.equal((await gate('Write', { file_path: join(root, piece), content: '{}' })).behavior, 'deny');
  assert.equal((await gate('Edit', { file_path: join(root, piece), old_string: 'a', new_string: 'b' })).behavior, 'deny');
  assert.equal((await gate('mcp__fs__write_file', { to: piece, content: 'x' })).behavior, 'deny', 'MCP 비경로 키에 조각 이름 하나');
  for (const cmd of [
    `echo '{}' >> ${piece}`, `rm usage.*.jsonl`, `rm usage.*`, `truncate -s0 ./events.dev-x.2026-10.jsonl`,
    `rm events.{${DEV},x}.2026-10.jsonl`, `rm "events".dev.2026-10.jsonl`, `rm ev\ents.d.2026-10.jsonl`, `rm ../gate-split/usage.[a-z]*.jsonl`,
    `cp /dev/null ${join(root, 'usage.d.2026-10.jsonl')}`,
  ]) assert.equal((await gate('Bash', { command: cmd })).behavior, 'deny', cmd);
  for (const cmd of ['cat data/*.jsonl', 'ls vault/notes', 'cat events-notes.md', 'ls *.md', 'rm build/*.tmp', 'grep -r usage src']) {
    assert.equal((await gate('Bash', { command: cmd })).behavior, 'allow', cmd);
  }
  for (const n of ['myevents.jsonl', 'events-notes.md', 'events.json', 'usage', 'eventsx.jsonl', 'events.backup.jsonl', 'usage.report.jsonl', 'events.2024.jsonl']) { // 리더가 읽지 않는 이름은 원장이 아니다(#1149 검수)
    assert.equal(await f(join(root, n), 'write'), false, `${n}는 원장이 아니다`);
  }
});

/* ─── #1149 검수 Important 1: 셸 원장 대조는 회사 폴더 직속 조각만(배포본에서 통과하던 명령은 그대로 통과) ─── */
test('G3b 핀: 배포본에서 통과하던 셸 명령은 그대로 통과한다(검수 목록 전부, 파일 도구 입력 포함)', async () => {
  const root = await fresh('gate-pass');
  const gate = makePermissionGate('gate-pass', 'crew-a', root, null, 'ko', [], { computerUse: true });
  const cmds = [
    'ls *.jsonl', 'find vault -name "*.jsonl"', 'wc -l *.jsonl', 'rg -g "*.jsonl" foo', 'ls ~/x/*.jsonl', 'cat ../*.jsonl',
    'ls e*', 'ls us*', 'ls *s*', 'cat vault/data/events.2024.jsonl', 'python3 x.py --out usage.report.jsonl',
    'cat events*', 'cat data/usage.dev-a.2026-10.jsonl', 'ls /tmp/elsewhere/usage.*.jsonl', 'cat ~/x/events.dev-a.2026-10.jsonl',
  ];
  for (const cmd of cmds) {
    assert.equal((await gate('Bash', { command: cmd })).behavior, 'allow', `Bash: ${cmd}`);
    assert.equal((await gate('computer_type', { text: cmd })).behavior, 'allow', `computer_type: ${cmd}`);
  }
});

test('G2b 위조 조각은 계속 막는다 — 회사 폴더 직속을 가리키는 글자·글롭(상대·./·절대·~·..)', async () => {
  const root = await fresh('gate-block');
  const gate = makePermissionGate('gate-block', 'crew-a', root, null, 'ko', [], { computerUse: true });
  const savedHome = process.env.HOME;
  process.env.HOME = join(root, '..', '..'); // ~ 칸: 회사 폴더가 HOME 아래인 모양(게이트는 HOME을 부를 때마다 읽는다)
  const viaHome = `~/${root.split(/[\\/]/).slice(-2).join('/')}`;
  const cmds = [
    'echo x >> events.dev-a.2026-10.jsonl', 'rm usage.*.jsonl', 'rm usage.*', 'rm ev?nts.x.jsonl', 'rm [e]vents.*', 'truncate -s0 ./events.dev-x.2026-10.jsonl',
    'rm events.{dev-a,x}.2026-10.jsonl', 'rm "events".dev.2026-10.jsonl', 'rm ev\\ents.d.2026-10.jsonl',
    `rm ${join(root, 'usage.*.jsonl')}`, `cp /dev/null ${join(root, 'usage.d.2026-10.jsonl')}`, 'rm ../gate-block/usage.[a-z]*.jsonl',
    'echo x > USAGE.DEV.2026-10.JSONL',
    `rm ${viaHome}/events.*`,
    `rm ${root.replace(/[\\/]/g, '/')}\\usage.*.jsonl`, // 구분자 섞임(/ + \\) — Windows CI run 39902105589에서 절대 경로 위조가 통과했다
  ];
  try {
    for (const cmd of cmds) {
      assert.equal((await gate('Bash', { command: cmd })).behavior, 'deny', `Bash: ${cmd}`);
      assert.equal((await gate('computer_type', { text: cmd })).behavior, 'deny', `computer_type: ${cmd}`);
    }
  } finally { process.env.HOME = savedHome; }
});

test('G2w Windows 경로 표기(드라이브 문자·역슬래시) — 어느 OS에서 돌아도 path.win32로 풀어 회사 폴더 직속이면 막고, 그 밖은 통과', () => {
  const W = 'D:\\a\\_temp\\argo-ledger\\co';
  for (const cmd of [
    'rm D:\\a\\_temp\\argo-ledger\\co\\usage.*.jsonl', 'cp /dev/null D:\\a\\_temp\\argo-ledger\\co\\usage.d.2026-10.jsonl',
    'rm D:/a/_temp/argo-ledger/co\\events.dev-a.2026-10.jsonl', 'rm d:\\A\\_TEMP\\ARGO-LEDGER\\CO\\usage.*', 'rm D:\\a\\_temp\\argo-ledger\\co\\x\\..\\usage.*',
    'Remove-Item "D:\\a\\_temp\\argo-ledger\\co\\events.dev-a.2026-10.jsonl"',
  ]) assert.equal(shellLedgerHit(cmd, W), true, cmd);
  for (const cmd of [
    'cat D:\\a\\_temp\\argo-ledger\\co\\data\\usage.dev-a.2026-10.jsonl', 'ls D:\\a\\_temp\\argo-ledger\\co\\*.jsonl', 'rm D:\\other\\usage.*',
    'ls D:\\a\\_temp\\argo-ledger\\co\\e*', 'type D:\\a\\_temp\\argo-ledger\\co\\usage.report.jsonl',
  ]) assert.equal(shellLedgerHit(cmd, W), false, cmd);
});
