// 스케줄러 틱 배선(행동) — 60초 틱이 회사마다 무엇을 리더 게이트 안팎에서 부르는가를 가짜 일(jobs)로 잠근다.
// 그동안 이 배선은 소스 문자열 앵커로만 잠겨 있었다(crewmail·runner-health·failure-digest 테스트) — 앵커는 `null &&`·죽은 코드 변이에 초록이다.
// 능동 비서(feat/assistant-engine-calendar)가 이 틱에 한 줄을 더하기 전에, 지금 부르는 일(루틴·우편·검진·다이제스트·기억 정리)을 먼저 고정했다(커밋 581fde14).
// 비서 감시기(tickAssistant)는 리더만, 회사 처리의 맨 끝 — 던져도 같은 회사의 앞 일과 다음 회사를 막지 않는다(아래 C13 칸).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-tickwire-'));
const { schedulerTick } = await import('../src/scheduler.mjs');

const leader = { isLeader: () => true };
const flush = () => new Promise((r) => setTimeout(r, 20));
const at = (h, m = 0) => new Date(2026, 9, 8, h, m); // 기기 로컬 — 기억 정리 시각(04:00) 판정이 로컬 hh:mm이다

function fakeJobs({ companies = ['c1', 'c2'], claim = true, throwRoutinesFor = null, mailGate = null, throwAssistant = false } = {}) {
  const calls = [];
  const rec = (name) => (cid) => { calls.push(`${name}:${cid}`); };
  return {
    calls,
    jobs: {
      listCompanyIds: async () => { calls.push('list'); return companies; },
      runDueRoutines: async (cid) => { calls.push(`routines:${cid}`); if (cid === throwRoutinesFor) throw new Error('손상 routines.json'); },
      deliverCrewMail: (cid) => { calls.push(`mail:${cid}`); return mailGate ?? Promise.resolve(); },
      tickHealthCheck: rec('health'),
      tickFailureDigest: rec('digest'),
      tickAssistant: (cid) => { calls.push(`assistant:${cid}`); if (throwAssistant) throw new Error('비서 틱 동기 예외'); return true; },
      claimConsolidate: async (cid) => { calls.push(`claim:${cid}`); return claim ? { attempts: 1, nextRetryAt: null } : null; },
      consolidateBacklog: async (cid) => { calls.push(`consolidate:${cid}`); return { chunks: 0, bytes: 0, notes: [], stoppedBy: 'empty' }; },
      rollupJournals: async (cid) => { calls.push(`rollup:${cid}`); },
      markConsolidateDone: async (cid) => { calls.push(`done:${cid}`); },
      bumpConsolidateClaim: async () => {},
    },
  };
}

test('클라우드 리더 + 04:00 이후 — 회사마다 루틴·우편·검진·다이제스트·기억 정리(선점→정리→주간 접기→완료)를 부른다', async () => {
  const { calls, jobs } = fakeJobs();
  await schedulerTick(leader, { jobs, now: at(9), cloudLeader: true });
  await flush();
  for (const cid of ['c1', 'c2']) {
    for (const name of ['routines', 'mail', 'health', 'digest', 'claim', 'consolidate', 'rollup', 'done', 'assistant']) {
      assert.ok(calls.includes(`${name}:${cid}`), `${name}:${cid} 호출이 빠졌다 — ${calls.join(' ')}`);
    }
  }
  assert.ok(calls.indexOf('routines:c1') < calls.indexOf('mail:c1') && calls.indexOf('mail:c1') < calls.indexOf('health:c1'), '회사 안 순서: 루틴 → 우편 → 검진');
});

test('클라우드 리더가 아니면 — 우편 배달만(기기 로컬 큐), 루틴·검진·다이제스트·기억 정리는 0', async () => {
  const { calls, jobs } = fakeJobs();
  await schedulerTick(leader, { jobs, now: at(9), cloudLeader: false });
  await flush();
  assert.deepEqual(calls.filter((c) => c !== 'list').sort(), ['mail:c1', 'mail:c2']);
});

test('프로세스 리스(daemonLease)가 없으면 — 회사 목록조차 읽지 않는다', async () => {
  const { calls, jobs } = fakeJobs();
  await schedulerTick({ isLeader: () => false }, { jobs, now: at(9), cloudLeader: true });
  assert.deepEqual(calls, []);
});

test('04:00 전 — 기억 정리 선점을 시도하지 않는다(나머지는 그대로)', async () => {
  const { calls, jobs } = fakeJobs({ companies: ['c1'] });
  await schedulerTick(leader, { jobs, now: at(3, 59), cloudLeader: true });
  await flush();
  assert.equal(calls.some((c) => c.startsWith('claim:')), false);
  assert.ok(['routines:c1', 'mail:c1', 'health:c1', 'digest:c1'].every((c) => calls.includes(c)), calls.join(' '));
});

test('회사 하나의 오류는 그 회사에서 멈추고 다음 회사는 끝까지 돈다(회사별 오류 격리)', async () => {
  const { calls, jobs } = fakeJobs({ throwRoutinesFor: 'c1' });
  await schedulerTick(leader, { jobs, now: at(9), cloudLeader: true });
  await flush();
  assert.equal(calls.includes('mail:c1'), false, '같은 회사의 뒤 일은 그 틱에서 멈춘다(종전 동작)');
  for (const name of ['routines', 'mail', 'health', 'digest', 'claim']) assert.ok(calls.includes(`${name}:c2`), `${name}:c2`);
});

test('우편 배달이 아직 끝나지 않았으면 다음 틱은 그 회사 배달을 다시 시작하지 않는다(틱 겹침 이중 진입 가드)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { calls, jobs } = fakeJobs({ companies: ['c1'], mailGate: gate });
  await schedulerTick(leader, { jobs, now: at(9), cloudLeader: false });
  await schedulerTick(leader, { jobs, now: at(9, 1), cloudLeader: false });
  assert.equal(calls.filter((c) => c === 'mail:c1').length, 1, '배달 중 재진입 0');
  release(); await flush();
  await schedulerTick(leader, { jobs, now: at(9, 2), cloudLeader: false });
  assert.equal(calls.filter((c) => c === 'mail:c1').length, 2, '끝난 뒤 다음 틱은 다시 배달');
});

test('C13: 비서 감시기 — 클라우드 리더만 회사마다 한 번, 리더가 아니면 0. 동기 예외를 던져도 같은 회사의 앞 일·다음 회사는 그대로', async () => {
  const { calls, jobs } = fakeJobs();
  await schedulerTick(leader, { jobs, now: at(9), cloudLeader: false });
  assert.equal(calls.some((c) => c.startsWith('assistant:')), false, '리더 아닌 기기 — 비서 호출 0');
  const t = fakeJobs({ throwAssistant: true });
  await schedulerTick(leader, { jobs: t.jobs, now: at(9), cloudLeader: true });
  await flush();
  assert.deepEqual(t.calls.filter((c) => c.startsWith('assistant:')), ['assistant:c1', 'assistant:c2']);
  for (const name of ['routines', 'mail', 'health', 'digest', 'claim']) assert.ok(t.calls.includes(`${name}:c2`), `${name}:c2 — 앞 회사의 비서 예외가 다음 회사를 막지 않는다`);
  assert.ok(t.calls.indexOf('claim:c1') < t.calls.indexOf('assistant:c1'), '비서는 회사 처리의 맨 끝 — 기억 정리 선점보다 뒤');
});
