// once 루틴 실패 좀비 방지 — **예약 시각이 지난 실패**는 스스로 꺼진다(검수 LOW-3, PR #349 후속).
//
// 옛 주석 "실패 시엔 켜둬 당일 재시도 허용"은 거짓이었다: runRoutine이 시작 시 lastRun을
// 각인하므로 같은 슬롯은 다시 due가 되지 않고(당일 자동 재시도 없음 — isDue 슬롯 판정은
// routines-flex '이미 실행됨'이 잠근다), 켜둔 채 두면 목록에 영영 '가동'으로 남았다.
// 자동 재시도 구현은 기각 — 실패가 영속적(러너 미연결 등)이면 catch-up 창(4h) 내내 틱마다
// LLM 시도가 붙는 무계 재시도가 된다(consolidate 재시도 정책과 같은 계보). 재실행은 실패
// 알림을 받은 사용자가 목록의 '실행'으로 한다.
//
// 단 끄기는 onceSpent(예약 시각 경과) 게이트를 탄다 — 미래 예약을 목록 '실행'으로 미리
// 시험하다 실패했을 때 꺼 버리면 살아 있는 예정 발송이 취소된다(분리 검수 MEDIUM-1 실측:
// 수동 실행 경로는 스케줄러를 안 타므로 "슬롯은 어차피 소비됐다"는 전제가 성립하지 않는다).
// 임시 ARGO_ROOT 격리, chat은 chatFn 주입.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-once-'));
const { addRoutine, runRoutine, loadRoutines, onceSpent } = await import('../src/routines.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const WS = 'onceco';
await createCompany(WS, '원스사', 'captain');
await mkdir(join(process.env.ARGO_ROOT, WS, 'agents', 'alpha'), { recursive: true });
const byId = async (id) => (await loadRoutines(WS)).find((r) => r.id === id);
const failChat = async () => { throw new Error('러너 연결 안 됨'); };
const okChat = async () => ({ reply: '발송 완료', handover: null, sessionId: null, costUsd: null });
const mkOnce = (title, date) => addRoutine(WS, { agentSlug: 'alpha', title, prompt: '보내라', schedule: { type: 'once', date, time: '09:00' } });

test('once: 예약 시각이 지난 실패는 꺼진다 — 켜둔 채 두면 재발화 없는 "가동" 좀비 (검수 LOW-3 핀)', async () => {
  const r = await mkOnce('예약 발송', '2020-01-01'); // 과거 날짜 = 스케줄러가 발화했을 상황
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat }), /러너 연결 안 됨/);
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false, '실패는 정직하게 표시된다');
  assert.equal(saved.enabled, false, '같은 슬롯은 lastRun 각인으로 재발화하지 않으니, 켜두면 목록에 영영 가동으로 남는다');
});

test('once: 예약 시각 전(미래 예약)의 수동 시험 실패는 켜둔다 — 예정 발송 취소 금지 (검수 MEDIUM-1 핀)', async () => {
  const r = await mkOnce('미래 예약', '2099-01-01');
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat }));
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false);
  assert.equal(saved.enabled, true, '시험 실행이 실패했다고 살아 있는 미래 예약을 꺼서 취소하면 안 된다');
});

test('once: 예약 시각을 가로지른 시험 실행의 실패도 켜둔다 — 판정 시계는 실행 시작 시각 (2R LOW-A 핀)', async () => {
  // 시작(주입 08:59:30) < 슬롯(09:00) ≤ 실패(실 시계, 훨씬 뒤) — 실패 시각으로 재면 "경과"로
  // 꺼지는데, lastRun=시작<슬롯이라 isDue는 아직 그 슬롯을 발화할 수 있다: 살아 있는 예약의 취소다.
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '가로지름', prompt: '보내라', schedule: { type: 'once', date: '2026-06-15', time: '09:00' } });
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat, startAt: new Date(2026, 5, 15, 8, 59, 30) }));
  const saved = await byId(r.id);
  assert.equal(saved.enabled, true, '시작이 슬롯 전이면 슬롯 미소비 — 실패 시각이 슬롯 뒤라고 꺼서 예약을 취소하면 안 된다');
});

test('once: 성공은 시각과 무관하게 스스로 꺼진다 — 산출이 이미 나갔으니 이중 발송 방지 (기존 동작 핀)', async () => {
  const r = await mkOnce('예약 발송 2', '2099-01-02'); // 미래 예약을 미리 시험해 성공한 경우도 끈다
  const out = await runRoutine(WS, r.id, { chatFn: okChat });
  assert.equal(out.ok, true);
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, true);
  assert.equal(saved.enabled, false, '성공했는데 켜두면 예약 시각에 같은 산출이 또 나간다');
});

test('daily: 실패해도 켜져 있다 — 끄기는 once 전용 (인접 행동 핀)', async () => {
  const r = await addRoutine(WS, { agentSlug: 'alpha', title: '매일 보고', prompt: '보고하라', schedule: { type: 'daily', times: ['09:00'] } });
  await assert.rejects(() => runRoutine(WS, r.id, { chatFn: failChat }));
  const saved = await byId(r.id);
  assert.equal(saved.lastOk, false);
  assert.equal(saved.enabled, true, '반복 루틴은 다음 슬롯이 있으니 실패로 꺼지면 안 된다');
});

test('onceSpent: 날짜·당일 시각 경계·비once (순수)', () => {
  const now = new Date(2026, 5, 15, 9, 0, 30); // 로컬 2026-06-15 09:00:30
  assert.equal(onceSpent({ type: 'once', date: '2026-06-14', time: '23:00' }, now), true, '지난 날짜');
  assert.equal(onceSpent({ type: 'once', date: '2026-06-16', time: '00:00' }, now), false, '미래 날짜');
  assert.equal(onceSpent({ type: 'once', date: '2026-06-15', time: '09:00' }, now), true, '당일 — 시각 도달');
  assert.equal(onceSpent({ type: 'once', date: '2026-06-15', time: '09:01' }, now), false, '당일 — 시각 전');
  assert.equal(onceSpent({ type: 'daily', times: ['09:00'] }, now), false, 'once가 아니면 항상 false — daily를 끄는 통로가 되면 안 된다');
  assert.equal(onceSpent({ type: 'once', date: '2026-06-15', time: '09:00', times: ['23:00'] }, now), false,
    '오염 저장값(time≠times[0]) — isDue와 같은 원천(times 우선)으로 판정해야 발화 전 예약이 꺼지지 않는다 (2R LOW-B)');
});
