// F4(2026-10-05 분리 검증): 해고한 크루의 루틴이 켜진 채 남아 예약마다 실패 알림이 갔다.
// 잠그는 행동: ① 해고하면 그 크루 루틴을 끈다(지우지 않는다 — 제목·지시·일정 보존) ② 다른 크루 루틴은 그대로
// ③ 이미 고아가 된 루틴(이 수정 전 해고)은 스케줄러가 실행하지 않고 건너뛴다(끄지는 않는다 — 실패 알림 0) ④ 화면 판정 '크루 없음'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-rfire-'));
const { createCompany, paths } = await import('../src/workspace.mjs');
const { addRoutine, loadRoutines } = await import('../src/routines.mjs');
const { removeAgentCard } = await import('../src/persona.mjs');
const WS = 'co-rfire';
await createCompany(WS, '해고 루틴 회사', 'captain');
const card = (slug) => writeFile(join(paths(WS).agents, `${slug}.md`), `---\nname: ${slug}\n---\n\n본문.\n`);
await mkdir(paths(WS).agents, { recursive: true });

test('해고하면 그 크루의 루틴은 꺼지고(삭제 아님) 다른 크루 루틴은 그대로다', async () => {
  await card('leaver'); await card('stayer');
  const a = await addRoutine(WS, { agentSlug: 'leaver', title: '아침 보고', prompt: '보고해', schedule: { type: 'daily', time: '09:00' } });
  const b = await addRoutine(WS, { agentSlug: 'stayer', title: '저녁 보고', prompt: '보고해', schedule: { type: 'daily', time: '18:00' } });
  await removeAgentCard(WS, 'leaver');
  const list = await loadRoutines(WS);
  const ra = list.find((r) => r.id === a.id); const rb = list.find((r) => r.id === b.id);
  assert.ok(ra, '해고한 크루의 루틴을 지우지 않는다');
  assert.equal(ra.enabled, false, '해고한 크루의 루틴은 꺼진다');
  assert.equal(ra.title, '아침 보고');
  assert.equal(rb.enabled, true, '다른 크루 루틴은 그대로');
});

test('이미 고아가 된 켜진 루틴은 예약 시각에 실행하지 않는다(실패 알림 0) — 저장 상태는 건드리지 않는다', async () => {
  const { runDueRoutines } = await import('../src/scheduler.mjs');
  // interval(실행 기록 없음 = 즉시 due) — daily는 '생성 이후 슬롯만' 규칙 때문에 시계에 따라 due가 아니어서 판정을 못 탄다
  const orphan = await addRoutine(WS, { agentSlug: 'ghost', title: '고아', prompt: '해', schedule: { type: 'interval', everyMinutes: 30 } });
  const control = await addRoutine(WS, { agentSlug: 'stayer', title: '대조', prompt: '해', schedule: { type: 'interval', everyMinutes: 30 } });
  const runs = [];
  const now = new Date();
  await runDueRoutines(WS, now, { runFn: async (ws, id) => { runs.push(id); } });
  assert.equal(runs.includes(control.id), true, '대조군 — 같은 조건의 크루 있는 루틴은 실행된다(판정이 실제로 돌았다)');
  assert.equal(runs.includes(orphan.id), false, '크루 카드가 없는 루틴은 실행하지 않는다');
  const r = (await loadRoutines(WS)).find((x) => x.id === orphan.id);
  // 새 기기에서 동기화가 routines.json을 카드보다 먼저 받는 순간에도 이 판정이 돈다 — 그때 끄면 꺼진 상태가 다른 기기로 퍼진다.
  // 그래서 스케줄러는 건너뛰기만 하고, 끄는 것은 해고(removeAgentCard)라는 사람의 행동에서만 한다.
  assert.equal(r.enabled, true, '스케줄러는 저장 상태를 바꾸지 않는다');
  assert.equal(r.lastRun ?? null, null, '실행 기록(선점)도 남기지 않는다');
});

test('화면 판정 — 크루 목록을 받은 뒤에만 "크루 없음"이라고 말한다', async () => {
  const { routineCrewMissing } = await import('../app/c/[ws]/routines/routine-row.mjs');
  const agents = [{ slug: 'stayer' }];
  assert.equal(routineCrewMissing({ agentSlug: 'leaver' }, agents), true);
  assert.equal(routineCrewMissing({ agentSlug: 'stayer' }, agents), false);
  assert.equal(routineCrewMissing({ agentSlug: 'leaver' }, null), false, '목록을 못 받았으면 단정하지 않는다');
});
