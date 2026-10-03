// daemonLease 보유자가 갱신 중 일시 I/O 오류(Windows의 EPERM·EBUSY 등)를 한 번 겪어도 리더를 놓지 않는다.
// 원래 결함(2026-10-02, Windows CI sync-lock-leader "재시작 경쟁" 실패 — 끝 상태 B={proc:false,sched:true,cloud:true} A'={모두 false}):
// 갱신 쓰기 한 번이 실패하면 catch가 mine=false로 내렸다. 그런데 파일에는 보유자 이름과 5초 안쪽 시각이 남아 다른 프로세스는 리스를
// 존중해 가져가지 않는다 → 다음 박자(최대 5초)까지 게이트웨이를 맡은 프로세스가 0개(폴러·드레인 워커가 내려갔다 다시 뜬다).
// 같은 끝 상태를 B의 .gateway.lock 쓰기에 EPERM 1회 주입으로 그대로 재현했다.
// 불변식: 파일의 내 기록이 남에게 아직 살아 있는 동안만 리더를 유지하고, 다음 박자 전에 그 기록이 만료되면 먼저 내려놓는다(이중 실행 금지).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

const root = await mkdtemp(join(tmpdir(), 'argo-lease-'));
process.env.ARGO_ROOT = root;
const fail = { write: 0, read: 0 }; // 남은 주입 횟수 — .gateway.lock 대상만
const realWrite = fsp.writeFile; const realRead = fsp.readFile;
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
fsp.writeFile = async (f, ...a) => { if (String(f).endsWith('.gateway.lock') && fail.write > 0) { fail.write--; throw eperm(); } return realWrite(f, ...a); };
fsp.readFile = async (f, ...a) => { if (String(f).endsWith('.gateway.lock') && fail.read > 0) { fail.read--; throw eperm(); } return realRead(f, ...a); };
syncBuiltinESMExports(); // lock.mjs의 이름 가져오기(readFile·writeFile)가 위 대체본을 보게 한다
const { daemonLease } = await import('../src/lock.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BEAT = 400; const TTL = 1200;

test('보유자의 갱신 쓰기·확인 읽기가 한 번 실패해도 리더 유지, 계속 실패하면 내 기록이 만료되기 전에 내려놓는다', async () => {
  const lease = daemonLease('gateway', { ttl: TTL, beat: BEAT });
  await lease.ready;
  assert.equal(lease.isLeader(), true, '혼자 켜진 리스는 첫 판정에 리더');

  // 갱신 쓰기 1회 실패 — 파일에는 직전 내 기록(1박자 전)이 남아 남들은 존중한다 → 리더 유지(수정 전: false로 떨어져 1박자 공백)
  fail.write = 1;
  for (let t = 0; t < 2 * BEAT; t += 50) { await sleep(50); assert.equal(lease.isLeader(), true, `쓰기 실패 뒤 ${t}ms에 리더를 놓았다`); }
  assert.equal(fail.write, 0, '주입이 실제로 소비됐다');

  // 확인 읽기 1회 실패도 같다
  fail.read = 2; // 판정 읽기 + 확인 읽기 중 하나는 실패한다
  for (let t = 0; t < 2 * BEAT; t += 50) { await sleep(50); assert.equal(lease.isLeader(), true, `읽기 실패 뒤 ${t}ms에 리더를 놓았다`); }

  // 계속 실패 — 마지막으로 쓴 내 기록은 TTL 뒤 남에게 만료로 보인다. 그 전에 반드시 내려놓아야 이중 실행이 없다.
  await sleep(BEAT); // 정상 박자 하나로 기록을 새로 남긴다
  const lastOk = JSON.parse(await realRead(join(root, '.gateway.lock'), 'utf8')).ts;
  fail.write = 1e9;
  let droppedAt = 0;
  while (Date.now() - lastOk < TTL + BEAT) { await sleep(25); if (!lease.isLeader()) { droppedAt = Date.now(); break; } }
  fail.write = 0;
  assert.ok(droppedAt, '계속 실패하는데도 리더를 놓지 않았다');
  assert.ok(droppedAt - lastOk < TTL, `내 기록이 만료(${TTL}ms)된 뒤에야 내려놓았다(${droppedAt - lastOk}ms) — 그사이 남이 가져가면 이중 실행`);

  // 회복 — 쓰기가 다시 되면 리더로 돌아온다
  await sleep(2 * BEAT);
  assert.equal(lease.isLeader(), true, '회복 후 다시 리더');
});

test('살아 있는 남의 리스는 여전히 존중한다(일시 오류 처리로 남의 리스를 빼앗지 않는다)', async () => {
  const lease = daemonLease('gateway', { ttl: TTL, beat: BEAT });
  await lease.ready;
  const other = () => realWrite(join(root, '.gateway.lock'), JSON.stringify({ owner: 'other-1', ts: Date.now() }));
  await other();
  for (let i = 0; i < 6; i++) { await sleep(BEAT / 2); await other(); }
  assert.equal(lease.isLeader(), false);
});
