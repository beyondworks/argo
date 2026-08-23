// 자율 루프(interval 루틴의 loop 필드) — 정규화·판정 파싱·정지 조건·결재 재개를 임시 ARGO_ROOT에서 잠근다.
// chat()은 runRoutine의 chatFn 주입으로 대체 — 실 러너 없이 프로토콜 배선만 검증(라이브는 별도).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-loops-'));
const { normalizeLoop, parseLoopVerdict, LOOP_VERDICT_RE, addRoutine, updateRoutine, runRoutine, loadRoutines, resumeLoop } = await import('../src/routines.mjs');
const { loadApprovals } = await import('../src/approvals.mjs');
const { createCompany } = await import('../src/workspace.mjs');
const { onNotify } = await import('../src/notify.mjs');
const { resolveWithFollowUp } = await import('../src/approval-actions.mjs');

const WS = 'loopco';
await createCompany(WS, '루프사', 'captain');
await mkdir(join(process.env.ARGO_ROOT, WS, 'agents', 'alpha'), { recursive: true }); // 크루 카드 불필요 — chatFn 주입이라 러너·카드를 읽지 않는다

const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
const fakeChat = (replies) => {
  const calls = [];
  const fn = async (_ws, _slug, userMsg) => {
    calls.push(userMsg);
    const r = replies.shift() ?? { reply: 'ok\nLOOP: continue' };
    return { reply: r.reply, handover: null, sessionId: null, costUsd: r.costUsd ?? null };
  };
  fn.calls = calls;
  return fn;
};
const mkLoop = (loop, every = 10) => addRoutine(WS, { agentSlug: 'alpha', title: '점검 루프', prompt: '서버 상태를 점검하라', schedule: { type: 'interval', everyMinutes: every }, loop });

test('normalizeLoop: 기본값·클램프·카운터 보존', () => {
  assert.deepEqual(normalizeLoop({}), { maxRuns: 20, maxUsd: null, runs: 0, spentUsd: 0, lastVerdict: null, stoppedReason: null, missingVerdicts: 0, stoppedDetail: '' });
  assert.equal(normalizeLoop({ maxRuns: 999 }).maxRuns, 200);
  assert.equal(normalizeLoop({ maxRuns: 0 }).maxRuns, 1);
  assert.equal(normalizeLoop({ maxRuns: 'abc' }).maxRuns, 20);
  assert.equal(normalizeLoop({ maxUsd: '2.5' }).maxUsd, 2.5);
  assert.equal(normalizeLoop({ maxUsd: -1 }).maxUsd, null);
  // API 패치는 설정만 바꾸고 진행 카운터는 디스크값을 잇는다
  const merged = normalizeLoop({ maxRuns: 5 }, { maxRuns: 20, maxUsd: 3, runs: 4, spentUsd: 1.2, lastVerdict: 'continue', stoppedReason: 'manual', missingVerdicts: 1 });
  assert.equal(merged.maxRuns, 5); assert.equal(merged.maxUsd, 3); assert.equal(merged.runs, 4); assert.equal(merged.spentUsd, 1.2); assert.equal(merged.stoppedReason, 'manual');
});

test('parseLoopVerdict: 3종 + 누락 + 마커 뒤 공백/마침표/백틱', () => {
  assert.deepEqual(parseLoopVerdict('작업함\nLOOP: continue'), { verdict: 'continue', reason: '', missing: false });
  assert.deepEqual(parseLoopVerdict('끝\nLOOP: done 모든 항목 점검 완료.'), { verdict: 'done', reason: '모든 항목 점검 완료', missing: false });
  assert.equal(parseLoopVerdict('...\n`LOOP: blocked 배포 승인이 필요함`  \n\n').verdict, 'blocked');
  assert.equal(parseLoopVerdict('...\n`LOOP: blocked 배포 승인이 필요함`').reason, '배포 승인이 필요함');
  assert.equal(parseLoopVerdict('loop: DONE').verdict, 'done');
  assert.deepEqual(parseLoopVerdict('마커 없이 끝남'), { verdict: 'continue', reason: '', missing: true });
  assert.equal(parseLoopVerdict('LOOP: continue\n그 뒤에 더 말함').missing, true, '마지막 줄만 본다');
  assert.match('LOOP: done ok', LOOP_VERDICT_RE);
});

test('addRoutine: interval에만 loop가 붙고, daily에 loop가 오면 무시', async () => {
  const r = await mkLoop({ maxRuns: 3 });
  assert.equal(r.loop.maxRuns, 3); assert.equal(r.loop.runs, 0);
  const d = await addRoutine(WS, { agentSlug: 'alpha', title: 'd', prompt: 'p', schedule: { type: 'daily', time: '09:00' }, loop: { maxRuns: 3 } });
  assert.equal('loop' in d, false);
});

test('runRoutine: 프롬프트에 루프 프로토콜이 붙고, done이면 enabled:false + stoppedReason done + 비용 합산', async () => {
  const r = await mkLoop({ maxRuns: 10 });
  const chatFn = fakeChat([{ reply: '1회차 진행\nLOOP: continue', costUsd: 0.1 }, { reply: '마무리\nLOOP: done 목표 달성', costUsd: 0.25 }]);
  await runRoutine(WS, r.id, { chatFn });
  assert.match(chatFn.calls[0], /1회차 \/ 최대 10회/);
  assert.match(chatFn.calls[0], /LOOP: continue/);
  let cur = await byId(r.id);
  assert.equal(cur.enabled, true); assert.equal(cur.loop.runs, 1); assert.equal(cur.loop.spentUsd, 0.1); assert.equal(cur.loop.lastVerdict, 'continue');
  const out = await runRoutine(WS, r.id, { chatFn });
  assert.match(chatFn.calls[1], /2회차/); assert.match(chatFn.calls[1], /지난 회차 결과 요약: 1회차 진행/);
  cur = await byId(r.id);
  assert.equal(cur.enabled, false); assert.equal(cur.loop.stoppedReason, 'done'); assert.equal(cur.loop.runs, 2); assert.equal(cur.loop.spentUsd, 0.35);
  assert.equal(out.stopped, 'done');
});

test('runRoutine: maxRuns 도달 정지 / maxUsd 도달 정지(costUsd null은 0)', async () => {
  const r = await mkLoop({ maxRuns: 2 });
  const chatFn = fakeChat([]);
  await runRoutine(WS, r.id, { chatFn });
  assert.equal((await byId(r.id)).enabled, true);
  await runRoutine(WS, r.id, { chatFn });
  const cur = await byId(r.id);
  assert.equal(cur.enabled, false); assert.equal(cur.loop.stoppedReason, 'maxRuns');

  const u = await mkLoop({ maxRuns: 50, maxUsd: 0.5 });
  const uChat = fakeChat([{ reply: 'a\nLOOP: continue', costUsd: null }, { reply: 'b\nLOOP: continue', costUsd: 0.6 }]);
  await runRoutine(WS, u.id, { chatFn: uChat });
  assert.equal((await byId(u.id)).loop.spentUsd, 0);
  await runRoutine(WS, u.id, { chatFn: uChat });
  assert.equal((await byId(u.id)).loop.stoppedReason, 'maxUsd');
});

test('runRoutine: blocked → 정지 + 결재함에 kind loop 1건 + 정지 알림; 승인 시 재개, 거절 시 정지 유지', async () => {
  const r = await mkLoop({ maxRuns: 10 });
  const got = []; const off = onNotify((e) => got.push(e));
  await runRoutine(WS, r.id, { chatFn: fakeChat([{ reply: '진행 불가\nLOOP: blocked 예산 증액 결정 필요' }]) });
  await new Promise((res) => setTimeout(res, 20)); off();
  let cur = await byId(r.id);
  assert.equal(cur.enabled, false); assert.equal(cur.loop.stoppedReason, 'blocked'); assert.equal(cur.loop.stoppedDetail, '예산 증액 결정 필요');
  const aps = (await loadApprovals(WS)).filter((a) => a.kind === 'loop' && a.payload?.routineId === r.id);
  assert.equal(aps.length, 1);
  assert.equal(aps[0].reason, '예산 증액 결정 필요');
  assert.ok(got.some((e) => e.type === 'routine' && /루프 멈춤/.test(e.reply)), '정지 사유 알림');
  // 거절 → 그대로 정지
  await resolveWithFollowUp(WS, aps[0].id, false);
  cur = await byId(r.id);
  assert.equal(cur.enabled, false); assert.equal(cur.loop.stoppedReason, 'blocked');
  // 두 번째 막힘 → 승인 → 재개
  await resumeLoop(WS, r.id);
  await runRoutine(WS, r.id, { chatFn: fakeChat([{ reply: 'x\nLOOP: blocked 또 결정' }]) });
  const ap2 = (await loadApprovals(WS)).find((a) => a.kind === 'loop' && a.status === 'pending' && a.payload?.routineId === r.id);
  assert.ok(ap2);
  await resolveWithFollowUp(WS, ap2.id, true);
  cur = await byId(r.id);
  assert.equal(cur.enabled, true); assert.equal(cur.loop.stoppedReason, null); assert.equal(cur.loop.missingVerdicts, 0);
  const raw = JSON.parse(await readFile(join(process.env.ARGO_ROOT, WS, 'approvals.json'), 'utf8'));
  assert.equal(raw.filter((a) => a.kind === 'loop').length, 2);
});

test('runRoutine: 마커 3회 연속 누락 → blocked(missingVerdicts), 중간에 마커가 오면 리셋', async () => {
  const r = await mkLoop({ maxRuns: 10 });
  const chatFn = fakeChat([{ reply: '마커 없음1' }, { reply: '마커 없음2' }, { reply: '있음\nLOOP: continue' }, { reply: '없음1' }, { reply: '없음2' }, { reply: '없음3' }]);
  for (let i = 0; i < 3; i++) await runRoutine(WS, r.id, { chatFn });
  assert.equal((await byId(r.id)).loop.missingVerdicts, 0, '마커가 오면 리셋');
  for (let i = 0; i < 3; i++) await runRoutine(WS, r.id, { chatFn });
  const cur = await byId(r.id);
  assert.equal(cur.enabled, false); assert.equal(cur.loop.stoppedReason, 'blocked'); assert.equal(cur.loop.missingVerdicts, 3);
});

test('updateRoutine: 수동 정지는 stoppedReason manual(기존 사유 유지), 다시 켜면 비움; 타입 전환 시 loop 제거', async () => {
  const r = await mkLoop({ maxRuns: 10 });
  let cur = await updateRoutine(WS, r.id, { enabled: false });
  assert.equal(cur.loop.stoppedReason, 'manual');
  cur = await updateRoutine(WS, r.id, { enabled: true });
  assert.equal(cur.loop.stoppedReason, null); assert.equal(cur.enabled, true);
  cur = await updateRoutine(WS, r.id, { loop: { maxRuns: 7, maxUsd: 1 } });
  assert.equal(cur.loop.maxRuns, 7); assert.equal(cur.loop.maxUsd, 1);
  cur = await updateRoutine(WS, r.id, { schedule: { type: 'daily', time: '09:00' } });
  assert.equal(cur.loop, null);
});

test('비루프 interval 루틴(loop 없음)은 프로토콜 없이 그대로 돈다', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '구 루프', prompt: 'p', schedule: { type: 'interval', everyMinutes: 10 } });
  const chatFn = fakeChat([{ reply: '응답' }]);
  const out = await runRoutine(WS, r.id, { chatFn });
  assert.doesNotMatch(chatFn.calls[0], /루프 프로토콜/);
  assert.equal('loop' in out, false);
  assert.equal((await byId(r.id)).enabled, true);
});
