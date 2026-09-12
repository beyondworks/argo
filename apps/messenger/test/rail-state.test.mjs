import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequestGate, createPreferenceQueue, folderChannelIds, reorderFavorites } from '../src/rail-state.mjs';

test('old organization response and old same-org refresh cannot apply', () => {
  let org = 'a'; const gate = createRequestGate(() => org);
  const first = gate.begin('a'); org = 'b';
  assert.equal(first(), false);
  const second = gate.begin('b'); const third = gate.begin('b');
  assert.equal(second(), false); assert.equal(third(), true);
});

test('group rename includes only current organization channels, excluding DMs', () => {
  const prefs = new Map([['a', 'dev'], ['b', 'dev'], ['dm', 'dev']]);
  assert.deepEqual(folderChannelIds([{ id: 'a', kind: 'public' }, { id: 'dm', kind: 'dm' }], prefs, 'dev'), ['a']);
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
  const pending = []; const state = {}; const activeOrg = { current: 'A' }; const loadedOrg = { current: null };
  const supabase = { from(table) {
    let id;
    return { select() { return this; }, eq(key, value) { if (key === 'org_id') id = value; return this; }, is() { return this; }, order() { return this; }, in() { return this; }, maybeSingle() { return this; },
      then(resolve, reject) { return new Promise((done, fail) => pending.push({ id, table, done, fail })).then(resolve, reject); } };
  } };
  const setters = Object.fromEntries(['Channels', 'Members', 'Crews', 'MyAvailable', 'Ent', 'Policy', 'DmMembers'].map((key) => [`set${key}`, (value) => { state[key] = value; }]));
  const deps = { supabase, q: async (query) => await query, uid: 'me', activeOrg, loadedOrg, orgRequests: { current: createRequestGate(() => activeOrg.current) }, orgs: [{ id: 'A' }, { id: 'B' }], crewTier: () => '', ...setters, setChId: (f) => { state.chId = f(state.chId); } };
  const loadOrg = new Function(...Object.keys(deps), `return (${app.slice(start, end)});`)(...Object.values(deps));
  const settle = (id) => { for (const p of pending.filter((p) => p.id === id)) p.done(p.table === 'msgr_channels' ? [{ id: `${id}-channel`, kind: 'public' }] : p.table === 'msgr_crews' ? [{ id: `${id}-crew`, owner_user_id: 'me', display_name: id, status: 'available' }] : p.table === 'msgr_org_members' ? [{ user_id: `${id}-person` }] : { data: null }); };
  const a = loadOrg('A'); activeOrg.current = 'B'; const b = loadOrg('B');
  await new Promise((r) => setImmediate(r)); settle('B'); await b; settle('A'); await a;
  assert.equal(state.chId, 'B-channel'); assert.equal(state.Members[0].user_id, 'B-person'); assert.equal(state.MyAvailable[0].id, 'B-crew'); assert.equal(loadedOrg.current, 'B');
  activeOrg.current = 'A'; const old = loadOrg('A'); await new Promise((r) => setImmediate(r)); activeOrg.current = 'B';
  pending.filter((p) => p.id === 'A').forEach((p) => p.fail(new Error('stale network error')));
  await assert.doesNotReject(old);
});
