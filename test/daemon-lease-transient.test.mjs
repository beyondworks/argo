// daemonLease 보유자가 갱신 중 일시 I/O 오류(Windows의 EPERM·EBUSY 등)를 한 번 겪어도 리더를 놓지 않는다.
// 원래 결함(2026-10-02, Windows CI sync-lock-leader "재시작 경쟁" 실패 — 끝 상태 B={proc:false,sched:true,cloud:true} A'={모두 false}):
// 갱신 쓰기 한 번이 실패하면 catch가 mine=false로 내렸다. 그런데 파일에는 보유자 이름과 5초 안쪽 시각이 남아 다른 프로세스는 리스를
// 존중해 가져가지 않는다 → 다음 박자(최대 5초)까지 게이트웨이를 맡은 프로세스가 0개(폴러·드레인 워커가 내려갔다 다시 뜬다).
// 같은 끝 상태를 B의 .gateway.lock 쓰기에 EPERM 1회 주입으로 그대로 재현했다.
// 불변식: 파일의 내 기록이 남에게 아직 살아 있는 동안만 리더를 유지하고, 다음 박자 전에 그 기록이 만료되면 먼저 내려놓는다(이중 실행 금지).
//
// 시계는 가짜(mock.timers: setInterval·setTimeout·Date)이고 리스 파일은 메모리에 둔다 — 진짜 시계로 재던 옛 테스트는 부하 상태에서
// 5/12 실패했다(2026-10-08 게이트 A). 두 번째 실패 박자가 유지 기준선(ttl - beat)에 정확히 걸려, 몇 ms 흔들림으로 판정이 갈렸다.
// 지금은 박자와 읽기 지연을 테스트가 정하므로 부하와 무관하게 같은 순서로 돈다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-'));
const files = new Map(); // 리스 파일 — 진짜 I/O는 가짜 시계 밖에서 끝나 박자 순서를 흔든다
const fault = { write: 0, read: 0, lag: 0 }; // 남은 쓰기·읽기 실패 횟수, 다음 읽기 한 번의 지연(ms, 가짜 시계)
const isLease = (f) => /\.(gateway|scheduler)\.lock$/.test(String(f));
const ioError = (code) => Object.assign(new Error(`${code}: lease file`), { code });
const realRead = fsp.readFile; const realWrite = fsp.writeFile;
fsp.readFile = async (f, ...a) => {
  if (!isLease(f)) return realRead(f, ...a);
  if (fault.lag) { const ms = fault.lag; fault.lag = 0; await new Promise((r) => setTimeout(r, ms)); }
  if (fault.read > 0) { fault.read--; throw ioError('EPERM'); }
  if (!files.has(String(f))) throw ioError('ENOENT');
  return files.get(String(f));
};
fsp.writeFile = async (f, data, ...a) => {
  if (!isLease(f)) return realWrite(f, data, ...a);
  if (fault.write > 0) { fault.write--; throw ioError('EPERM'); }
  files.set(String(f), String(data));
};
syncBuiltinESMExports(); // lock.mjs의 이름 가져오기(readFile·writeFile)가 위 대체본을 보게 한다
const { daemonLease } = await import('../src/lock.mjs');

const BEAT = 400; const TTL = 1200;
const T0 = 1_000_000;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate는 진짜다 — 메모리 파일이라 남은 마이크로태스크가 한 번에 다 돈다
/** 가짜 시계를 T0 기준 `at`ms까지 1ms씩 진행하고, 매 순간 check()를 부른다. */
async function advanceTo(t, at, check = () => {}) {
  await flush(); // 이미 시작된 흐름(daemonLease가 바로 부르는 첫 판정 등)을 지금 시각에서 먼저 진행시킨다 — 안 그러면 다음 타이머가 1ms 밀린다
  while (Date.now() - T0 < at) { t.mock.timers.tick(1); await flush(); check(); }
}
const recordTs = (name) => JSON.parse(files.get(join(process.env.ARGO_ROOT, `.${name}.lock`))).ts;

test('보유자의 갱신 쓰기·확인 읽기가 한 번 실패해도 리더 유지, 계속 실패하면 내 기록이 만료되기 전에 내려놓는다', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  const lease = daemonLease('gateway', { ttl: TTL, beat: BEAT }); // 박자: T0+400k
  await advanceTo(t, 150);
  await lease.ready;
  assert.equal(lease.isLeader(), true, '혼자 켜진 리스는 첫 판정에 리더');
  const stayLeader = (why) => () => assert.equal(lease.isLeader(), true, `${why} 뒤 +${Date.now() - T0}ms에 리더를 놓았다`);

  // 갱신 쓰기 1회 실패 — 그 박자의 판정이 100ms 늦어도(읽기 지연) 직전 내 기록은 남에게 아직 살아 있다 → 유지(수정 전 10/2: 1박자 공백)
  fault.write = 1; fault.lag = 100;
  await advanceTo(t, 1150, stayLeader('쓰기 실패'));
  assert.equal(fault.write, 0, '쓰기 실패 주입이 실제로 소비됐다');

  // 확인 읽기 1회 실패 — 판정 읽기·확인 읽기 둘 다 실패시킨다(판정 읽기 실패는 선점 시도로 넘어가고, 확인 읽기 실패가 catch로 간다)
  fault.read = 2;
  await advanceTo(t, 1550, stayLeader('확인 읽기 실패'));
  assert.equal(fault.read, 0, '읽기 실패 주입이 실제로 소비됐다');

  // 계속 실패 — 마지막 성공 박자(T0+1600)의 읽기가 150ms 늦어 기록 ts가 뒤로 밀렸고(1750), 세 번째 실패 박자의 판정도 160ms 늦다.
  // 수정 전에는 두 번째 실패 박자(2400, 기록 뒤 650ms)가 기준선 800ms 안이라 유지하고, 세 번째 박자 판정(2960)에야 내려놓아
  // 내 기록 만료(2950) 뒤 10ms 동안 리더였다 — 그사이 다른 프로세스가 만료로 보고 가져가면 이중 실행이다.
  fault.lag = 150;
  await advanceTo(t, 1900, stayLeader('정상 갱신'));
  const lastOk = recordTs('gateway');
  assert.equal(lastOk - T0, 1750, '마지막 성공 기록은 읽기 지연만큼 뒤로 밀린 시각');
  fault.write = 1e9;
  let droppedAt = 0;
  const notPastExpiry = () => {
    if (lease.isLeader()) assert.ok(Date.now() - lastOk < TTL, `내 기록이 만료(${TTL}ms)된 뒤에도 리더(기록 뒤 ${Date.now() - lastOk}ms) — 그사이 남이 가져가면 이중 실행`);
    else droppedAt ||= Date.now();
  };
  await advanceTo(t, 2799, notPastExpiry);
  fault.lag = 160;
  await advanceTo(t, 3000, notPastExpiry);
  assert.ok(droppedAt, '계속 실패하는데도 리더를 놓지 않았다');
  assert.ok(lastOk + TTL - droppedAt >= BEAT / 2, `만료 직전(${lastOk + TTL - droppedAt}ms 전)에야 내려놓았다 — 다음 박자가 조금만 늦어도 이중 실행`);

  // 회복 — 쓰기가 다시 되면 다음 박자(3200)에 리더로 돌아온다
  fault.write = 0;
  await advanceTo(t, 3400);
  assert.equal(lease.isLeader(), true, '회복 후 다시 리더');
});

test('살아 있는 남의 리스는 여전히 존중한다(일시 오류 처리로 남의 리스를 빼앗지 않는다)', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  // 다른 리스 이름(다른 파일)으로 — 앞 테스트의 gateway 리스는 멈출 방법이 없어(가짜 타이머는 테스트 끝에 사라지지만) 이름을 나눠 둔다
  const lease = daemonLease('scheduler', { ttl: TTL, beat: BEAT });
  await advanceTo(t, 150);
  await lease.ready;
  const other = () => files.set(join(process.env.ARGO_ROOT, '.scheduler.lock'), JSON.stringify({ owner: 'other-1', ts: Date.now() }));
  await advanceTo(t, 200); other();
  for (let at = 400; at <= 1400; at += 200) {
    await advanceTo(t, at, () => { if (Date.now() - T0 > 400) assert.equal(lease.isLeader(), false, `+${Date.now() - T0}ms에 남의 살아 있는 리스를 가져갔다`); });
    other();
  }
  assert.equal(lease.isLeader(), false);
});
