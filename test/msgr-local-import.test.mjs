import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../apps/messenger/src/App.jsx', import.meta.url), 'utf8');

function importer({ failCreation = false, failNative = false } = {}) {
  const records = new Map(); const errors = []; const calls = []; const states = [];
  const flow = { agents: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], agentIds: ['a', 'b'], installation: 'fixture', targetOrgId: 'org', channelIds: [], targetChannels: [] };
  const context = {
    localHermes: flow, org: { id: 'org' }, uid: 'user', botOf: () => null,
    externalAgentId: (_i, _u, _k, id) => id, botUrl: 'fixture', t: (key) => key,
    setBusy() {}, setSetup() {}, setSetups() {}, setAuto() {}, onNote() {}, onChanged() {}, loadBots: async () => {},
    setLocalHermes: (state) => states.push(state), onError: (error) => errors.push(error),
    loadNative: async () => ({ invoke: async (_name, { agents }) => ({ results: agents.map(({ id }) => ({ id, ok: !failNative, steps: [] })) }) }),
    supabase: {
      from() {
        const filters = {};
        const query = { select() { return query; }, eq(key, value) { filters[key] = value; return query; }, is() { return query; }, async maybeSingle() {
          assert.equal(filters.org_id, 'org'); assert.equal(filters.created_by, 'user');
          return { data: records.get(filters.external_id) ?? null };
        } };
        return query;
      },
      async rpc(name, args) {
        calls.push(name);
        if (name === 'msgr_bot_rotate') return { data: 'fixture-rotated' };
        assert.equal(name, 'msgr_bot_create');
        if (records.has(args.external_id)) return { error: { message: 'msgr_bot_exists' } };
        if (args.external_id === 'b' && failCreation) { failCreation = false; return { error: { message: 'transient failure' } }; }
        const record = { id: args.external_id, crew_id: args.external_id, name: args.name };
        records.set(args.external_id, record);
        return { data: { bot_id: record.id, crew_id: record.crew_id, token: 'fixture-new' } };
      },
    },
  };
  const functions = source.slice(source.indexOf('  const localBot = async'), source.indexOf('  const localHermesChannels = async'));
  const connect = source.slice(source.indexOf('  const importLocalHermes = async'), source.indexOf('  // [헤르메스 연결하기]'))
    .replace("await import('@tauri-apps/api/core')", 'await loadNative()');
  vm.createContext(context);
  vm.runInContext(`${functions}\n${connect}\nglobalThis.run = importLocalHermes;`, context);
  return { run: context.run, records, errors, calls, states };
}

test('Hermes import retries after partial creation without stale-cache duplicate failure', async () => {
  const fixture = importer({ failCreation: true });
  await fixture.run();
  assert.deepEqual(fixture.errors, ['transient failure']);
  assert.equal(fixture.records.size, 1);
  await fixture.run();
  assert.deepEqual(fixture.errors, ['transient failure']);
  assert.equal(fixture.records.size, 2);
  assert.equal(fixture.calls.filter((name) => name === 'msgr_bot_rotate').length, 1);
  assert.equal(fixture.states.at(-1).status, 'done');
});

test('failed native reconnection never marks an existing Hermes bot reconfigured', async () => {
  const fixture = importer({ failNative: true });
  fixture.records.set('a', { id: 'a', crew_id: 'a', name: 'A' });
  await fixture.run();
  const state = fixture.states.at(-1);
  assert.equal(state.status, 'partial');
  assert.equal(state.results[0].reconnected, false);
});

test('Hermes import uses native selection on desktop and preserves browser manual setup', () => {
  const dispatch = source.match(/  const addBot = \(kind\) => ([^\n]+);/)[1];
  for (const desktop of [true, false]) {
    const calls = [];
    const run = vm.runInNewContext(`(kind) => ${dispatch}`, { isDesktopTauri: () => desktop, openLocalHermes: () => calls.push('local'), connectAll: (kind) => calls.push(kind) });
    run('hermes'); run('openclaw');
    assert.deepEqual(calls, [desktop ? 'local' : 'hermes', 'openclaw']);
  }
});
