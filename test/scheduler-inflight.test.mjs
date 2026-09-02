// 스케줄러 루틴 in-flight 가드 — 같은 루틴의 실행 겹침 차단(검수 LOW-5, PR #349 후속).
//
// claimRoutine의 lastRun 선점은 **슬롯 단위**라, 인접 시각(times:['09:00','09:05'])에서
// 09:00 실행(완료 조건 재시도 포함 수 분)이 끝나기 전에 09:05 슬롯이 due가 되면 같은 루틴의
// runRoutine 두 개가 겹쳐 돌 수 있었다(검수 결정적 확인: lastRun=09:00:03에서
// isDue(09:05:10)=true). 가드는 consolidating/mailDelivering과 같은 계열의 프로세스 내 Set —
// 겹치면 이번 틱은 **선점 없이** 스킵해 슬롯을 소비하지 않고, 실행이 끝난 다음 틱이
// catch-up(4h 상한)으로 자연 회수한다. 임시 ARGO_ROOT 격리, 실행은 runFn 주입(LLM 불요).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-inflight-'));
const { runDueRoutines } = await import('../src/scheduler.mjs');
const { addRoutine, loadRoutines } = await import('../src/routines.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'ovlco';
await createCompany(WS, '겹침사', 'captain');
const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
// 미래(2099년) 고정 날짜 — created(지금)보다 뒤라 "생성 이전 시각 스킵" 규칙에 안 걸리고,
// 실제 시계와 무관하게 결정적이다. 시각은 이 기기 로컬 = addRoutine이 각인하는 tz와 일치.
const at = (h, m, s = 0) => new Date(2099, 0, 5, h, m, s);
const flush = () => new Promise((r) => setTimeout(r, 20)); // fire-and-forget의 finally가 돌 틈

test('인접 시각 슬롯: 실행 중이면 선점 없이 스킵, 끝난 뒤 틱이 catch-up으로 회수 (검수 LOW-5 핀)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '겹침 루틴', prompt: 'p', schedule: { type: 'daily', times: ['09:00', '09:05'] } });
  const other = await addRoutine(WS, { agentSlug: 'alpha', title: '딴 루틴', prompt: 'p', schedule: { type: 'daily', times: ['09:05'] } });
  const calls = [];
  let release;
  const gate = new Promise((res) => { release = res; });
  const runFn = (_ws, id) => { calls.push(id); return gate; }; // 실행이 수 분 걸리는 상황 — release 전까지 미완

  // 09:00 틱 — 첫 슬롯 실행 시작
  await runDueRoutines(WS, at(9, 0, 30), { runFn });
  assert.deepEqual(calls, [r.id], '전제: 09:00 슬롯이 돈다');
  const claimed = (await byId(r.id)).lastRun;

  // 09:05 틱 — 같은 루틴은 실행 중이라 스킵. 다른 루틴은 가드와 무관하게 돈다(루틴별 가드).
  await runDueRoutines(WS, at(9, 5, 10), { runFn });
  assert.deepEqual(calls, [r.id, other.id], '겹침 루틴의 두 번째 진입이 없어야 하고, 딴 루틴은 막히지 않아야 한다');
  assert.equal((await byId(r.id)).lastRun, claimed, '스킵은 선점하지 않는다 — 슬롯이 소비되면 catch-up이 불가능해진다');

  // 실행 종료 → 다음 틱이 놓친 09:05 슬롯을 회수
  release({});
  await flush();
  await runDueRoutines(WS, at(9, 6, 0), { runFn });
  assert.deepEqual(calls, [r.id, other.id, r.id], '가드가 풀리면 다음 틱이 09:05 슬롯을 catch-up 한다');
});

test('실행이 실패로 끝나도 가드가 풀린다 — 다음 due에 다시 돈다', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '실패 루틴', prompt: 'p', schedule: { type: 'interval', everyMinutes: 10 } });
  let calls = 0;
  const runFn = async () => { calls += 1; throw new Error('턴 실패'); };
  await runDueRoutines(WS, at(10, 0), { runFn });
  await flush();
  await runDueRoutines(WS, at(10, 11), { runFn });
  assert.equal(calls, 2, '실패 후 가드가 남아 있으면 그 루틴은 영영 멎는다');
});

test('가드 자가 치유: 실행이 영영 안 끝나도 상한(4h) 뒤에는 다시 돈다 (검수 MEDIUM-2 핀)', async () => {
  // SDK 러너 턴에는 타임아웃이 없다 — 안 끝나는 실행이 가드를 영구 점유하면 루틴이 '가동'
  // 표시인 채 프로세스 재시작 전까지 발화 0이 된다(LOW-3이 없앤 좀비의 재림). 앞 테스트들의
  // 루틴도 이 틱에 due일 수 있으므로 단언은 이 루틴의 호출 수로만 센다(파일 내 공유 WS).
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '행 루틴', prompt: 'p', schedule: { type: 'interval', everyMinutes: 10 } });
  const calls = [];
  const never = new Promise(() => {}); // settle하지 않는 실행 — SDK 행 재현
  const runFn = (_ws, id) => { calls.push(id); return never; };
  const mine = () => calls.filter((id) => id === r.id).length;
  await runDueRoutines(WS, at(11, 0), { runFn });
  assert.equal(mine(), 1, '전제: 첫 발화');
  await runDueRoutines(WS, at(11, 20), { runFn });
  assert.equal(mine(), 1, '상한 전 — 실행 중이라 스킵');
  await runDueRoutines(WS, at(15, 1), { runFn }); // 4h 1m 경과 — stale 무시(자가 치유)
  assert.equal(mine(), 2, '상한을 넘긴 가드 항목이 루틴을 영구 정지시키면 안 된다');
});

test('CAS 삭제: 뒤늦게 끝난 옛 실행이 새 실행의 가드를 지우지 못한다 (2R LOW-C 핀)', async () => {
  // stale 무시로 새 실행이 시작된 뒤 옛(행) 실행이 settle하면, finally가 무조건 delete일 때
  // 새 실행의 가드가 사라져 겹침이 재발한다 — 자기 스탬프일 때만 지우는 CAS가 그 창을 막는다.
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: 'CAS 루틴', prompt: 'p', schedule: { type: 'interval', everyMinutes: 10 } });
  const calls = [];
  let releaseOld;
  const oldGate = new Promise((res) => { releaseOld = res; });
  const never = new Promise(() => {});
  const mine = () => calls.filter((id) => id === r.id).length;
  const runFn = (_ws, id) => {
    calls.push(id);
    if (id !== r.id) return never;
    return mine() === 1 ? oldGate : never; // 1번째 = 뒤늦게 끝날 옛 실행, 2번째 = 계속 도는 새 실행
  };
  await runDueRoutines(WS, at(16, 0), { runFn });
  assert.equal(mine(), 1, '전제: 옛 실행 시작');
  await runDueRoutines(WS, at(20, 30), { runFn }); // 4h 초과 — stale 무시, 새 실행 시작
  assert.equal(mine(), 2, '전제: stale 승격으로 새 실행 시작');
  releaseOld({});
  await flush(); // 옛 실행이 뒤늦게 종료 — CAS라면 새 실행의 스탬프를 지우지 않는다
  await runDueRoutines(WS, at(20, 41), { runFn }); // 새 실행은 아직 in-flight — 스킵돼야 한다
  assert.equal(mine(), 2, '옛 실행의 종료가 새 실행의 가드를 지우면 겹침이 재발한다');
});

test('배선: 틱이 cloudLeader 게이트 아래에서 runDueRoutines를 호출한다 (fail-open 차단 핀)', async () => {
  // 행동 테스트는 runDueRoutines 자체만 잠근다 — 틱이 호출을 끊어도(void 처리) 전 스위트가
  // 초록이었다(분리 검수 LOW-2 변이 실증). 틱 콜백은 단위로 태울 수 없어 배선은 소스 앵커로 잠근다.
  const src = await readFile(new URL('../src/scheduler.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(cloudLeader\) await runDueRoutines\(cid, now\);/);
});
