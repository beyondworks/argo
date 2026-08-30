// once 루틴 실패 좀비 방지 — 실패해도 스스로 꺼진다(검수 LOW-3, PR #349 후속).
//
// 옛 주석 "실패 시엔 켜둬 당일 재시도 허용"은 거짓이었다: runRoutine이 시작 시 lastRun을
// 각인하므로 같은 슬롯은 다시 due가 되지 않고(당일 자동 재시도 없음 — isDue 슬롯 판정은
// routines-flex '이미 실행됨'이 잠근다), 켜둔 채 두면 목록에 영영 '가동'으로 남았다.
// 자동 재시도 구현은 기각 — 실패가 영속적(러너 미연결 등)이면 catch-up 창(4h) 내내 틱마다
// LLM 시도가 붙는 무계 재시도가 된다(consolidate 재시도 정책과 같은 계보). 재실행은 실패
// 알림을 받은 사용자가 목록의 '실행'으로 한다. 임시 ARGO_ROOT 격리, chat은 chatFn 주입.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-once-'));
const { addRoutine, runRoutine, loadRoutines } = await import('../src/routines.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'onceco';
await createCompany(WS, '원스사', 'captain');
await mkdir(join(process.env.ARGO_ROOT, WS, 'agents', 'alpha'), { recursive: true });
const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
const failChat = async () => { throw new Error('러너 연결 안 됨'); };
const okChat = async () => ({ reply: '발송 완료', handover: null, sessionId: null, costUsd: null });

test('once: 실패해도 꺼진다 — 켜둔 채 두면 재발화 없는 "가동" 좀비 (검수 LOW-3 핀)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '예약 발송', prompt: '보내라', schedule: { type: 'once', date: '2099-01-01', time: '09:00' } });
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat }), /러너 연결 안 됨/);
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false, '실패는 정직하게 표시된다');
  assert.equal(saved.enabled, false, '같은 슬롯은 lastRun 각인으로 재발화하지 않으니, 켜두면 목록에 영영 가동으로 남는다');
});

test('once: 성공 시에도 스스로 꺼진다 (기존 동작 핀 — 실패 분기와 대칭)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '예약 발송 2', prompt: '보내라', schedule: { type: 'once', date: '2099-01-02', time: '09:00' } });
  const out = await runRoutine(WS, r.id, { chatFn: okChat });
  assert.equal(out.ok, true);
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, true);
  assert.equal(saved.enabled, false, '다음 날 같은 시각에 되살아나지 않는다');
});

test('daily: 실패해도 켜져 있다 — 끄기는 once 전용 (인접 행동 핀)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '매일 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'] } });
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat }));
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false);
  assert.equal(saved.enabled, true, '반복 루틴은 다음 슬롯이 있으니 실패로 꺼지면 안 된다');
});
