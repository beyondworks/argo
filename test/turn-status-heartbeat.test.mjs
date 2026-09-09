// 크루 턴 상태 파일 심박 — 유건 제보(2026-09-06): 회의실 발언이 길어지면 회의실·1:1 대화 양쪽에서 사고 과정 표시가
// 사라져 회의가 누락된 것처럼 보였다(답변은 결국 도착). 원인 = 상태 파일은 스트림·도구 이벤트 때만 갱신되는데
// getTurnStatus가 120초 무갱신을 '죽음'으로 본다 → 이벤트 없는 긴 단계(도구 실행·응답 대기)에서 턴이 살아 있는데
// 표시가 꺼짐(격리 재현: 150초 지연 스텁, memory 단계 2분 뒤 stage null). 처방 = 회의실 마커와 같은 심박을
// setTurnStatus/clearTurnStatus 안에 — 호출부 무변경, 키별 한 체인 직렬화, 종료 뒤 부활 금지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tsheartbeat-'));
const { paths } = await import('../src/workspace.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');
const { setTurnStatus: writeTurnStatus, clearTurnStatus: removeTurnStatus, getTurnStatus, detailForTool, _setHeartbeatMsForTest } = await import('../src/turn-status.mjs');

// Every failed assertion must release its real interval before the next test.
const active = new Map();
async function setTurnStatus(ws, slug, ...args) {
  active.set(`${ws}/${slug}`, [ws, slug]);
  return writeTurnStatus(ws, slug, ...args);
}
async function clearTurnStatus(ws, slug) {
  try { await removeTurnStatus(ws, slug); } finally { active.delete(`${ws}/${slug}`); }
}
test.afterEach(async () => {
  await Promise.all([...active.values()].map(([ws, slug]) => clearTurnStatus(ws, slug)));
  _setHeartbeatMsForTest(30_000);
});

// Control the production module's timer and read boundary, rather than hoping a
// 1ms interval races a Windows fsync within a fixed wall-clock window.
async function heartbeatFixture() {
  const source = (await readFile(new URL('../src/turn-status.mjs', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('export ', '');
  const files = new Map(), timers = new Set(); let gate, now = 1_000_000, reads = 0, writes = 0;
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  const api = new Function('paths', 'join', 'sanitizeFileSlug', 'readJsonLenient', 'writeJsonAtomic', 'rm', 'setInterval', 'clearInterval', 'Date', `${source}; return { setTurnStatus, clearTurnStatus, getTurnStatus, drain: () => Promise.all([...live.values()].map(e => e.chain)) };`)(
    ws => ({ chats: `/${ws}` }), join, value => value,
    async (file, fallback) => { reads++; const snapshot = structuredClone(files.get(file) ?? fallback); if (gate) { const pending = gate; gate = null; pending.started.resolve(); await pending.release.promise; } return snapshot; },
    async (file, value) => { writes++; files.set(file, structuredClone(value)); },
    async file => { files.delete(file); },
    callback => { const timer = { callback, unref() {} }; timers.add(timer); return timer; },
    timer => timers.delete(timer), { now: () => now },
  );
  return { ...api, files, stats: () => ({ reads, writes }), tick: () => { now += 100; for (const timer of timers) timer.callback(); },
    blockRead: () => { gate = { started: deferred(), release: deferred() }; return gate; } };
}
async function waitFor(testCondition, message) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) { if (await testCondition()) return; await sleep(20); }
  assert.fail(message);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const statusPath = (ws, slug) => join(paths(ws).chats, `${slug}.status.json`);
async function seed(ws) { await mkdir(paths(ws).chats, { recursive: true }); }
/** 파일 ts를 과거로 — 심박이 실제로 ts를 앞당기는지 보는 유일한 방법(120초 창은 실시간으로 기다릴 수 없다) */
async function backdate(ws, slug, ms) {
  const f = statusPath(ws, slug);
  const j = JSON.parse(await readFile(f, 'utf8'));
  await writeJsonAtomic(f, { ...j, ts: Date.now() - ms });
}

test('심박: 이벤트 없이도 ts가 갱신돼 2분 창을 넘긴 긴 단계에서 표시가 살아 있다 — 단계·문장·출처 보존', { timeout: 20_000 }, async () => {
  _setHeartbeatMsForTest(20);
  const ws = 'hb-alive'; await seed(ws);
  await setTurnStatus(ws, 'mina', 'shell', 'sleep 300', '지금까지 쓴 문장', 'room');
  await backdate(ws, 'mina', 119_500); // 창(120초) 바로 안 — 심박이 0회면 다음 순간 만료된다
  const before = JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts;
  await waitFor(async () => JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts > before, 'heartbeat did not update its timestamp');
  const after = JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts;
  assert.ok(after > before, `심박이 파일 ts를 앞당긴다(전진 ${after - before}ms) — 만료 여부만 보면 창 안 backdate에 심박 0회도 통과한다(검수 HIGH-1)`);
  const s = await getTurnStatus(ws, 'mina');
  assert.ok(s, '심박이 ts를 앞당겨 만료를 막는다');
  assert.equal(s.stage, 'shell'); assert.equal(s.detail, 'sleep 300'); assert.equal(s.partial, '지금까지 쓴 문장'); assert.equal(s.source, 'room');
  await clearTurnStatus(ws, 'mina');
});

test('심박 없이 120초를 넘긴 파일은 종전대로 null(고아 판정 유지) — 심박이 판정 규칙을 느슨하게 만들지 않는다', async () => {
  const ws = 'hb-orphan'; await seed(ws);
  await writeFile(statusPath(ws, 'ghost'), JSON.stringify({ stage: 'think', detail: '', partial: '', source: 'chat', startedAt: Date.now() - 200_000, ts: Date.now() - 130_000 }));
  assert.equal(await getTurnStatus(ws, 'ghost'), null, '다른 프로세스가 죽인 파일은 심박이 없으니 만료');
});

test('종료: clearTurnStatus 뒤에는 심박이 파일을 되살리지 않는다(해제 경합 ×40, 심박 1ms)', { timeout: 20_000 }, async t => {
  _setHeartbeatMsForTest(1);
  const ws = 'hb-clear'; await seed(ws);
  for (let i = 0; i < 40; i++) {
    t.signal.throwIfAborted();
    await setTurnStatus(ws, 'pepper', 'think', '', '', 'chat');
    await sleep(3);
    await clearTurnStatus(ws, 'pepper');
    await sleep(6); // 해제 직후 착지할 수 있는 심박에게 시간을 준다
    assert.equal(existsSync(statusPath(ws, 'pepper')), false, `${i}회차: 종료 뒤 부활 = 거짓 '작성 중'`);
  }
});

test('다른 프로세스가 지운 파일 — 이 프로세스의 턴이 살아 있는 동안만 심박이 되돌리고, 종료(clear)와 함께 확실히 사라진다', async () => {
  // 크루 상태 파일은 크루당 하나라 두 프로세스(상주·사이드카)의 턴이 겹치면 한쪽의 종료가 다른 쪽 파일을 지운다(기존 제약).
  // 심박의 읽고-쓰기 창에서 되살아난 파일은 "이 프로세스의 턴이 진행 중"이라는 사실과 일치하므로 해롭지 않고,
  // 이 턴의 clearTurnStatus가 끝내 지운다 — 영구 유령은 없다.
  _setHeartbeatMsForTest(5);
  const ws = 'hb-gone'; await seed(ws);
  await setTurnStatus(ws, 'jun', 'memory', '', '', 'chat');
  await rm(statusPath(ws, 'jun'), { force: true }); // 다른 프로세스의 종료
  await sleep(40);
  await clearTurnStatus(ws, 'jun');
  await sleep(30);
  assert.equal(existsSync(statusPath(ws, 'jun')), false, '이 턴이 끝난 뒤에는 어떤 심박도 파일을 남기지 않는다');
});

test('직렬화: 읽기 중인 심박이 끝나기 전 단계 쓰기는 대기하고, 60회 교차 뒤에도 최신 단계가 남는다', { timeout: 20_000 }, async () => {
  const h = await heartbeatFixture();
  try {
    for (let i = 0; i < 60; i++) {
      await h.setTurnStatus('order', 'sun', 'memory', 'a', undefined, 'room');
      const blocked = h.blockRead();
      h.tick();
      await blocked.started.promise;
      let finished = false;
      const update = h.setTurnStatus('order', 'sun', 'write', 'b', `p${i}`, 'room').then(() => { finished = true; });
      try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(finished, false, 'stage write must wait for the suspended heartbeat read');
      } finally { blocked.release.resolve(); await update; await h.drain(); }
      const status = await h.getTurnStatus('order', 'sun');
      assert.equal(status.stage, 'write'); assert.equal(status.detail, 'b'); assert.equal(status.partial, `p${i}`);
    }
  } finally { await h.clearTurnStatus('order', 'sun'); }
});

test('회의실 마커(room-main)와의 공존 — 래퍼 하트비트와 상태 파일 심박이 겹쳐도 발언자(detail)가 보존되고 종료 시 함께 꺼진다', async () => {
  _setHeartbeatMsForTest(3);
  const { withRoomTurnStatus, ROOM_TURN_SLUG } = await import('../src/room.mjs');
  const ws = 'hb-room'; await seed(ws);
  let inside;
  await withRoomTurnStatus(ws, async (mark) => {
    await mark('mina|pepper');
    await sleep(40);
    inside = await getTurnStatus(ws, ROOM_TURN_SLUG);
  }, { heartbeatMs: 5 });
  assert.equal(inside?.detail, 'mina|pepper', '두 심박이 서로의 값을 지우지 않는다');
  await sleep(20);
  assert.equal(existsSync(statusPath(ws, ROOM_TURN_SLUG)), false, '종료 뒤 어느 심박도 마커를 되살리지 않는다');
});

test('심박은 내용을 지어내지 않는다 — 파일 제거 후 시작한 심박은 상태를 쓰지 않는다', async () => {
  const h = await heartbeatFixture();
  await h.setTurnStatus('nofab', 'yun', 'shell', 'ls', '부분', 'chat');
  try {
    h.files.clear(); // No heartbeat read has begun: the removed-file precondition is explicit.
    const before = h.stats();
    for (let i = 0; i < 3; i++) { h.tick(); await h.drain(); }
    assert.equal(h.stats().reads, before.reads + 3, 'three heartbeat reads really ran');
    assert.equal(h.stats().writes, before.writes, 'a missing file cannot produce a new state');
    assert.equal(h.files.size, 0);
  } finally { await h.clearTurnStatus('nofab', 'yun'); }
});

test('동시 크루: 두 크루가 같이 도는 중 한쪽이 끝나도 다른 쪽 심박은 살아 있다 — 타이머는 키별(검수 MEDIUM-1 프로브: 전역 타이머면 0ms 전진)', { timeout: 20_000 }, async () => {
  _setHeartbeatMsForTest(20);
  const ws = 'hb-two'; await seed(ws);
  await setTurnStatus(ws, 'mina', 'think', '', '', 'room');
  await setTurnStatus(ws, 'pepper', 'think', '', '', 'delegate');
  await clearTurnStatus(ws, 'pepper'); // 위임받은 동료가 먼저 끝남
  const before = JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts;
  await waitFor(async () => JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts > before, 'remaining crew heartbeat did not advance');
  const after = JSON.parse(await readFile(statusPath(ws, 'mina'), 'utf8')).ts;
  assert.ok(after > before, `pepper의 종료가 mina의 심박을 죽였다(전진 ${after - before}ms)`);
  assert.equal(existsSync(statusPath(ws, 'pepper')), false, '끝난 쪽은 사라진다');
  await clearTurnStatus(ws, 'mina');
});

// ── 배선 — 심박이 생긴 뒤 clear는 프로세스 수명 자원(타이머) 해제다. 두 러너 경로의 finally에 마지막 방어선이 있어야
// 어떤 실패 경로도 크루를 상주에서 영구 "작성 중"으로 남기지 않는다(검수 MEDIUM-2). 구간 불변식으로만 잠근다.
test('배선: chat.mjs의 SDK·CLI 두 경로 finally에 clearTurnStatus가 있다(타이머 누수 방어선)', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  const finals = [...src.matchAll(/\} finally \{[\s\S]*?\n\s{2,6}\}/g)].map((m) => m[0]).filter((b) => /abortReg\??\.release\(\);/.test(b));
  assert.equal(finals.length, 2, 'abortReg를 해제하는 finally = 러너 경로 2개(CLI·SDK)');
  for (const b of finals) assert.ok(/await clearTurnStatus\(wsId, agentSlug\);/.test(b), `finally에 clear가 없다: ${b.slice(0, 80)}…`);
});

test('낡은 잔재 파일(120초 무갱신)은 새 턴의 전 상태가 아니다 — startedAt·partial·thought·source를 물려받지 않는다', async () => {
  const ws = 'hb-stale-prev'; await seed(ws);
  await writeFile(statusPath(ws, 'lee'), JSON.stringify({ stage: 'think', detail: '', partial: '옛 문장', thought: '옛 생각', source: 'chat', startedAt: Date.now() - 1_900_000, ts: Date.now() - 1_800_000 }));
  await setTurnStatus(ws, 'lee', 'boot', '', undefined, 'room');
  const s = await getTurnStatus(ws, 'lee');
  assert.ok(Date.now() - s.startedAt < 5_000, `경과가 새 턴 기준이어야 한다(실측: 낡은 마커 상속으로 31:54 표시) — startedAt ${Date.now() - s.startedAt}ms 전`);
  assert.equal(s.partial, ''); assert.equal(s.thought ?? '', ''); assert.equal(s.source, 'room');
  await clearTurnStatus(ws, 'lee');
});

// ── 사고 과정(thought) 배선 — chat.mjs가 thinking 블록을 상태 파일로 흘려야 회의실·1:1 카드의 "생각"이 산다(유건 요청 (가)).
test('배선: chat.mjs가 assistant 메시지의 thinking 블록을 누적해 단계 갱신에 thought로 싣는다', async () => {
  const src = await readFile(new URL('../src/chat.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes("let thought = '';"), 'thought 누적 변수');
  assert.ok(/filter\(\(b\) => b\.type === 'thinking' && typeof b\.thinking === 'string'\)\.map\(\(b\) => b\.thinking\)/.test(src), 'thinking 블록 수집');
  assert.ok(/if \(thoughtNow\) thought = thought \? `\$\{thought\}\\n\\n\$\{thoughtNow\}` : thoughtNow;/.test(src), '누적(이전 생각 뒤에 덧붙임)');
  assert.ok(src.includes("await setTurnStatus(wsId, agentSlug, stage, detail, partial, turnSource, thought, steps);"), '단계 갱신에 thought·steps 전달(메신저 실행 카드 2026-09-09)');
  // 상태 파일 왕복 — thought는 뒤 1500자만, 미전달 시 유지
  const ws = 'hb-thought'; await seed(ws);
  await setTurnStatus(ws, 'kim', 'think', '', '', 'room', 'x'.repeat(2000));
  assert.equal((await getTurnStatus(ws, 'kim')).thought.length, 1500, '뒤 1500자');
  // steps — 전달하면 뒤 40개, 미전달이면 유지, 반환에 실림(메신저 실행 카드 원천)
  await setTurnStatus(ws, 'kim', 'shell', 'ls', undefined, 'room', undefined, Array.from({ length: 45 }, (_, i) => ({ t: i, stage: 'shell', detail: `c${i}` })));
  assert.equal((await getTurnStatus(ws, 'kim')).steps.length, 40, '뒤 40개');
  await setTurnStatus(ws, 'kim', 'think', '', undefined, 'room');
  assert.equal((await getTurnStatus(ws, 'kim')).steps.at(-1).detail, 'c44', '미전달 시 유지');
  await setTurnStatus(ws, 'kim', 'write', 'a.md', '문장', 'room');
  assert.equal((await getTurnStatus(ws, 'kim')).thought.length, 1500, '미전달이면 이전 생각 유지');
  await clearTurnStatus(ws, 'kim');
});


test('live shell status explains a wait while the execution trace retains the command', async () => {
  const ws = 'wait-description'; await seed(ws);
  const input = { command: 'python3 -c "import time; time.sleep(75)"', description: 'Gmail 분당 쿼터 회복 대기' };
  const display = detailForTool('Bash', input, { display: true });
  const trace = detailForTool('Bash', input);
  assert.equal(display, input.description);
  assert.equal(trace, input.command);
  assert.equal(detailForTool('Bash', { ...input, description: '  ' }, { display: true }), trace);
  assert.equal(detailForTool('Bash', { ...input, description: {} }, { display: true }), trace);
  await setTurnStatus(ws, 'mina', 'shell', display, '', 'chat', '', [{ t: 0, stage: 'shell', detail: trace }]);
  try {
    const live = await getTurnStatus(ws, 'mina');
    assert.equal(live.detail, input.description);
    assert.equal(live.steps[0].detail, input.command);
  } finally { await clearTurnStatus(ws, 'mina'); }
});
