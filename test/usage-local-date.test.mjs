// K40 — "오늘"·"이번 달" 경계는 기기 로컬 날짜다. 앱 서버(사이드카·상주)는 사용자 PC에서 돈다.
// UTC(toISOString) 경계면 한국은 오전 9시에 "오늘"이 넘어가고, 1일 0~9시 턴이 지난달로 잡히며
// 월 예산 상한(monthCost — chat·crewmail·compete·room·corrections 게이트)도 1일 9시에야 초기화된다.
// 시각은 mock.timers로 고정한다(2026-10-01 00:30 KST = 2026-09-30 15:30 UTC) — 실행 시각과 무관하게 결정적.
process.env.TZ = 'Asia/Seoul';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = process.env.USERPROFILE = await mkdtemp(join(tmpdir(), 'argo-localdate-home-'));
process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-localdate-'));
const { paths } = await import('../src/workspace.mjs');
const usage = await import('../src/usage.mjs');

const row = (ts, costUsd, slug = 'a') => ({ ts, kind: 'chat', slug, runner: 'claude', model: 'claude-sonnet-4-5', input: 1, output: 1, cacheRead: 0, cacheCreate: 0, costUsd, billed: true, ms: 1 });

test('KST 10월 1일 00:30 — 00:10(KST) 턴은 오늘·이번 달, 전날 23:50(KST) 턴은 지난달', async () => {
  assert.equal(new Date('2026-09-30T15:30:00Z').getDate(), 1, '전제: 이 프로세스의 시간대가 Asia/Seoul');
  const ws = 'localdate';
  await mkdir(paths(ws).root, { recursive: true });
  await writeFile(paths(ws).usage, [
    row('2026-09-30T14:50:00.000Z', 5, 'old'), // KST 09-30 23:50 — 지난달
    row('2026-09-30T15:10:00.000Z', 2, 'new'), // KST 10-01 00:10 — 오늘·이번 달
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-30T15:30:00Z') });
  try {
    const s = await usage.readUsageSummary(ws);
    assert.deepEqual([s.today.turns, s.today.costUsd], [1, 2], '오늘 = KST 10-01 턴 하나');
    assert.deepEqual([s.month.turns, s.month.costUsd], [1, 2], '이번 달 = 10월 턴 하나(9월 턴 제외)');
    assert.equal(s.total.turns, 2);
    assert.deepEqual(await usage.monthCost(ws), { costUsd: 2, subTurns: 0 }, '월 예산 상한은 1일 0시(KST)에 초기화');
    assert.deepEqual((await usage.monthCostByCrew(ws)).map((b) => b.slug), ['new']);
    assert.deepEqual(await usage.monthCostByRunner(ws), { claude: { turns: 1, costUsd: 2, hasCost: true } });
  } finally { mock.timers.reset(); }
});

test('ts가 없거나 깨진 행은 오늘·이번 달에 넣지 않는다(total에만)', async () => {
  const ws = 'localdate-bad';
  await mkdir(paths(ws).root, { recursive: true });
  await writeFile(paths(ws).usage, [row(undefined, 1), row('not-a-date', 1)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const s = await usage.readUsageSummary(ws);
  assert.deepEqual([s.today.turns, s.month.turns, s.total.turns], [0, 0, 2]);
  assert.equal((await usage.monthCost(ws)).costUsd, 0);
});
