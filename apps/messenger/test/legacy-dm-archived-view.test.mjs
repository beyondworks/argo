// 보관한 옛 조직 1:1 읽기(유건 결정 2026-10-08 1-②) — App.jsx의 실제 openEarlier를 꺼내 가짜 의존성으로 돌린다(agent-identity-app.test.mjs와 같은 방식).
//  · 보관한 방은 조직 목록(loadOrg — archived_at IS NULL)에 없다. 누르면 그 방 행을 한 번 읽어 earlierRoom으로 남기고 연다(그리기는 archivedRoomFor → 읽기 전용).
//  · 보관 안 된 옛 방은 종전대로 목록 경로(조회 없음).
//  · 읽는 동안 공간을 옮겼으면 아무것도 열지 않는다. 행을 못 읽으면(권한·삭제) 안내만 — 빈 화면으로 옮기지 않는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../src/agent-groups.mjs';

const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
// `const openEarlier = …;` 한 문장 — 괄호·중괄호 깊이 0의 첫 ';'까지(따옴표 안은 건너뛴다)
function statement(head) {
  const start = app.indexOf(head); assert.ok(start >= 0, `${head} 가 App.jsx에 있어야 한다`);
  let depth = 0; let q = null;
  for (let i = start + head.length; i < app.length; i++) {
    const ch = app[i];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') q = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ';' && depth === 0) return app.slice(start + head.length, i);
  }
  throw new Error('문장 끝을 찾지 못함');
}
const src = statement('const openEarlier = ');

const LEAN = 'org-lean';
const ROW = { id: 'arch', kind: 'dm', name: 'dm:페퍼', org_id: LEAN, archived_at: '2026-10-08T00:00:00Z', created_by: 'u-me', admin_user_ids: [], excluded_user_ids: [], excluded_crew_ids: [], crew_memory: true, personal_crews: 'allowed', topic: null };

function harness({ row = ROW, fail = false, moveAway = false } = {}) {
  const seen = { queries: [], earlier: [], opened: [], pages: [], errs: [] };
  const activeOrg = { current: 'personal' };
  const supabase = { from: (table) => { const call = { table, eqs: [] }; seen.queries.push(call); const api = {
    select: (cols) => { call.cols = cols; return api; }, eq: (k, v) => { call.eqs.push([k, v]); return api; }, maybeSingle: () => api,
    then: (res, rej) => Promise.resolve(fail ? { data: null, error: { message: 'net' } } : { data: row, error: null }).then((r) => { if (moveAway) activeOrg.current = 'elsewhere'; return r; }).then(res, rej) }; return api; } };
  const deps = {
    runInSpace: (space, run) => { activeOrg.current = space; return run(); },
    q: async (p) => { const { data, error } = await p; if (error) throw new Error(error.message); return data; },
    supabase, activeOrg, t: (k) => k, setErr: (e) => seen.errs.push(e),
    setEarlierRoom: (v) => seen.earlier.push(v), setChId: (id) => seen.opened.push(id), setPage: (p) => seen.pages.push(p), setRail: () => {}, setSheet: () => {},
  };
  const open = new Function(...Object.keys(deps), `return (${src});`)(...Object.values(deps));
  return { open, seen };
}

test('보관한 옛 1:1 줄: 그 방 행을 한 번 읽어 earlierRoom으로 남기고 연다', async () => {
  const h = harness();
  await h.open({ channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 287, archived: true });
  assert.equal(h.seen.queries.length, 1, '한 번만 읽는다');
  assert.equal(h.seen.queries[0].table, 'msgr_channels');
  assert.deepEqual(h.seen.queries[0].eqs, [['id', 'arch']]);
  for (const col of ['id', 'kind', 'name', 'org_id', 'archived_at', 'created_by']) assert.match(h.seen.queries[0].cols, new RegExp(`\\b${col}\\b`), `채널 화면이 쓰는 열 ${col}`);
  assert.deepEqual(h.seen.earlier, [{ orgId: LEAN, channel: ROW, crewId: 'o-lean' }]);
  assert.deepEqual(h.seen.opened, ['arch']);
  assert.deepEqual(h.seen.pages, ['chat']);
  assert.equal(G.archivedRoomFor(h.seen.earlier[0], { orgId: LEAN, chId: 'arch' }), ROW, '그리기 판정과 이어진다');
});

test('보관 안 된 옛 1:1 줄은 종전대로 — 조회 없이 그 방을 연다', async () => {
  const h = harness();
  await h.open({ channelId: 'live', orgId: LEAN, crewId: 'o-lean', n: 3, archived: false });
  assert.equal(h.seen.queries.length, 0);
  assert.deepEqual(h.seen.earlier, []);
  assert.deepEqual(h.seen.opened, ['live']);
});

test('읽는 동안 다른 공간으로 옮겼으면 아무것도 열지 않는다', async () => {
  const h = harness({ moveAway: true });
  await h.open({ channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 287, archived: true });
  assert.deepEqual(h.seen.earlier, []); assert.deepEqual(h.seen.opened, []);
});

test('행을 못 읽으면(권한·삭제·오류) 안내만 — 빈 방으로 옮기지 않는다', async () => {
  for (const o of [{ row: null }, { fail: true }]) {
    const h = harness(o);
    await h.open({ channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 287, archived: true });
    assert.deepEqual(h.seen.opened, [], JSON.stringify(o));
    assert.deepEqual(h.seen.errs, ['dm.archived.fail'], JSON.stringify(o));
  }
});

test('보관이 그 사이 풀렸으면 earlierRoom 없이 목록 경로로 연다', async () => {
  const h = harness({ row: { ...ROW, archived_at: null } });
  await h.open({ channelId: 'arch', orgId: LEAN, crewId: 'o-lean', n: 287, archived: true });
  assert.deepEqual(h.seen.earlier, []);
  assert.deepEqual(h.seen.opened, ['arch']);
});
