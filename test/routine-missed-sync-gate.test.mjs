// 놓친 루틴 회차 판정의 동기화 관문(fix/routine-failure-visible 검수 MEDIUM).
// 동기화가 켜진 기기는 기동·잠자기 복귀 직후 routines.json이 낡아 있을 수 있다(다른 기기가 그동안 실행한 lastRun을 아직 못 받음).
// 그 사본으로 놓친 회차를 판정하면 ① 다른 기기가 실제로 실행한 회차를 '기기가 꺼져 있어 건너뛰었습니다'로 알리고 ② routines.json에 missed를 써
// 로컬 수정 시각이 최신이 되어, 동기화의 json 충돌 처리(최근 수정 시각이 이김)가 낡은 사본으로 원격(다른 기기의 lastRun·편집·새 루틴)을 덮는다.
// 잠그는 행동: 동기화가 켜져 있으면 이 프로세스가 깨어난 뒤 그 회사의 동기화 사이클을 한 번 끝내기 전까지 판정하지 않는다(쓰기 0·알림 0).
// 동기화가 꺼져 있으면 이 기기가 정본이라 종전대로 판정한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-rtn-syncgate-'));
for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ARGO_SYNC']) delete process.env[key];
// 동기화 on을 강제 — 가짜 기기 세션(전부 가짜 값, 네트워크 호출 없음). tg-token-claims.test.mjs와 같은 방법.
await writeFile(join(process.env.ARGO_ROOT, '.device-session.json'), JSON.stringify({ url: 'https://fake.supabase.co', anonKey: 'fake-anon', refresh_token: 'fake-r', access_token: 'fake-a', user: { id: 'fake-uid' } }));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, loadRoutines } = await import('../src/routines.mjs');
const { readEvents } = await import('../src/events.mjs');
const { onNotify } = await import('../src/notify.mjs');
const { runDueRoutines, noteSchedulerTick, RESUME_GAP_MS } = await import('../src/scheduler.mjs');
const { syncOn, companySyncedSince } = await import('../src/sync.mjs');
const { writeJsonAtomic } = await import('../src/jsonstore.mjs');

const status = globalThis.__argoSyncStatus; // 동기화 사이클이 회사마다 남기는 결과(sync.mjs) — 사이클을 돌리는 대신 결과를 심는다
const kst = (d, hm) => new Date(`${d}T${hm}:00+09:00`);
const NOW = kst('2026-10-08', '15:00'); // 오늘 09:00 슬롯은 catch-up 창(4h) 밖 — 실행 판정(claimRoutine)이 끼지 않는다
const WOKE = NOW.getTime() - 5 * 60_000; // 이 프로세스가 깨어난(기동·잠자기 복귀) 시각

let seq = 0;
async function staleCompany() {
  const ws = `syncgate-${++seq}`;
  await createCompany(ws, '동기화 관문', 'owner', null, 'ko');
  await mkdir(paths(ws).agents, { recursive: true });
  await writeFile(join(paths(ws).agents, 'alpha.md'), '---\nname: 알파\nrole: 검증\n---\n검증용.\n');
  // 이 기기 사본: lastRun이 일주일 전에 멈춰 있다(다른 기기가 그 뒤로 매일 실행했지만 아직 못 받은 상태)
  const r = await addRoutine(ws, { agentSlug: 'alpha', title: '아침 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'], tz: 'Asia/Seoul' } });
  const raw = await loadRoutines(ws);
  Object.assign(raw.find((x) => x.id === r.id), { lastRun: kst('2026-10-01', '09:00').toISOString(), created: '2026-09-01T00:00:00.000Z', editedAt: '2026-09-01T00:00:00.000Z' });
  await writeJsonAtomic(paths(ws).routines, raw);
  return ws;
}
async function tick(ws, opts = {}) {
  const before = await readFile(paths(ws).routines, 'utf8');
  const got = [];
  const off = onNotify((e) => { if (e.wsId === ws && e.type === 'routine') got.push(e); });
  await runDueRoutines(ws, NOW, { runFn: async () => { throw new Error('실행되면 안 된다'); }, awakeSince: WOKE, ...opts });
  await new Promise((r) => setTimeout(r, 20)); off();
  return {
    wrote: before !== await readFile(paths(ws).routines, 'utf8'),
    skipped: (await readEvents(ws)).filter((e) => e.type === 'routine-skipped').length,
    notices: got.length,
  };
}

test('전제 — 이 테스트 프로세스는 동기화 on(가짜 기기 세션)', () => {
  assert.equal(syncOn(), true);
});

test('B14: 깨어난 뒤 그 회사 동기화가 아직 없으면(낡은 routines.json) 놓친 회차를 판정하지 않는다 — 쓰기 0·활동 0·알림 0', async () => {
  const ws = await staleCompany();
  delete status.companies[ws];
  assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 },
    '다른 기기가 실행한 회차를 "꺼져 있어 건너뛰었다"로 알리거나, 낡은 사본에 missed를 써 원격을 덮을 수 있는 쓰기를 만들면 안 된다');
});

test('B15: 잠자기 복귀 — 깨기 전에 끝난 동기화 결과만 있으면 아직 판정하지 않는다', async () => {
  const ws = await staleCompany();
  status.companies[ws] = { ts: WOKE - 60_000, pulled: 0, pushed: 0, failed: 0 };
  assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 });
});

test('B17: 깨어난 뒤 사이클이 오류·재시도 대기·업로드 거절 대기면 다음 사이클까지 미룬다', async () => {
  for (const entry of [{ error: 'syncgate: 파일 1건 실패' }, { skipped: 'retry-backoff' }, { skipped: 'upload-denied' }]) {
    const ws = await staleCompany();
    status.companies[ws] = { ts: WOKE + 1_000, ...entry };
    assert.deepEqual(await tick(ws), { wrote: false, skipped: 0, notices: 0 }, JSON.stringify(entry));
  }
});

test('B16: 깨어난 뒤 그 회사 사이클이 끝났으면(정상·유휴 확인·free-plan·foreign-owner) 종전대로 남긴다', async () => {
  for (const entry of [{ pulled: 1, pushed: 0, failed: 0 }, { skipped: 'idle-probe', failed: 0 }, { skipped: 'free-plan' }, { skipped: 'foreign-owner' }]) {
    const ws = await staleCompany();
    status.companies[ws] = { ts: WOKE + 1_000, ...entry };
    const got = await tick(ws);
    assert.equal(got.wrote, true, JSON.stringify(entry));
    assert.equal(got.skipped, 1, JSON.stringify(entry));
    assert.equal(got.notices, 1, JSON.stringify(entry));
  }
});

test('B18: 동기화가 꺼져 있으면 이 기기가 정본 — 동기화 결과 없이도 종전대로 남긴다', async () => {
  const ws = await staleCompany();
  delete status.companies[ws];
  process.env.ARGO_SYNC = '0';
  try {
    assert.equal(syncOn(), false);
    const got = await tick(ws);
    assert.equal(got.skipped, 1); assert.equal(got.notices, 1);
  } finally { delete process.env.ARGO_SYNC; }
});

test('companySyncedSince — 판정 표(순수 부분)', () => {
  const ws = 'syncgate-table';
  delete status.companies[ws];
  assert.equal(companySyncedSince(ws, WOKE), false, '결과 없음');
  status.companies[ws] = { ts: WOKE };
  assert.equal(companySyncedSince(ws, WOKE), true, '깨어난 시각과 같은 시각에 끝난 사이클');
  status.companies[ws] = { ts: WOKE - 1 };
  assert.equal(companySyncedSince(ws, WOKE), false);
  delete status.companies[ws];
});

test('B19: 깨어남 판정 — 틱 사이 벽시계 간격이 RESUME_GAP_MS를 넘으면 그 틱이 새 깨어난 시각이 된다', () => {
  const s = { since: 1_000, lastTick: 0 };
  assert.equal(noteSchedulerTick(s, 61_000), 1_000, '첫 틱 — 기동 시각 그대로');
  assert.equal(noteSchedulerTick(s, 121_000), 1_000, '평소 60초 간격');
  const woke = 121_000 + RESUME_GAP_MS + 1;
  assert.equal(noteSchedulerTick(s, woke), woke, '잠자기에서 돌아온 틱');
  assert.equal(noteSchedulerTick(s, woke + 60_000), woke, '그 뒤 평소 틱은 깨어난 시각을 유지');
  assert.ok(RESUME_GAP_MS > 60_000 && RESUME_GAP_MS <= 10 * 60_000, '60초 틱보다 넉넉하고, 잠자기는 놓치지 않을 만큼 짧다');
});
