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
import { mkdtemp } from 'node:fs/promises';
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
