// withDirLock의 오래된 잠금 회수 경쟁 — #791 독립 검수 MEDIUM-3(2026-10-01).
// 결함: 두 프로세스가 같은 오래된 잠금을 보고 각자 stat → rm 하면, 늦게 rm한 쪽이 먼저 회수해 새로 잡은 잠금까지 지워 둘이 동시에
// 잠금 안에 들어간다(검수 실측: 2개 60회 중 7회 겹침). withDirLock은 자격 파일·기기 세션·게이트웨이 큐가 같이 쓴다.
// 방법: 회차마다 부모가 0번 자식에게 크래시가 남긴 오래된 잠금을 깔게 한 뒤, 두 자식을 같은 시각에 withDirLock에 들여보낸다. 잠금 안에서
// 표식 파일을 배타 생성(wx)해 이미 있으면 겹침으로 센다. 회차를 부모가 맞추므로 러너가 느려도 일정이 밀려 깔기를 건너뛰거나 한쪽만 늦게
// 출발하지 않는다(예전 고정 250ms 일정은 테스트 스위트 두 벌을 같이 돌린 Windows에서 깐 회차가 16까지 줄어 실패했다 — run 37205491236).
// 시간 설정은 제품 기본값(staleMs 30초·대기 상한 10초 — 제품 호출부 중 가장 짧은 대기)을 그대로 쓴다. 깔아 둔 잠금은 60초 전 시각이라
// staleMs와 무관하게 오래된 것으로 보인다. 예전 테스트 전용 5초·3초는 제품보다 빡빡했다: 테스트 스위트가 C: 임시 폴더를 같이 쓰는
// Windows CI에서 mkdir 한 번이 1.6초 걸려 잠금 한 번에 5.2초가 드는 것을 진단 실행으로 봤다(run 37204022054). 3초를 넘기면 119/120,
// 5초를 넘기면 살아 있는 주인의 잠금이 회수돼 겹침까지 났다(10/1~10/4 Windows 95잡 중 6건, 맥 0건). 이 테스트가 잡을 것은 회수 경쟁이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const MUTEX = new URL('../src/mutex.mjs', import.meta.url).href;
// 회차는 최대 60, 시간은 30초까지 — 평소엔 5~8초에 60회차를 다 돈다. 스위트 두 벌 부하의 Windows에서는 디스크 지연으로 60회차에
// 56초까지 걸렸다(run 37206459736). 테스트 시간 상한(60초)은 응답 없는 자식(멈춤)만 잡도록 남겨 둔다 — 느린 러너는 회차를 덜 돌고 끝낸다.
const ROUNDS = 60; const BUDGET_MS = 30_000;

// 경쟁 자식 하나 — 부모의 지시(IPC)를 한 번에 하나씩 처리한다: stage(0번만, 오래된 잠금 깔기)·go(정한 시각에 잠금 시도)·end(결과).
function racer(dir, idx, signal) {
  const script = `
const { withDirLock } = await import(${JSON.stringify(MUTEX)});
const { mkdir, utimes, writeFile, readFile, rm } = await import('node:fs/promises');
const { join } = await import('node:path');
const lock = join(${JSON.stringify(dir)}, 'x.lock');
const mark = join(${JSON.stringify(dir)}, 'inside');
let overlaps = 0, entered = 0, staged = 0, maxWait = 0; const other = {}, fails = [], marks = [];
process.on('message', async ({ cmd, i, at }) => {
  if (cmd === 'stage') { // 두 자식이 모두 쉬는 중이라 잠금은 비어 있다 — 깔린 폴더는 내 것이라 시각을 돌려도 살아 있는 잠금을 건드리지 않는다
    if (await mkdir(lock).then(() => true, () => false)) { const old = new Date(Date.now() - 60_000); await utimes(lock, old, old).catch(() => {}); staged++; }
    return process.send({});
  }
  if (cmd === 'end') return process.send({ overlaps, entered, staged, maxWait, other, fails, marks });
  await new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));
  const asked = Date.now(); const before = fails.length;
  await withDirLock(lock, async () => {
    entered++; maxWait = Math.max(maxWait, Date.now() - asked);
    try { await writeFile(mark, '${idx}:' + i, { flag: 'wx' }); } catch (e) {
      // 겹침은 EEXIST(다른 프로세스가 잠금 안에서 만든 표식이 아직 있음)만이다. Windows는 방금 지운 파일이 "삭제 대기"로 남아 EPERM·EBUSY를
      // 낼 수 있다 — 그건 잠금 결함이 아니라 파일 시스템 상태라 따로 센다. 표식의 "프로세스:회차"로 같은 회차 동시 진입인지 남은 표식인지 가른다.
      if (e?.code === 'EEXIST') { overlaps++; marks.push('${idx}:' + i + '<-' + await readFile(mark, 'utf8').catch((x) => x?.code)); }
      else other[e?.code ?? 'unknown'] = (other[e?.code ?? 'unknown'] ?? 0) + 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 15));
    await rm(mark, { force: true });
  }, { retryMs: 5 }).catch((e) => { fails.push('r' + i + ' ' + (e?.code ?? e) + ' ' + (Date.now() - asked) + 'ms'); });
  process.send({ ok: fails.length === before });
});
process.send({ ready: true });`;
  // signal — 테스트가 끝나면(성공·실패·시간 초과 모두) node:test가 신호를 끊어 자식을 끝낸다
  const p = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], signal });
  let err = ''; p.stderr.on('data', (c) => { err += c; });
  const gone = new Promise((_, reject) => { p.on('error', reject); p.on('exit', (code) => reject(new Error(`경쟁 자식 ${idx}가 끝났다(${code}) ${err}`))); });
  gone.catch(() => {});
  const ready = Promise.race([new Promise((r) => p.once('message', r)), gone]); // 자식이 지시를 받을 준비가 됐다
  return async (msg) => { await ready; const reply = new Promise((r) => p.once('message', r)); p.send(msg); return Promise.race([reply, gone]); };
}

test('오래된 잠금을 두 프로세스가 동시에 회수해도 잠금 안에 둘이 같이 들어가지 않는다(60회차 겹침 0)', { timeout: 60_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-mutex-race-'));
  mkdirSync(dir, { recursive: true });
  const [A, B] = [racer(dir, 0, t.signal), racer(dir, 1, t.signal)];
  const until = Date.now() + BUDGET_MS; let rounds = 0;
  while (rounds < ROUNDS && Date.now() < until) {
    const i = rounds++;
    await A({ cmd: 'stage' });
    const at = Date.now() + 50; // 조금 앞 시각을 정해 두 자식이 타이머로 기다렸다 같이 출발한다
    const [ra, rb] = await Promise.all([A({ cmd: 'go', i, at }), B({ cmd: 'go', i, at })]);
    if (!ra.ok || !rb.ok) break; // 이미 실패한 테스트다 — 남은 회차마다 대기 상한(10초)을 쓰다 시간 초과로 사유를 잃지 않고 바로 보고한다
  }
  if (rounds < ROUNDS) t.diagnostic(`러너가 느려 ${BUDGET_MS / 1000}초 안에 ${rounds}회차만 돌았다`);
  const [a, b] = await Promise.all([A({ cmd: 'end' }), B({ cmd: 'end' })]);
  // 실패 사유를 메시지에 남긴다 — 잠금 실패는 "회차 오류코드 기다린시간", 겹침은 "들어간쪽:회차<-표식을 쓴쪽:회차"
  const why = `잠금 실패 [${[...a.fails, ...b.fails].join(', ')}], 최장 대기 ${Math.max(a.maxWait, b.maxWait)}ms, ${rounds}회차 중 오래된 잠금 깐 회차 ${a.staged}`;
  assert.equal(a.overlaps + b.overlaps, 0, `겹침 ${a.overlaps + b.overlaps}회 [${[...a.marks, ...b.marks].join(', ')}], 표식 기타 오류 ${JSON.stringify({ ...a.other, ...b.other })}, ${why}`);
  assert.equal(a.entered + b.entered, rounds * 2, `모든 회차에 둘 다 결국 잠금을 얻는다(회수가 막히지 않는다) — ${why}`);
  assert.ok(a.staged >= rounds / 2, `오래된 잠금을 깐 회차가 너무 적다(${a.staged}/${rounds}) — 회수 경로를 충분히 타지 않았다`);
});

test('2차 잠금을 늦게 얻은 쪽은 그사이 새로 잡힌 잠금을 지우지 않는다(재 stat) — 순서를 훅으로 고정한 결정적 재현', async () => {
  const { withDirLock } = await import('../src/mutex.mjs');
  const { mkdir, utimes } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'argo-mutex-order-'));
  const lock = join(dir, 'y.lock');
  await mkdir(lock);
  const old = new Date(Date.now() - 60_000); await utimes(lock, old, old); // 크래시가 남긴 오래된 잠금
  let inside = 0, maxInside = 0;
  const enter = async (hold) => { inside++; maxInside = Math.max(maxInside, inside); await hold; inside--; };
  // B: 오래된 잠금을 보고 회수하려다 2차 잠금 직전에 멈춘다
  let resumeB; const bPaused = new Promise((r) => { resumeB = r; });
  let bAtGuard; const bReached = new Promise((r) => { bAtGuard = r; });
  let releaseB; const holdB = new Promise((r) => { releaseB = r; });
  const opts = { staleMs: 5_000, retryMs: 5, timeoutMs: 3_000 };
  let firstB = true;
  const B = withDirLock(lock, () => enter(holdB), { ...opts, _hooks: { beforeGuard: async () => { if (firstB) { firstB = false; bAtGuard(); await bPaused; } } } });
  await bReached;
  // A: 그사이 회수 → 새 잠금 획득 → 잠금 안에서 머문다
  let releaseA; const holdA = new Promise((r) => { releaseA = r; });
  let aIn; const aEntered = new Promise((r) => { aIn = r; });
  const A = withDirLock(lock, async () => { aIn(); await enter(holdA); }, opts);
  await aEntered;
  resumeB(); // B가 2차 잠금을 늦게 얻는다 — 재 stat 없이 지우면 A의 새 잠금이 사라지고 B도 들어온다
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(maxInside, 1, 'A가 잠금 안에 있는 동안 B가 들어왔다 — 늦은 회수가 새 잠금을 지웠다');
  releaseA(); await A;
  releaseB(); await B;
  assert.equal(maxInside, 1);
});
