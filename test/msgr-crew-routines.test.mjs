// 업무 > 자동화 1단계 — Argo 루틴 ↔ msgr_crew_routines 미러(src/gateway/msgr-routines.mjs) 순수 로직 테스트.
// 실 Supabase 왕복은 test/msgr-crew-routines-pg.test.mjs(RLS·RPC), 실 파일 IO는 다루지 않는다(load/update/remove를 주입).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutineRows, decideRoutineEdit, mirrorRoutines, applyRoutineEdits, _resetRoutineMirrorForTest } from '../src/gateway/msgr-routines.mjs';

const CREW = { id: 'crew-1', org_id: 'org-1', slug: 'seoyun' };
const routine = (over = {}) => ({ id: 'r1', agentSlug: 'seoyun', title: '아침 보고', prompt: '오늘 할 일 정리', schedule: { type: 'daily', time: '09:00', times: ['09:00'] }, enabled: true, updatedAt: '2026-09-20T00:00:00.000Z', ...over });

test('buildRoutineRows — 이 크루의 루틴만, 채널은 notifications.msgr.channelId 우선', () => {
  const rows = buildRoutineRows([routine(), routine({ id: 'r2', agentSlug: 'other' }),
    routine({ id: 'r3', notifications: { channels: ['msgr'], msgr: { orgId: 'org-1', channelId: 'ch-9' } } })], 'seoyun');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ext_id, 'r1'); assert.equal(rows[0].channel_id, null);
  assert.equal(rows[1].channel_id, 'ch-9');
});

test('buildRoutineRows — msgr.channelId 폴백(notifications 없을 때)', () => {
  const rows = buildRoutineRows([routine({ msgr: { channelId: 'ch-5' } })], 'seoyun');
  assert.equal(rows[0].channel_id, 'ch-5');
});

test('mirrorRoutines — 내용이 같으면 RPC를 다시 부르지 않는다(유휴 쓰기 0)', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; } };
  const load = async () => [routine()];
  await mirrorRoutines('ws1', { db, crews: [CREW], load });
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [CREW], load }); // 같은 내용 — 두 번째는 건너뛴다
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [CREW], load: async () => [routine({ title: '바뀐 제목' })] });
  assert.equal(calls, 2, '내용이 바뀌면 다시 부른다');
});

test('mirrorRoutines — 크루 목록이 비면 아무 것도 안 한다', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  await mirrorRoutines('ws1', { db: { async syncCrewRoutines() { calls++; } }, crews: [] });
  assert.equal(calls, 0);
});

test('decideRoutineEdit — 로컬이 편집보다 나중이면 superseded, 로컬이 없으면 noop, 아니면 apply', () => {
  assert.equal(decideRoutineEdit(null, { created_at: '2026-09-20T00:00:00Z' }), 'noop');
  assert.equal(decideRoutineEdit(routine({ updatedAt: '2026-09-21T00:00:00Z' }), { created_at: '2026-09-20T00:00:00Z' }), 'superseded');
  assert.equal(decideRoutineEdit(routine({ updatedAt: '2026-09-19T00:00:00Z' }), { created_at: '2026-09-20T00:00:00Z' }), 'apply');
  assert.equal(decideRoutineEdit(routine({ updatedAt: undefined }), { created_at: '2026-09-20T00:00:00Z' }), 'apply', 'updatedAt 없는 구버전 루틴은 항상 적용');
});

test('applyRoutineEdits — pending 편집을 적용하고 applied로 되쓴다', async () => {
  const done = [];
  const db = {
    async pendingRoutineEdits(orgId) { return orgId === 'org-1' ? [{ edit_id: 'e1', routine_id: 'row-1', crew_id: CREW.id, ext_id: 'r1', op: 'update', patch: { title: '새 제목' }, created_at: '2026-09-20T00:00:00Z' }] : []; },
    async routineEditDone(id, status, error) { done.push({ id, status, error }); },
  };
  let updated = null;
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine()], update: async (ws, id, patch) => { updated = { ws, id, patch }; }, remove: async () => { throw new Error('should not delete'); } });
  assert.deepEqual(updated, { ws: 'ws1', id: 'r1', patch: { title: '새 제목' } });
  assert.equal(out.applied, 1);
  assert.deepEqual(done, [{ id: 'e1', status: 'applied', error: undefined }]);
});

test('applyRoutineEdits — 로컬이 더 나중이면 superseded로 되쓰고 로컬을 건드리지 않는다', async () => {
  const done = [];
  const db = {
    async pendingRoutineEdits() { return [{ edit_id: 'e1', ext_id: 'r1', op: 'update', patch: { title: 'x' }, created_at: '2026-09-01T00:00:00Z' }]; },
    async routineEditDone(id, status) { done.push({ id, status }); },
  };
  let touched = false;
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine({ updatedAt: '2026-09-20T00:00:00Z' })], update: async () => { touched = true; }, remove: async () => { touched = true; } });
  assert.equal(touched, false);
  assert.equal(out.superseded, 1);
  assert.deepEqual(done, [{ id: 'e1', status: 'superseded' }]);
});

test('applyRoutineEdits — delete op은 removeRoutine을 부른다', async () => {
  const db = { async pendingRoutineEdits() { return [{ edit_id: 'e1', ext_id: 'r1', op: 'delete', created_at: '2026-09-20T00:00:00Z' }]; }, async routineEditDone() {} };
  let removedId = null;
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine()], update: async () => { throw new Error('should not update'); }, remove: async (ws, id) => { removedId = id; } });
  assert.equal(removedId, 'r1');
  assert.equal(out.applied, 1);
});

test('applyRoutineEdits — 적용 실패는 failed로 기록하고 던지지 않는다', async () => {
  const done = [];
  const db = { async pendingRoutineEdits() { return [{ edit_id: 'e1', ext_id: 'r1', op: 'update', patch: {}, created_at: '2026-09-20T00:00:00Z' }]; }, async routineEditDone(id, status, error) { done.push({ id, status, error }); } };
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine()], update: async () => { throw new Error('boom'); }, remove: async () => {} });
  assert.equal(out.failed, 1);
  assert.equal(done[0].status, 'failed');
  assert.match(done[0].error, /boom/);
});
