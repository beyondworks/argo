// 업무 > 자동화 1단계 — Argo 루틴 ↔ msgr_crew_routines 미러(src/gateway/msgr-routines.mjs) 로직 테스트.
// 실 Supabase 왕복은 test/msgr-crew-routines-pg.test.mjs(RLS·RPC), 화면은 apps/messenger 픽스처가 맡는다.
//
// 아래 "PR #701 분리 검수" 절은 스크래치패드 프로브(probe.mjs·probe2.mjs)를 옮긴 회귀 테스트다 — 옛 코드
// (updatedAt을 patchRoutine 단일 관문에서 찍던 버전, pendingRoutineEdits가 orgId만 받던 버전)에서 각각
// red였음을 커밋 직전에 git stash로 확인했다(보고 참조).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from './helpers/tmp.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ARGO_ROOT = await mkdtemp(join(tmpdir(), 'argo-msgr-routines-'));
const rt = await import('../src/routines.mjs');
const { buildRoutineRows, decideRoutineEdit, mirrorRoutines, applyRoutineEdits, _resetRoutineMirrorForTest } = await import('../src/gateway/msgr-routines.mjs');
// 모듈 상태(pushed·failedHash·backoff·옛 서버 10분 캐시)가 파일 안 테스트끼리 새지 않게 매 테스트 전에 비운다 —
// 특히 "옛 서버" 판정은 실제 벽시계로 10분을 기억하므로, 리셋이 없으면 뒤따르는 테스트가 전부 unsupported로 잘못 짧게 끝난다.
beforeEach(() => _resetRoutineMirrorForTest());

const CREW = { id: 'crew-1', org_id: 'org-1', slug: 'seoyun' };
const routine = (over = {}) => ({ id: 'r1', agentSlug: 'seoyun', title: '아침 보고', prompt: '오늘 할 일 정리', schedule: { type: 'daily', time: '09:00', times: ['09:00'] }, enabled: true, editedAt: '2026-09-20T00:00:00.000Z', ...over });

test('buildRoutineRows — 이 크루의 루틴만, 채널은 notifications.msgr.channelId 우선, updated_at은 editedAt', () => {
  const rows = buildRoutineRows([routine(), routine({ id: 'r2', agentSlug: 'other' }),
    routine({ id: 'r3', notifications: { channels: ['msgr'], msgr: { orgId: 'org-1', channelId: 'ch-9' } } })], 'seoyun');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ext_id, 'r1'); assert.equal(rows[0].channel_id, null); assert.equal(rows[0].updated_at, '2026-09-20T00:00:00.000Z');
  assert.equal(rows[1].channel_id, 'ch-9');
});

test('buildRoutineRows — msgr.channelId 폴백(notifications 없을 때)', () => {
  const rows = buildRoutineRows([routine({ msgr: { channelId: 'ch-5' } })], 'seoyun');
  assert.equal(rows[0].channel_id, 'ch-5');
});

test('mirrorRoutines — 내용이 같으면 RPC를 다시 부르지 않는다(유휴 쓰기 0)', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; return {}; } };
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

test('mirrorRoutines(M2) — 한 크루가 실패해도 다른 크루는 미러되고, 같은 영구 실패 내용은 재시도하지 않는다', async () => {
  _resetRoutineMirrorForTest();
  const calls = [];
  const db = { async syncCrewRoutines(org, crewId) { calls.push(crewId); if (crewId === 'bad') throw Object.assign(new Error('forbidden'), { code: '42501' }); return {}; } };
  const crews = [{ id: 'bad', org_id: 'org-1', slug: 'bad' }, { id: 'good', org_id: 'org-1', slug: 'good' }];
  const load = async () => [routine({ id: 'rb', agentSlug: 'bad' }), routine({ id: 'rg', agentSlug: 'good' })];
  const out1 = await mirrorRoutines('ws1', { db, crews, load, log: () => {} });
  assert.equal(out1.synced, 1); assert.equal(out1.failed, 1);
  assert.deepEqual(calls, ['bad', 'good'], '실패한 크루 다음도 계속 돈다');
  calls.length = 0;
  await mirrorRoutines('ws1', { db, crews, load, log: () => {} }); // 같은 내용으로 재시도 — bad는 다시 안 부른다, good은 이미 성공해 스킵
  assert.deepEqual(calls, [], '직전과 같은 영구 실패 내용·같은 성공 내용은 둘 다 다시 안 부른다');
});

test('mirrorRoutines(N1) — 일시 오류(코드 없음·네트워크류)는 해시로 영구히 막지 않고 백오프 뒤 다시 시도한다', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0, fail = true;
  const db = { async syncCrewRoutines() { calls++; if (fail) throw new Error('fetch failed (network)'); return {}; } };
  let now = 1_000_000;
  const load = async () => [routine()];
  await mirrorRoutines('ws1', { db, crews: [CREW], load, log: () => {}, now: () => now });
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [CREW], load, log: () => {}, now: () => now }); // 바로 다음 틱 — 아직 백오프 중, 안 부른다
  assert.equal(calls, 1, '백오프 창 안에서는 같은 내용이라도 다시 두드리지 않는다(폭풍 방지)');
  now += 20_000; // 15초 백오프를 넘김
  fail = false; // 서버 정상화
  await mirrorRoutines('ws1', { db, crews: [CREW], load, log: () => {}, now: () => now });
  assert.equal(calls, 2, '일시 오류는 failedHash에 안 걸려 내용이 그대로여도 백오프가 끝나면 다시 시도한다');
});

test('mirrorRoutines(M4) — 옛 서버(undefined 반환)는 실패로 세지 않는다', async () => {
  _resetRoutineMirrorForTest();
  const out = await mirrorRoutines('ws1', { db: { async syncCrewRoutines() { return undefined; } }, crews: [CREW], load: async () => [routine()] });
  assert.equal(out.failed, 0); assert.equal(out.unsupported, true);
});

test('mirrorRoutines(N2-b) — 옛 서버 판정은 프로세스 단위로 10분 기억한다(크루 수만큼 매 틱 RPC를 안 부른다)', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; return undefined; } };
  const crews = Array.from({ length: 10 }, (_, i) => ({ id: 'c' + i, org_id: 'A', slug: 'a' }));
  let now = 1_000_000;
  await mirrorRoutines('ws1', { db, crews, load: async () => [routine()], now: () => now });
  assert.equal(calls, 1, '첫 크루에서 옛 서버로 판정되면 같은 틱의 나머지 크루는 더 두드리지 않는다');
  for (let i = 0; i < 3; i++) await mirrorRoutines('ws1', { db, crews, load: async () => [routine()], now: () => now });
  assert.equal(calls, 1, '10분 안의 다음 틱들은 RPC를 아예 안 부른다');
  now += 11 * 60_000; // 10분 경과
  await mirrorRoutines('ws1', { db, crews, load: async () => [routine()], now: () => now });
  assert.equal(calls, 2, '10분이 지나면 다시 한 번 확인한다');
});

test('mirrorRoutines(N2) — 크루가 이번 틱에 없으면(회수·오프보딩) 캐시가 지워져 재파견 때 다시 미러한다', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; return {}; } };
  const load = async () => [routine()];
  await mirrorRoutines('ws1', { db, crews: [CREW], load });
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [CREW], load }); // 같은 내용 — 캐시로 스킵
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [], load }); // 회수·오프보딩 — myCrews가 이 크루를 더 안 돌려준다
  await mirrorRoutines('ws1', { db, crews: [CREW], load }); // 재파견 — 서버 쪽 미러 행은 트리거가 지웠으니 다시 올려야 한다
  assert.equal(calls, 2, '캐시가 남아 있으면 서버가 비어 있는데도 다시 안 올린다(마이그레이션 주석 "다음 sync가 채운다"가 거짓이 되는 결함)');
});

test('mirrorRoutines(N5) — 회사(wsId) 2개를 번갈아 돌려도 유휴 상태에서는 서로의 캐시를 안 지운다', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; return { kept: 1 }; } };
  const load = async () => [routine()];
  const ws1Crews = [{ id: 'a1', org_id: 'O', slug: 'seoyun' }, { id: 'a2', org_id: 'O', slug: 'seoyun' }];
  const ws2Crews = [{ id: 'b1', org_id: 'O', slug: 'seoyun' }, { id: 'b2', org_id: 'O', slug: 'seoyun' }];
  for (let i = 0; i < 5; i++) { await mirrorRoutines('ws1', { db, crews: ws1Crews, load }); await mirrorRoutines('ws2', { db, crews: ws2Crews, load }); }
  assert.equal(calls, 4, '두 회사 × 크루 2명 = 첫 틱에만 4번, 나머지 4틱은 유휴(옛 코드는 회사가 번갈아 서로 캐시를 지워 매 틱 4번씩 더 불렀다)');
});

test('mirrorRoutines(L-b) — sync 응답 kept가 보낸 행 수와 다르면 "이미 올렸다" 캐시를 남기지 않는다', async () => {
  _resetRoutineMirrorForTest();
  let calls = 0;
  const db = { async syncCrewRoutines() { calls++; return { kept: 0 }; } }; // 서버가 실제로는 0개만 반영(예: 회수·재파견 경합)
  const load = async () => [routine()]; // 로컬은 유효한 루틴 1개(기대 kept=1)
  await mirrorRoutines('ws1', { db, crews: [CREW], load, log: () => {} });
  assert.equal(calls, 1);
  await mirrorRoutines('ws1', { db, crews: [CREW], load, log: () => {} }); // 같은 내용이라도 kept 불일치였으니 다시 확인해야 한다
  assert.equal(calls, 2, 'kept가 기대와 다르면 캐시를 안 남겨 다음 틱에 다시 확인한다');
});

test('decideRoutineEdit — 로컬이 편집보다 나중이면 superseded, 로컬이 없으면 notfound, 아니면 apply', () => {
  assert.equal(decideRoutineEdit(null, { created_at: '2026-09-20T00:00:00Z' }), 'notfound');
  assert.equal(decideRoutineEdit(routine({ editedAt: '2026-09-21T00:00:00Z' }), { created_at: '2026-09-20T00:00:00Z' }), 'superseded');
  assert.equal(decideRoutineEdit(routine({ editedAt: '2026-09-19T00:00:00Z' }), { created_at: '2026-09-20T00:00:00Z' }), 'apply');
  assert.equal(decideRoutineEdit(routine({ editedAt: undefined }), { created_at: '2026-09-20T00:00:00Z' }), 'apply', 'editedAt 없는 구버전 루틴은 항상 적용');
});

test('applyRoutineEdits — pending 편집을 적용하고 applied로 되쓴다(patch는 허용 필드만 — M1)', async () => {
  const done = [];
  const db = {
    async pendingRoutineEdits(orgId) { return orgId === 'org-1' ? [{ edit_id: 'e1', routine_id: 'row-1', crew_id: CREW.id, ext_id: 'r1', op: 'update', patch: { title: '새 제목', agentSlug: 'evil' }, created_at: '2026-09-20T00:00:00Z' }] : []; },
    async routineEditDone(id, status, error) { done.push({ id, status, error }); },
  };
  let updated = null;
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine()], update: async (ws, id, patch) => { updated = { ws, id, patch }; }, remove: async () => { throw new Error('should not delete'); } });
  assert.deepEqual(updated, { ws: 'ws1', id: 'r1', patch: { title: '새 제목' } }, 'agentSlug는 걸러진다');
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
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine({ editedAt: '2026-09-20T00:00:00Z' })], update: async () => { touched = true; }, remove: async () => { touched = true; } });
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

test('applyRoutineEdits(H2) — 로컬에 없는 루틴(다른 ws 소관)은 조용히 applied로 덮지 않고 failed로 남긴다', async () => {
  const done = [];
  const db = { async pendingRoutineEdits() { return [{ edit_id: 'eX', ext_id: 'r-other-ws', op: 'update', patch: { title: 'z' }, created_at: '2026-09-20T00:00:00Z' }]; }, async routineEditDone(id, status, error) { done.push({ id, status, error }); } };
  const out = await applyRoutineEdits('ws1', { db, crews: [CREW], load: async () => [routine()] });
  assert.equal(out.failed, 1); assert.equal(out.applied, 0);
  assert.deepEqual(done, [{ id: 'eX', status: 'failed', error: 'routine_not_found' }]);
});

test('applyRoutineEdits(H2) — 조직마다 이 ws의 크루 id만 pendingRoutineEdits에 넘긴다', async () => {
  const seen = [];
  const db = { async pendingRoutineEdits(orgId, crewIds) { seen.push([orgId, crewIds]); return []; }, async routineEditDone() {} };
  const crews = [{ id: 'c1', org_id: 'A', slug: 'a' }, { id: 'c2', org_id: 'A', slug: 'a2' }, { id: 'c3', org_id: 'B', slug: 'b' }];
  await applyRoutineEdits('ws1', { db, crews, load: async () => [] });
  assert.deepEqual(seen.sort(), [['A', ['c1', 'c2']], ['B', ['c3']]]);
});

test('applyRoutineEdits(H4) — 한 크루가 여러 조직에 파견돼 중복 편집이 생기면 가장 나중 편집만 적용된다', async () => {
  const done = [];
  const db = {
    async pendingRoutineEdits(orgId) {
      return orgId === 'A'
        ? [{ edit_id: 'eA-older', ext_id: 'r1', op: 'update', patch: { title: 'OLD(A)' }, created_at: '2026-09-20T00:00:01Z' }]
        : [{ edit_id: 'eB-newer', ext_id: 'r1', op: 'update', patch: { title: 'NEW(B)' }, created_at: '2026-09-20T00:00:02Z' }];
    },
    async routineEditDone(id, status, error) { done.push({ id, status, error }); },
  };
  let finalTitle = null;
  const crews = [{ id: 'c1', org_id: 'A', slug: 'a' }, { id: 'c2', org_id: 'B', slug: 'a' }];
  const out = await applyRoutineEdits('ws1', { db, crews, load: async () => [routine({ editedAt: '2026-09-19T00:00:00Z' })], update: async (ws, id, patch) => { finalTitle = patch.title; } });
  assert.equal(finalTitle, 'NEW(B)', '더 나중(2026-09-20T00:00:02) 편집이 이긴다 — 조직 처리 순서와 무관');
  assert.equal(out.applied, 1); assert.equal(out.superseded, 1);
  assert.deepEqual(done.find((d) => d.id === 'eA-older'), { id: 'eA-older', status: 'superseded', error: 'newer edit applied for the same routine elsewhere' });
  assert.deepEqual(done.find((d) => d.id === 'eB-newer'), { id: 'eB-newer', status: 'applied', error: undefined });
});

// ── PR #701 분리 검수 — 프로브를 옮긴 실제 routines.mjs 통합 회귀(가짜 db만 주입, 파일 IO는 실제) ──

test('H1(실사고 재현) — 루틴 실행은 editedAt을 찍지 않아 대기 편집이 오판되지 않는다', async () => {
  const r = await rt.addRoutine('probe-w1', { agentSlug: 'a', title: 't', prompt: 'p', schedule: { type: 'daily', time: '09:00' } });
  const createdEditedAt = (await rt.loadRoutines('probe-w1')).find((x) => x.id === r.id).editedAt;
  const editAt = new Date().toISOString();
  await new Promise((s) => setTimeout(s, 20));
  await rt.runRoutine('probe-w1', r.id, { chatFn: async () => ({ reply: 'ok', text: 'ok' }) });
  const local = (await rt.loadRoutines('probe-w1')).find((x) => x.id === r.id);
  assert.equal(local.editedAt, createdEditedAt, '실행이 editedAt을 건드리면 안 된다(옛 코드는 updatedAt을 여기서 다시 찍었다)');
  assert.equal(decideRoutineEdit(local, { created_at: editAt }), 'apply', '대기 편집이 실행 한 번으로 superseded가 되면 안 된다');
});

test('H4+H2(실사고 재현) — 여러 조직 중복 편집은 가장 나중 것만 적용되고, 다른 ws 소관 편집은 failed로 남는다', async () => {
  const r = await rt.addRoutine('probe-w2', { agentSlug: 'a', title: 't', prompt: 'p', schedule: { type: 'daily', time: '09:00' } });
  const db = {
    async pendingRoutineEdits(orgId) {
      return orgId === 'A'
        ? [{ edit_id: 'eA', ext_id: r.id, op: 'update', patch: { title: 'OLD(A)' }, created_at: new Date(Date.now() + 1000).toISOString() }]
        : [{ edit_id: 'eB', ext_id: r.id, op: 'update', patch: { title: 'NEW(B)' }, created_at: new Date(Date.now() + 2000).toISOString() }];
    },
    routineEditDone: async () => {},
  };
  await applyRoutineEdits('probe-w2', { db, crews: [{ id: 'c1', org_id: 'A', slug: 'a' }, { id: 'c2', org_id: 'B', slug: 'a' }], log: () => {} });
  assert.equal((await rt.loadRoutines('probe-w2')).find((x) => x.id === r.id).title, 'NEW(B)');
  // 다른 ws(probe-w2가 아닌) 소관 편집 — 이 ws의 crews 목록엔 안 잡히지만, 혹시 잡혀도 로컬에 없으니 failed여야 한다
  const done2 = [];
  const db2 = { pendingRoutineEdits: async () => [{ edit_id: 'eX', ext_id: 'r-other-ws', op: 'update', patch: { title: 'z' }, created_at: new Date().toISOString() }], routineEditDone: async (id, s) => done2.push([id, s]) };
  await applyRoutineEdits('probe-w2', { db: db2, crews: [{ id: 'c1', org_id: 'A', slug: 'a' }], log: () => {} });
  assert.deepEqual(done2, [['eX', 'failed']]);
});
