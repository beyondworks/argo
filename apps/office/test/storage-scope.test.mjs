import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { createOutbox } from '../src/core/outbox.js';

const load = (file, dependencies) => {
  const source = readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  const globals = { ...dependencies, module, exports: module.exports };
  new Function(...Object.keys(globals), transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(globals));
  return module.exports;
};

test('UID queues preserve legacy entries and never send another account pending operations', async () => {
  let uid = 'alice', recovery;
  const db = new Map([['argo-office-outbox', [{ key: 'legacy', payload: { type: 'page.save', id: 'old' } }]]]);
  const calls = [];
  const sync = load('sync.js', { get: async (key) => db.get(key), set: async (key, value) => db.set(key, value), createOutbox,
    autoFlush: () => ({ poke() {}, now() {} }), setSyncState() {}, getStorageScope: () => uid, scopedStorageKey: (key, owner) => `${key}:${owner}`, setLegacyRecovery: (status) => { recovery = status; } });
  sync.setTransport(async (op) => calls.push(op.payload));
  await sync.activateSyncScope('alice'); await sync.queue('page:p1', { type: 'page.save', id: 'p1' });
  uid = 'bob'; await sync.activateSyncScope('bob'); await sync.outbox.flush();
  assert.equal(calls.length, 0); assert.equal(sync.outbox.pending(), 0);
  await sync.queue('page:p2', { type: 'page.save', id: 'p2' }); await sync.outbox.flush();
  assert.deepEqual(calls.map((p) => p.ownerUid), ['bob']);
  uid = 'alice'; await sync.activateSyncScope('alice'); await sync.outbox.flush();
  assert.deepEqual(calls.map((p) => p.ownerUid), ['bob', 'alice']);
  assert.equal(recovery.pending, 1); assert.equal(db.get('argo-office-outbox').length, 1);
});

test('a switched account leaves in-flight failed work in its original queue', async () => {
  let uid = 'alice', reject;
  const db = new Map();
  const sync = load('sync.js', { get: async (key) => db.get(key), set: async (key, value) => db.set(key, value), createOutbox,
    autoFlush: () => ({ poke() {}, now() {} }), setSyncState() {}, getStorageScope: () => uid, scopedStorageKey: (key, owner) => `${key}:${owner}`, setLegacyRecovery() {} });
  sync.setTransport(() => new Promise((resolve, no) => { reject = no; }));
  await sync.activateSyncScope('alice'); await sync.queue('page:a', { type: 'page.save', id: 'a' });
  const pending = sync.outbox.flush();
  uid = 'bob'; await sync.activateSyncScope('bob'); reject(Object.assign(new Error('account changed'), { transient: true }));
  await pending;
  assert.equal(sync.outbox.pending(), 0); assert.equal(db.get('argo-office-outbox:alice').length, 1);
  assert.equal(db.get('argo-office-outbox:alice')[0].payload.ownerUid, 'alice');
});

function transportFixture() {
  let uid = 'alice', send, reject, finish;
  const calls = [], state = { pages: [{ id: 'p', title: 'Title', content: { type: 'doc' }, version: 1 }], layouts: { 'home:me': { items: [], version: 2 } }, trash: [] };
  const ME = { id: 'alice' };
  load('transport.js', { setTransport: (fn, failure) => { send = fn; reject = failure; }, getState: () => state, update: (fn) => Object.assign(state, fn(state)),
    getMode: () => 'signedIn', SPACES: [], ME, getStorageScope: () => uid, getClient: async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: uid }, access_token: `${uid}-fixture` } } }) },
      rpc: (name, args) => ({ setHeader: (key, value) => { calls.push({ name, args, key, value }); return new Promise((resolve) => { finish = resolve; }); } }) }),
    classify: (e) => e, setUi() {}, getUi: () => ({}), showToast() {}, t: (k) => k, persist() {}, heldKey: (id) => id, scopedStorageKey: (key) => `${key}:${uid}`, apiUrl: (url) => url,
    announce() {} }); // 16차: 저장이 닿으면 다른 창에 알린다(core/page-live.js) — 이 시험의 대상이 아니다
  return { send, reject, calls, state, switchAccount(next) { uid = next; ME.id = next; }, finish(value) { finish(value); } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('draft activation uses only UID cache and preserves legacy draft for explicit recovery', () => {
  let uid = 'alice', recovery;
  const values = new Map([['argo-office-draft-v1', { pages: [{ id: 'unowned' }] }], ['argo-office-draft-v1:alice', { pages: [{ id: 'alice-page' }] }]]);
  const store = load('store.js', { S: { PAGES: [], MAILS: [], APPROVALS: [], DECISIONS: [], WORK: [], CREWS: [], OUTPUTS: [], JOURNAL: [] }, useSyncExternalStore() {},
    restore: (key, fallback) => values.get(key) ?? fallback, persist: (key, value) => values.set(key, value),
    scopedStorageKey: (key, owner = uid) => `${key}:${owner}`, getStorageScope: () => uid, setLegacyRecovery: (status) => { recovery = status; },
    t: (key) => key, queue() {}, between() {}, SPACES: [] });
  store.activateDraftScope('alice'); assert.equal(store.getState().pages[0].id, 'alice-page');
  uid = 'bob';
  store.savePage('alice-page', { title: 'late editor cleanup' });
  assert.equal(values.has('argo-office-draft-v1:bob'), false);
  assert.equal(store.getState().pages[0].title, undefined);
  store.activateDraftScope('bob'); assert.deepEqual(store.getState().pages, []);
  assert.equal(recovery.draft, true); assert.equal(values.get('argo-office-draft-v1').pages[0].id, 'unowned');
});

test('transport pins auth header and refuses old-account response mutations', async () => {
  const fixture = transportFixture();
  const pending = fixture.send({ payload: { type: 'page.save', id: 'p', ownerUid: 'alice' } });
  await settle();
  assert.equal(fixture.calls[0].value, 'Bearer alice-fixture');
  fixture.switchAccount('bob'); fixture.finish({ data: 2 });
  await assert.rejects(pending, /account changed/);
  assert.equal(fixture.state.pages[0].version, 1);
  await assert.rejects(fixture.send({ payload: { type: 'page.save', id: 'p', ownerUid: 'alice' } }), /account changed/);
});

test('home transport supplies CAS version and rejected layout remains visible as conflict', async () => {
  const fixture = transportFixture();
  const op = { payload: { type: 'layout.set', key: 'home:me', items: [{ id: 'a' }], ownerUid: 'alice' } };
  const pending = fixture.send(op); await settle();
  assert.equal(fixture.calls[0].name, 'office_layout_save_v2'); assert.equal(fixture.calls[0].args.p_base_version, 2);
  fixture.finish({ data: 3 }); await pending;
  assert.equal(fixture.state.layouts['home:me'].version, 3);
  fixture.reject(op, { conflict: true });
  assert.equal(fixture.state.layouts['home:me'].conflict, true);
});

test('layout recovery keeps conflict locked on failure and replaces only a successful same-account snapshot', async () => {
  let uid = 'alice', response = { error: new Error('offline') };
  const original = { items: [{ id: 'local' }], version: 2, conflict: true };
  const state = { layouts: { 'home:me': original } };
  const query = { select() { return this; }, eq() { return this; }, then(resolve) { return Promise.resolve(response).then(resolve); } };
  const pull = load('pull.js', { getStorageScope: () => uid, ME: { id: 'alice' }, SPACES: [], getClient: async () => ({ from: () => query }),
    getState: () => state, update: (fn) => Object.assign(state, fn(state)), outbox: { has: () => false, drop: async () => {} }, mergePages() {}, mapBoard() {} });
  await assert.rejects(pull.reloadLayout('home:me'), /offline/);
  assert.equal(state.layouts['home:me'], original);
  response = { data: [{ surface: 'home', prefs: { items: [{ id: 'server' }] }, version: 3 }] };
  assert.equal(await pull.reloadLayout('home:me'), true);
  assert.equal(state.layouts['home:me'].version, 3);
  assert.equal(state.layouts['home:me'].conflict, undefined);
  assert.equal(state.layouts['home:me'].items[0].id, 'server');
  uid = 'bob';
  assert.equal(await pull.reloadLayout('home:me'), false);
  assert.equal(state.layouts['home:me'].version, 3);
});
