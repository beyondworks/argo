// 에이전트 = 한 사람(유건 2026-10-05) 분리 검수 반영 — 얼굴·읽기·저장 행동 테스트(순수 함수·가짜 supabase).
//  #3 얼굴을 한 번도 저장하지 않은 에이전트는 주인 메신저가 대표 행 얼굴을 한 번 저장한다(lookFillPlan·fillAgentLooks).
//  #4 내 크루 행 읽기는 로그인 때 한 번(ownRowsReader — App loadMyAgents 쪽은 rail-state.test.mjs).
//  #6 여러 행 저장이 거절돼 대표가 아닌 행 하나만 저장했으면 알린다(saveAgentLook onlyHere).
// 새 함수는 이름공간으로 가져온다 — 고치기 전 코드에서는 함수가 없어 각 테스트가 따로 실패한다(파일 전체가 import에서 죽지 않게).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../src/crew-face.mjs';
import * as G from '../src/agent-groups.mjs';

const ME = 'u-me'; const OTHER = 'u-other';
const LEAN = 'org-lean'; const DESIGN = 'org-design';
const row = (id, extra = {}) => ({ id, owner_user_id: ME, ws_id: 'ws-a', slug: 'pepper', status: 'active', org_id: null, face: null, avatar_url: null, created_at: '2026-09-10T00:00:00+00:00', ...extra });

// ── #3 얼굴·사진 채우기 ──
test('#3 lookFillPlan: 같은 에이전트 행이 둘 이상이고 저장된 얼굴이 하나도 없으면 — 모든 행에 대표 행 씨앗 얼굴(주인 화면과 같은 얼굴)', () => {
  const rows = [row('p-1', { created_at: '2026-09-01T00:00:00+00:00' }), row('o-late', { org_id: DESIGN, created_at: '2026-09-20T00:00:00+00:00' }), row('o-early', { org_id: LEAN, created_at: '2026-09-05T00:00:00+00:00' })];
  const plan = F.lookFillPlan(rows);
  assert.deepEqual(plan, [{ col: 'face', ids: ['p-1', 'o-late', 'o-early'], patch: { face: F.faceToStore(F.faceOf('o-early')) } }]);
  const looks = F.agentLooks(rows);
  assert.deepEqual(F.faceFromStored(plan[0].patch.face), F.agentFace('p-1', looks), '저장할 얼굴 = 지금 주인이 보는 얼굴');
});

// 통합 재검수 MEDIUM(2026-10-05): '전부 얼굴 없음' 그룹만 채워, 한 번 채운 뒤 새 조직에 파견된 행(얼굴 없음)은 영영 안 채웠다 — 그 행을 보는 조직 사람에게만 다른 얼굴.
test('#3 lookFillPlan: 얼굴이 저장된 그룹에 얼굴 없는 행이 새로 생기면(새 조직 파견) 그 행만 그룹 얼굴로 채운다', () => {
  const saved = { v: 2, shape: 1, color: 2 };
  const rows = [row('p-1', { face: saved, created_at: '2026-09-01T00:00:00+00:00' }), row('o-1', { org_id: LEAN, face: saved, created_at: '2026-09-05T00:00:00+00:00' }), row('o-new', { org_id: DESIGN, created_at: '2026-10-05T00:00:00+00:00' })];
  const plan = F.lookFillPlan(rows);
  assert.deepEqual(plan, [{ col: 'face', ids: ['o-new'], patch: { face: F.faceToStore(F.faceFromStored(saved)) } }]);
  assert.deepEqual(F.faceFromStored(plan[0].patch.face), F.agentFace('o-new', F.agentLooks(rows)), '채울 얼굴 = 주인이 그 행에서 이미 보는 얼굴');
  const legacy = { shape: 2, color: 3, eyes: 1 }; // 옛 형태로 저장된 대표 얼굴 — 같은 모양을 v2로 저장한다
  const legacyRows = [row('o-1', { org_id: LEAN, face: legacy }), row('p-1')];
  assert.deepEqual(F.lookFillPlan(legacyRows), [{ col: 'face', ids: ['p-1'], patch: { face: F.faceToStore(F.faceFromStored(legacy)) } }]);
});

test('#3 lookFillPlan: 모두 저장돼 있으면·행이 하나뿐이면·얼굴 열을 못 읽었으면(옛 서버)·대표 조직 행이 없으면 얼굴은 안 쓴다', () => {
  assert.deepEqual(F.lookFillPlan([row('p-1', { face: { v: 2, shape: 1, color: 2 } }), row('o-1', { org_id: LEAN, face: { v: 2, shape: 1, color: 2 } })]), []);
  assert.deepEqual(F.lookFillPlan([row('o-1', { org_id: LEAN })]), [], '행 하나 — 모두 같은 씨앗');
  const noCol = [row('p-1'), row('o-1', { org_id: LEAN })].map(({ face, ...r }) => r);
  assert.deepEqual(F.lookFillPlan(noCol), [], 'face 키가 없는 행(옛 서버) — 모르는 값을 덮지 않는다');
  assert.deepEqual(F.lookFillPlan([row('p-1'), row('o-off', { org_id: LEAN, status: 'detached' })]), [], '살아 있는 조직 행이 없으면 대표가 없다');
  assert.deepEqual(F.lookFillPlan([row('p-1'), row('o-1', { org_id: LEAN }), row('z-1', { org_id: LEAN, slug: 'zed', ws_id: null })]).map((p) => p.ids), [['p-1', 'o-1']], '회사를 모르는 행은 묶지 않는다');
});

test('#3 lookFillPlan: 사진은 대표 행에 있고 비어 있는 다른 행이 있을 때만 — 빈 행에 대표 사진', () => {
  const faced = { face: { v: 2, shape: 3, color: 3 } };
  assert.deepEqual(F.lookFillPlan([row('p-1', faced), row('o-1', { ...faced, org_id: LEAN, avatar_url: 'https://x/rep.jpg' }), row('o-2', { ...faced, org_id: DESIGN, created_at: '2026-09-30T00:00:00+00:00', avatar_url: 'https://x/own.jpg' })]),
    [{ col: 'avatar_url', ids: ['p-1'], patch: { avatar_url: 'https://x/rep.jpg' } }], '자기 사진이 있는 행은 그대로');
  assert.deepEqual(F.lookFillPlan([row('p-1', { ...faced, avatar_url: 'https://x/p.jpg' }), row('o-1', { ...faced, org_id: LEAN })]), [], '대표 행에 사진이 없으면 안 채운다');
  const both = F.lookFillPlan([row('p-1'), row('o-1', { org_id: LEAN, avatar_url: 'https://x/rep.jpg' })]);
  assert.deepEqual(both.map((p) => p.col), ['face', 'avatar_url']);
});

function fakeDb({ fail = false, stored = {} } = {}) {
  const calls = [];
  const db = { from(table) {
    const call = { table, patch: null, ids: null, isNull: null };
    const chain = {
      update(patch) { call.patch = patch; return chain; },
      in(col, ids) { call.ids = [col, ids]; return chain; },
      is(col, v) { call.isNull = [col, v]; return chain; },
      eq(col, v) { call.eq = [col, v]; return chain; },
      select() {
        calls.push(call);
        if (fail) return Promise.resolve({ data: null, error: { message: 'msgr_org_locked' } });
        const ids = (call.ids?.[1] ?? []).filter((id) => !(call.isNull && stored[id]?.[call.isNull[0]] != null)); // 서버처럼 is null 조건에 안 맞는 행은 안 바뀐다
        return Promise.resolve({ data: ids.map((id) => ({ id })), error: null });
      },
    };
    return chain;
  } };
  return { db, calls };
}

test('#3 fillAgentLooks: 비어 있는 열만(is null 조건) 한 요청씩 — 다른 기기가 먼저 저장한 행은 덮지 않는다', async () => {
  const rows = [row('p-1'), row('o-1', { org_id: LEAN, avatar_url: 'https://x/rep.jpg' })];
  const { db, calls } = fakeDb({ stored: { 'o-1': { face: { v: 2, shape: 0, color: 0 } } } });
  const done = await G.fillAgentLooks(db, rows);
  assert.equal(calls.length, 2, '얼굴 1 + 사진 1');
  assert.deepEqual(calls.map((c) => [c.table, c.ids, c.isNull]), [['msgr_crews', ['id', ['p-1', 'o-1']], ['face', null]], ['msgr_crews', ['id', ['p-1']], ['avatar_url', null]]]);
  assert.deepEqual(done, [{ ids: ['p-1'], patch: { face: F.faceToStore(F.faceOf('o-1')) } }, { ids: ['p-1'], patch: { avatar_url: 'https://x/rep.jpg' } }], '실제로 바뀐 행만 돌려준다');
});

test('#3 fillAgentLooks: 저장값이 생긴 뒤에는 쓰기 0, 실패는 조용히 넘긴다(던지지 않고 빈 결과)', async () => {
  const saved = [row('p-1', { face: { v: 2, shape: 4, color: 4 }, avatar_url: 'https://x/rep.jpg' }), row('o-1', { org_id: LEAN, face: { v: 2, shape: 4, color: 4 }, avatar_url: 'https://x/rep.jpg' })];
  const a = fakeDb(); assert.deepEqual(await G.fillAgentLooks(a.db, saved), []); assert.equal(a.calls.length, 0);
  const b = fakeDb({ fail: true }); assert.deepEqual(await G.fillAgentLooks(b.db, [row('p-1'), row('o-1', { org_id: LEAN })]), []); assert.equal(b.calls.length, 1, '재시도하지 않는다');
});

// ── #4 내 크루 행 읽기 하나로 ──
function counter(result = [{ id: 'o-1' }]) {
  const st = { n: 0, waits: [] };
  st.fetch = () => { st.n += 1; return new Promise((res, rej) => { st.waits.push({ res: () => res(result), rej }); }); };
  st.settle = async () => { for (const w of st.waits.splice(0)) w.res(); await new Promise((r) => setTimeout(r, 0)); };
  return st;
}

test('#4 ownRowsReader: 로그인 — 얼굴 지도 읽기 뒤 내 에이전트 목록(reuse)은 같은 결과를 쓴다(요청 1건)', async () => {
  const c = counter(); let t = 1000; const read = G.ownRowsReader(c.fetch, () => t);
  const first = read({ epoch: 0 }); await c.settle(); const a = await first;
  t = 5000; const b = await read({ epoch: 0, reuse: true });
  assert.equal(c.n, 1);
  assert.equal(b, a, '같은 결과 그대로');
  assert.deepEqual(a, { rows: [{ id: 'o-1' }], at: 1000, epoch: 0 }, '읽은 시각은 처음 읽은 때');
});

test('#4 ownRowsReader: 읽는 중이면 누가 불러도 그 약속을 같이 쓴다', async () => {
  const c = counter(); const read = G.ownRowsReader(c.fetch);
  const a = read({ epoch: 0 }); const b = read({ epoch: 0, reuse: true }); const d = read({ epoch: 0 });
  await c.settle();
  assert.equal(c.n, 1);
  assert.deepEqual(await a, await b); assert.deepEqual(await a, await d);
});

test('#4 ownRowsReader: 복귀(새 epoch)·폰 에이전트 탭(reuse 없음)은 새로 읽고, 실패는 기억하지 않는다', async () => {
  const c = counter(); const read = G.ownRowsReader(c.fetch);
  const a = read({ epoch: 0 }); await c.settle(); await a;
  const b = read({ epoch: 1, reuse: true }); await c.settle(); await b;
  assert.equal(c.n, 2, '다른 epoch');
  const d = read({ epoch: 1 }); await c.settle(); await d;
  assert.equal(c.n, 3, 'reuse 없이 부르면 새로');
  let fails = 0; const bad = G.ownRowsReader(() => { fails += 1; return Promise.reject(new Error('net')); });
  await assert.rejects(bad({ epoch: 0 }));
  await assert.rejects(bad({ epoch: 0, reuse: true }));
  assert.equal(fails, 2, '실패한 결과를 다시 쓰지 않는다(다음 부름이 읽는다)');
});

// ── #6 대표가 아닌 행 하나만 저장 ──
function saveDb({ failBulk = false } = {}) {
  const calls = [];
  const db = { from() {
    const call = {};
    const chain = { update(p) { call.patch = p; return chain; }, in(c, ids) { call.ids = ids; return chain; },
      select() { calls.push(call); return Promise.resolve(failBulk && call.ids.length > 1 ? { data: null, error: { message: 'msgr_policy_locked' } } : { data: call.ids.map((id) => ({ id })), error: null }); } };
    return chain;
  } };
  return { db, calls };
}
const ORANGE = { v: 2, shape: 8, color: 9 };

test('#6 saveAgentLook: 여러 행 저장이 거절돼 대표가 아닌 행 하나만 저장했으면 onlyHere — 화면 얼굴(대표 기준)은 안 바뀐다', async () => {
  const looks = F.agentLooks([row('p-1'), row('o-1', { org_id: LEAN })]); // 대표 = o-1
  const r = await G.saveAgentLook(saveDb({ failBulk: true }).db, 'p-1', { face: ORANGE }, looks);
  assert.equal(r.error, null);
  assert.deepEqual(r.ids, ['p-1']);
  assert.equal(r.onlyHere, true);
});

test('#6 saveAgentLook: 대표 행을 눌렀거나 한 요청으로 다 저장했으면 onlyHere 아님', async () => {
  const looks = F.agentLooks([row('p-1'), row('o-1', { org_id: LEAN })]);
  assert.equal((await G.saveAgentLook(saveDb({ failBulk: true }).db, 'o-1', { face: ORANGE }, looks)).onlyHere, false, '대표 행만 저장 — 화면 얼굴은 바뀐다');
  assert.equal((await G.saveAgentLook(saveDb().db, 'p-1', { face: ORANGE }, looks)).onlyHere, false);
  assert.equal((await G.saveAgentLook(saveDb().db, 'solo', { face: ORANGE }, null)).onlyHere, false, '지도를 모르면(행 하나) 해당 없음');
});

// 통합 재검수 LOW(2026-10-05): 읽는 중이면 epoch와 상관없이 그 약속을 돌려줘, 복귀(새 회차)의 읽기가 앞 회차 읽기에 묻혀 나가지 않았다.
test('#4 ownRowsReader: 앞 회차를 읽는 중에 새 회차(복귀)가 부르면 새로 읽는다 — 같은 회차·reuse는 그 약속을 같이 쓴다', async () => {
  const c = counter(); const read = G.ownRowsReader(c.fetch);
  const a = read({ epoch: 0 });
  const same = read({ epoch: 0 }); const reuse = read({ epoch: 1, reuse: true });
  assert.equal(c.n, 1, '같은 회차·reuse는 읽는 중 약속을 같이 쓴다');
  const b = read({ epoch: 1 });
  assert.equal(c.n, 2, '복귀 회차는 따로 읽는다');
  await c.settle(); const [ra, rs, rr, rb] = await Promise.all([a, same, reuse, b]);
  assert.equal(ra, rs); assert.equal(ra, rr); assert.equal(rb.epoch, 1);
  const d = read({ epoch: 1, reuse: true }); assert.equal(await d, rb, '마지막 결과는 새 회차 것(앞 회차 응답이 늦게 와도 덮지 않는다)');
});
