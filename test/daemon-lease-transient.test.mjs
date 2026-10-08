// daemonLease 보유자가 갱신 중 일시 I/O 오류(Windows의 EPERM·EBUSY 등)를 한 번 겪어도 리더를 놓지 않는다.
// 원래 결함(2026-10-02, Windows CI sync-lock-leader "재시작 경쟁" 실패 — 끝 상태 B={proc:false,sched:true,cloud:true} A'={모두 false}):
// 갱신 쓰기 한 번이 실패하면 catch가 mine=false로 내렸다. 그런데 파일에는 보유자 이름과 5초 안쪽 시각이 남아 다른 프로세스는 리스를
// 존중해 가져가지 않는다 → 다음 박자(최대 5초)까지 게이트웨이를 맡은 프로세스가 0개(폴러·드레인 워커가 내려갔다 다시 뜬다).
// 같은 끝 상태를 B의 .gateway.lock 쓰기에 EPERM 1회 주입으로 그대로 재현했다.
// 불변식: 파일의 내 기록이 남에게 아직 살아 있는 동안만 리더를 유지하고, 다음 박자 전에 그 기록이 만료되면 먼저 내려놓는다(이중 실행 금지).
//
// 시계는 가짜(mock.timers: setInterval·setTimeout·Date)이고 리스 파일은 메모리에 둔다 — 진짜 시계로 재던 옛 테스트는 부하 상태에서
// 실패했다(2026-10-08 게이트 A 5/12, 로컬 재현 3/12). 두 번째 실패 박자가 유지 기준선(ttl - beat)에 정확히 걸려 몇 ms 흔들림으로 판정이
// 갈렸다. 지금은 박자와 읽기 지연을 테스트가 정하므로 부하와 무관하게 같은 순서로 돈다. 축척은 운영 기본값(15초/5초)이다 — 고정 150ms
// 확인 대기가 박자에서 차지하는 비율까지 운영과 같아야 기준선 여유를 운영 그대로 잰다(검수 L-4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const ROOT = await mkdtemp(join(tmpdir(), 'argo-lease-'));
process.env.ARGO_ROOT = ROOT;
const files = new Map(); // 리스 파일 — 진짜 I/O는 가짜 시계 밖에서 끝나 박자 순서를 흔든다
// 남은 쓰기·읽기 실패 횟수, 다음 읽기 한 번의 지연(ms, 가짜 시계), 멈춤(이후 리스 I/O가 오류 없이 영영 안 끝난다)
const fault = { write: 0, read: 0, lag: 0, hang: false };
const isLease = (f) => String(f).startsWith(ROOT) && String(f).endsWith('.lock');
const ioError = (code) => Object.assign(new Error(`${code}: lease file`), { code });
const realRead = fsp.readFile; const realWrite = fsp.writeFile;
fsp.readFile = async (f, ...a) => {
  if (!isLease(f)) return realRead(f, ...a);
  if (fault.hang) return new Promise(() => {});
  if (fault.lag) { const ms = fault.lag; fault.lag = 0; await new Promise((r) => setTimeout(r, ms)); }
  if (fault.read > 0) { fault.read--; throw ioError('EPERM'); }
  if (!files.has(String(f))) throw ioError('ENOENT');
  return files.get(String(f));
};
fsp.writeFile = async (f, data, ...a) => {
  if (!isLease(f)) return realWrite(f, data, ...a);
  if (fault.hang) return new Promise(() => {});
  if (fault.write > 0) { fault.write--; throw ioError('EPERM'); }
  files.set(String(f), String(data));
};
syncBuiltinESMExports(); // lock.mjs의 이름 가져오기(readFile·writeFile)가 위 대체본을 보게 한다
const { daemonLease } = await import('../src/lock.mjs');

const BEAT = 5000; const TTL = 15000; // lock.mjs 기본값과 같다
const T0 = 1_000_000;
const now = () => Date.now() - T0;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate는 진짜다 — 메모리 파일이라 남은 마이크로태스크가 한 번에 다 돈다
/** 가짜 시계를 T0 기준 `at`ms까지 1ms씩 진행하고, 매 순간 check()를 부른다. */
async function advanceTo(t, at, check = () => {}) {
  await flush(); // 이미 시작된 흐름(daemonLease가 바로 부르는 첫 판정 등)을 지금 시각에서 먼저 진행시킨다 — 안 그러면 다음 타이머가 1ms 밀린다
  while (now() < at) { t.mock.timers.tick(1); await flush(); check(); }
}
const record = (name) => JSON.parse(files.get(join(ROOT, `.${name}.lock`)));
const start = (t, name) => {
  Object.assign(fault, { write: 0, read: 0, lag: 0, hang: false });
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
  return daemonLease(name, { ttl: TTL, beat: BEAT }); // 박자: T0 + 5000k
};
/** 리더인 동안 내 마지막 기록이 남에게 아직 살아 있어야 한다(만료 = 기록 ts + ttl부터 남이 가져간다). */
const notPastExpiry = (lease, name, onDrop) => () => {
  if (!lease.isLeader()) return onDrop?.(now());
  const age = Date.now() - record(name).ts;
  assert.ok(age < TTL, `내 기록이 만료(${TTL}ms)된 뒤에도 리더(기록 뒤 ${age}ms, +${now()}ms) — 그사이 남이 가져가면 이중 실행`);
};

test('보유자의 갱신 쓰기·확인 읽기가 한 번 실패해도 리더 유지, 계속 실패하면 두 번째 실패 박자에서 내려놓는다', async (t) => {
  const lease = start(t, 'gateway');
  await advanceTo(t, 150);
  await lease.ready;
  assert.equal(lease.isLeader(), true, '혼자 켜진 리스는 첫 판정에 리더');
  const stayLeader = (why) => () => assert.equal(lease.isLeader(), true, `${why} 뒤 +${now()}ms에 리더를 놓았다`);

  // 갱신 쓰기 1회 실패 — 그 박자의 판정이 2초 늦어도(읽기 지연) 직전 내 기록은 남에게 아직 살아 있다 → 유지(수정 전 10/2: 1박자 공백)
  fault.write = 1; fault.lag = 2000;
  await advanceTo(t, 14000, stayLeader('쓰기 실패'));
  assert.equal(fault.write, 0, '쓰기 실패 주입이 실제로 소비됐다');

  // 확인 읽기 1회 실패 — 판정 읽기·확인 읽기 둘 다 실패시킨다(보유자의 판정 읽기 실패는 갱신으로 넘어가고, 확인 읽기 실패가 catch로 간다)
  fault.read = 2;
  await advanceTo(t, 19000, stayLeader('확인 읽기 실패'));
  assert.equal(fault.read, 0, '읽기 실패 주입이 실제로 소비됐다');

  // 계속 실패 — 마지막 성공 박자(+20000)의 읽기가 1.5초 늦어 기록 ts가 뒤로 밀렸고(+21500), 세 번째 실패 박자의 판정도 1.6초 늦다.
  // 수정 전에는 두 번째 실패 박자(+30000, 기록 뒤 8.5초)가 기준선 10초 안이라 유지하고, 세 번째 박자 판정(+36600)에야 내려놓아
  // 내 기록 만료(+36500) 뒤까지 리더였다 — 그사이 다른 프로세스가 만료로 보고 가져가면 이중 실행이다.
  fault.lag = 1500;
  await advanceTo(t, 21650, stayLeader('정상 갱신'));
  assert.equal(record('gateway').ts - T0, 21500, '마지막 성공 기록은 읽기 지연만큼 뒤로 밀린 시각');
  fault.write = 1e9;
  const check = notPastExpiry(lease, 'gateway');
  await advanceTo(t, 30000, check);
  assert.equal(lease.isLeader(), false, '두 번째 연속 실패 박자(+30000)에서 내려놓지 않았다 — 다음 박자를 기다리면 만료 직전·직후에 걸린다');
  await advanceTo(t, 34999, check);
  fault.lag = 1600;
  await advanceTo(t, 37000, check);

  // 회복 — 쓰기가 다시 되면 다음 박자(+40000)에 리더로 돌아온다
  fault.write = 0;
  await advanceTo(t, 40500);
  assert.equal(lease.isLeader(), true, '회복 후 다시 리더');
});

test('리스 I/O가 오류 없이 멈춰 판정이 오지 않아도 내 기록이 만료되기 전에 리더가 아니다', async (t) => {
  // catch는 실패가 돌아와야 실행된다 — 읽기·쓰기가 영영 안 끝나면 판정으로는 못 내린다(검수 M-1: 남이 가져간 뒤에도 계속 리더)
  const lease = start(t, 'hang');
  await advanceTo(t, 150);
  await lease.ready;
  assert.equal(lease.isLeader(), true);
  await advanceTo(t, 4000);
  fault.hang = true;
  let droppedAt = 0;
  await advanceTo(t, 20000, notPastExpiry(lease, 'hang', (at) => { droppedAt ||= at; }));
  assert.ok(droppedAt, 'I/O가 멈췄는데도 리더를 놓지 않았다');
  assert.ok(droppedAt <= TTL - BEAT / 2, `내 기록 만료(+${TTL}) 직전(+${droppedAt})에야 내려놓았다 — 박자 절반 여유가 없다`);
});

test('살아 있는 남의 리스는 존중한다 — 판정 읽기 오류를 "파일 없음"으로 보고 빼앗지 않는다', async (t) => {
  // 다른 리스 이름(다른 파일)으로 — 앞 테스트의 리스와 기록이 섞이지 않게 한다
  const lease = start(t, 'scheduler');
  await advanceTo(t, 150);
  await lease.ready;
  const other = () => files.set(join(ROOT, '.scheduler.lock'), JSON.stringify({ owner: 'other-1', ts: Date.now() }));
  const notLeader = () => { if (now() >= 5000) assert.equal(lease.isLeader(), false, `+${now()}ms에 남의 살아 있는 리스를 가져갔다`); };
  await advanceTo(t, 2500); other(); // 남이 박자 사이(+2500, +7500 …)에 갱신한다
  await advanceTo(t, 7500, notLeader); other();
  // 다음 판정 읽기(+10000)에 EPERM — 수정 전에는 '파일 없음'으로 보고 선점 쓰기를 해 +10150부터 남의 리스 위에서 리더였다(검수 M-2)
  fault.read = 1;
  await advanceTo(t, 10200, notLeader);
  assert.equal(fault.read, 0, '읽기 실패 주입이 실제로 소비됐다');
  assert.equal(record('scheduler').owner, 'other-1', '읽기 오류 뒤 남의 리스 기록을 덮어썼다');
  await advanceTo(t, 12500, notLeader); other();
  await advanceTo(t, 20000, notLeader);
});
