import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequestGate, createPreferenceQueue, reorderFavorites } from '../src/rail-state.mjs';

test('old organization response and old same-org refresh cannot apply', () => {
  let org = 'a'; const gate = createRequestGate(() => org);
  const first = gate.begin('a'); org = 'b';
  assert.equal(first(), false);
  const second = gate.begin('b'); const third = gate.begin('b');
  assert.equal(second(), false); assert.equal(third(), true);
});


test('favorite order can move to first and last without admitting foreign IDs', () => {
  assert.deepEqual(reorderFavorites(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(reorderFavorites(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(reorderFavorites(['a', 'b'], 'foreign', 'a'), ['a', 'b']);
});

test('successive reorder batches cannot finish out of order', async () => {
  const queue = createPreferenceQueue(); let release; const writes = [];
  const first = queue.enqueue(async () => { await new Promise((r) => { release = r; }); writes.push(['c', 'a', 'b']); });
  const second = queue.enqueue(async () => { writes.push(['b', 'c', 'a']); });
  await Promise.resolve(); assert.equal(queue.busy, true); assert.deepEqual(writes, []);
  release(); await Promise.all([first, second]);
  assert.deepEqual(writes, [['c', 'a', 'b'], ['b', 'c', 'a']]); assert.equal(queue.busy, false);
});

test('failed preference save permits next save and invalidates outstanding reads', async () => {
  const queue = createPreferenceQueue(); const readRevision = queue.revision;
  await assert.rejects(queue.enqueue(async () => { throw new Error('offline'); }), /offline/);
  assert.notEqual(queue.revision, readRevision);
  assert.equal(await queue.enqueue(async () => 'saved'), 'saved'); assert.equal(queue.busy, false);
});

test('Shell loadOrg ignores late A data, available crews, and errors after switching to B', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const loadOrg = useCallback(') + 'const loadOrg = useCallback('.length;
  const end = app.indexOf('\n  }, [orgs, uid]);', start) + 4;
  const pending = []; const state = {}; const joinedRows = [{ channel_id: 'A-channel' }, { channel_id: 'B-channel' }, { channel_id: 'C-new' }]; const activeOrg = { current: 'A' }; const loadedOrg = { current: null };
  const supabase = { from(table) {
    let id;
    return { select() { return this; }, eq(key, value) { if (key === 'org_id') id = value; return this; }, is() { return this; }, order() { return this; }, in() { return this; }, maybeSingle() { return this; },
      then(resolve, reject) { if (table === 'msgr_channel_members') return Promise.resolve(joinedRows).then(resolve, reject); return new Promise((done, fail) => pending.push({ id, table, done, fail })).then(resolve, reject); } }; // 내 참여 채널은 조직 무관 조회 — 바로 답한다
  } };
  const setters = Object.fromEntries(['Channels', 'PreviewChannels', 'Members', 'Crews', 'MyAvailable', 'Ent', 'Policy', 'DmMembers'].map((key) => [`set${key}`, (value) => { state[key] = value; }]));
  const joinedRef = { current: new Set(['A-channel', 'B-channel']) };
  const deps = { joinedRef, supabase, q: async (query) => await query, uid: 'me', activeOrg, loadedOrg, orgRequests: { current: createRequestGate(() => activeOrg.current) }, orgs: [{ id: 'A' }, { id: 'B' }], crewTier: () => '', readLastCh: () => null, faceCol: { missingAt: 0 }, ...setters, setChId: (f) => { state.chId = f(state.chId); } };
  const loadOrg = new Function(...Object.keys(deps), `return (${app.slice(start, end)});`)(...Object.values(deps));
  const settle = (id) => { for (const p of pending.filter((p) => p.id === id)) p.done(p.table === 'msgr_channels' ? [{ id: `${id}-channel`, kind: 'public' }] : p.table === 'msgr_crews' ? [{ id: `${id}-crew`, owner_user_id: 'me', display_name: id, status: 'available' }] : p.table === 'msgr_org_members' ? [{ user_id: `${id}-person` }] : { data: null }); };
  const a = loadOrg('A'); activeOrg.current = 'B'; const b = loadOrg('B');
  await new Promise((r) => setImmediate(r)); settle('B'); await b; settle('A'); await a;
  assert.ok(joinedRef.current.has('C-new'), 'loadOrg가 내 참여 채널을 다시 읽어 joinedRef를 갱신한다(남이 나를 공개 채널에 넣은 경우)');
  assert.equal(state.chId, 'B-channel'); assert.equal(state.Members[0].user_id, 'B-person'); assert.equal(state.MyAvailable[0].id, 'B-crew'); assert.equal(loadedOrg.current, 'B');
  activeOrg.current = 'A'; const old = loadOrg('A'); await new Promise((r) => setImmediate(r)); activeOrg.current = 'B';
  pending.filter((p) => p.id === 'A').forEach((p) => p.fail(new Error('stale network error')));
  await assert.doesNotReject(old);
});

test('옛 서버(face 열 없음) 판정은 10분만 기억한다 — 라이브 적용 뒤 앱 재시작 없이 저장한 얼굴이 보이고, face와 무관한 "does not exist"는 판정하지 않는다(재검수 #704)', async () => {
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('const loadOrg = useCallback(') + 'const loadOrg = useCallback('.length;
  const end = app.indexOf('\n  }, [orgs, uid]);', start) + 4;
  const selects = []; let serverHasFace = false; let otherError = null; const state = {};
  const supabase = { from(table) { let cols = '';
    return { select(c) { cols = c; if (table === 'msgr_crews') selects.push(/face/.test(c)); return this; }, eq() { return this; }, is() { return this; }, order() { return this; }, in() { return this; }, maybeSingle() { return this; },
      then(res, rej) {
        if (table === 'msgr_crews' && otherError) return Promise.reject(new Error(otherError)).then(res, rej);
        if (table === 'msgr_crews' && /face/.test(cols) && !serverHasFace) return Promise.reject(new Error('column msgr_crews.face does not exist')).then(res, rej);
        if (table === 'msgr_crews') return Promise.resolve([{ id: 'c1', owner_user_id: 'me', display_name: 'c', status: 'active', ...(/face/.test(cols) ? { face: { shape: 1, color: 1, eyes: 1 } } : {}) }]).then(res, rej);
        if (table === 'msgr_channels') return Promise.resolve([{ id: 'ch', kind: 'public' }]).then(res, rej);
        if (table === 'msgr_org_members' || table === 'msgr_channel_members') return Promise.resolve([]).then(res, rej);
        return Promise.resolve({ data: null }).then(res, rej); } }; } };
  const setters = Object.fromEntries(['Channels', 'PreviewChannels', 'Members', 'Crews', 'MyAvailable', 'Ent', 'Policy', 'DmMembers'].map((k) => [`set${k}`, (v) => { state[k] = v; }]));
  const activeOrg = { current: 'A' }; const faceCol = { missingAt: 0 };
  const deps = { joinedRef: { current: new Set() }, supabase, q: async (x) => await x, uid: 'me', activeOrg, loadedOrg: { current: null }, orgRequests: { current: createRequestGate(() => activeOrg.current) }, orgs: [{ id: 'A' }], crewTier: () => '', readLastCh: () => null, faceCol, ...setters, setChId: () => {} };
  const loadOrg = new Function(...Object.keys(deps), `return (${app.slice(start, end)});`)(...Object.values(deps));
  await loadOrg('A');
  assert.deepEqual(selects, [true, false], '옛 서버: face로 한 번 실패 → face 없이 다시 읽음'); assert.equal(state.Crews[0].face, null);
  selects.length = 0; await loadOrg('A');
  assert.deepEqual(selects, [false], '기억하는 동안은 실패할 요청을 다시 보내지 않는다(DB 위생)');
  serverHasFace = true; faceCol.missingAt -= 11 * 60_000; selects.length = 0; await loadOrg('A');
  assert.deepEqual(selects, [true], '10분 뒤 다시 시도'); assert.deepEqual(state.Crews[0].face, { shape: 1, color: 1, eyes: 1 });
  faceCol.missingAt = 0; otherError = 'function public.msgr_is_member(uuid) does not exist';
  await loadOrg('A').catch(() => {}); // 오류 처리는 loadOrg 몫 — 여기서는 판정 플래그만 본다
  assert.equal(faceCol.missingAt, 0, 'face와 무관한 오류는 옛 서버 판정을 켜지 않는다');
});
