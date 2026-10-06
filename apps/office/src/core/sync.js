import { get, set } from 'idb-keyval';
import { createOutbox, autoFlush } from './outbox.js';
import { setSyncState, getStorageScope, scopedStorageKey, setLegacyRecovery } from './save.js';

const KEY = 'argo-office-outbox';
let transport = async (op) => { await import('./transport.js'); return transport(op); }; // 첫 화면에서 뺐다(bundle.md ⑤) — main.jsx가 그린 뒤 한가할 때 미리 받고, 그 전에 보내면 여기서 받는다. transport.js가 불러와지면서 setTransport로 자기를 등록한다
let rejected = () => {};
export function setTransport(send, onRejected) { transport = send; if (onRejected) rejected = onRejected; }
const boxes = new Map();
let active = null;
const suspended = () => Object.assign(new Error('account changed'), { transient: true });

export async function activateSyncScope(uid) {
  active = null;
  if (!uid) { setSyncState('idle'); return; }
  let entry = boxes.get(uid);
  if (!entry) {
    const key = scopedStorageKey(KEY, uid);
    const box = createOutbox({
      store: { get: () => get(key), set: (value) => set(key, value) },
      send: async (op) => {
        if (active !== entry || getStorageScope() !== uid || op.payload.ownerUid !== uid) throw suspended();
        try { await transport(op); } catch (error) { throw error?.transient === undefined ? Object.assign(error, { transient: true }) : error; }
      },
      onState: (state) => { if (active === entry) setSyncState(state); },
      onRejected: (op, error) => { if (active === entry && getStorageScope() === uid) rejected(op, error); },
    });
    entry = { uid, box, ready: box.load() };
    boxes.set(uid, entry);
  }
  await entry.ready;
  if (getStorageScope() !== uid) return;
  active = entry;
  setSyncState(entry.box.state());
}

export const outbox = {
  state: () => active?.box.state() ?? 'idle', pending: () => active?.box.pending() ?? 0,
  has: (key) => active?.box.has(key) ?? false, tries: () => active?.box.tries() ?? 0,
  drop: (key) => active?.box.drop(key) ?? Promise.resolve(),
  flush: () => active?.box.flush() ?? Promise.resolve(true),
};
const auto = autoFlush(outbox);
get(KEY).then((rows) => setLegacyRecovery({ pending: Array.isArray(rows) ? rows.length : 0 })).catch(() => {});

export async function queue(key, payload) {
  const entry = active;
  if (!entry || getStorageScope() !== entry.uid) throw suspended();
  await entry.ready;
  await entry.box.enqueue({ key, payload: { ...payload, ownerUid: entry.uid } });
  if (active === entry) auto.poke();
}
export const flushNow = () => auto.now();
