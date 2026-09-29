import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getClient } from '../core/supabase.js';
import { ME, SPACES, getMode, useSession } from '../core/session.js';
import { validateFilters } from './dashboard-model.js';

const fail = (message, code = message) => Object.assign(new Error(message), { code });
const journalKey = (scope, namespace) => `${namespace}:${scope.uid}:${scope.org ?? 'me'}`;
const identity = (scope) => `${scope.uid}:${scope.org ?? 'me'}`;
export function businessError(error) {
  if (error?.message?.startsWith('biz.')) return error.message;
  const specific = {
    business_aggregate_limit: 'aggregate', business_insufficient_stock: 'stock', business_version_conflict: 'version', business_amount_exceeds_balance: 'balance',
    business_order_state: 'orderState', business_number: 'number', business_quantity: 'quantity', business_not_found: 'missing',
    business_kind_in_use: 'kindInUse', business_product_only: 'productOnly', business_total_limit: 'total', business_dates: 'dates',
    business_idempotency_conflict: 'pending', business_input: 'input', business_settings: 'input', business_settings_duplicate: 'input', business_kind: 'input',
  };
  if (specific[error?.message]) return `biz.error.${specific[error.message]}`;
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(error?.code)) return 'biz.error.schema';
  if (['42501', 'PGRST301', '401', '403'].includes(String(error?.code))) return 'biz.error.permission';
  return 'biz.error.request';
}

export function createBusinessClient({ client, scope, journal, key = () => crypto.randomUUID(), rpcPrefix = 'office_business', journalNamespace = 'argo-office-business-pending', reportArgs = (filters) => { const parsed = validateFilters(filters); return { p_from: parsed.from, p_to: parsed.to, p_customer: parsed.customer }; }, mapError = businessError, versionConflict = 'business_version_conflict' }) {
  const receiptKey = (expected) => journalKey(expected, journalNamespace);
  let snapshot = { data: null, loading: false, busy: false, error: null, uncertain: false, scopeKey: null };
  let epoch = 0, inFlight = false;
  const listeners = new Set();
  const emit = (patch) => { snapshot = { ...snapshot, ...patch }; listeners.forEach((fn) => fn()); };
  const current = () => {
    const value = scope();
    if (!value?.uid) throw fail('biz.error.signIn');
    return value;
  };
  const assertScope = (expected) => { if (identity(current()) !== identity(expected)) throw fail('biz.error.scope'); };
  const authenticated = async (expected) => {
    assertScope(expected);
    const sb = await client();
    assertScope(expected);
    if (!sb) throw fail('biz.error.signIn');
    const { data, error } = await sb.auth.getSession();
    assertScope(expected);
    if (error || data?.session?.user?.id !== expected.uid || !data.session.access_token) throw fail('biz.error.signIn');
    return { sb, token: data.session.access_token };
  };
  const rpc = async (expected, fn, args) => {
    const { sb, token } = await authenticated(expected);
    const result = await sb.rpc(fn, args).setHeader('Authorization', `Bearer ${token}`);
    assertScope(expected);
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code, status: result.status });
    return result.data;
  };
  const receipt = (expected) => {
    try {
      const raw = journal.getItem(receiptKey(expected));
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (value.scopeKey !== identity(expected) || typeof value.key !== 'string' || typeof value.action !== 'string' || !value.payload || typeof value.payload !== 'object') throw new Error('invalid receipt');
      return value;
    } catch { throw fail('biz.error.receipt'); }
  };
  const refresh = async () => {
    const request = ++epoch;
    let expected;
    try {
      expected = current();
      emit({ scopeKey: identity(expected), data: snapshot.scopeKey === identity(expected) ? snapshot.data : null, loading: true, error: null });
      await authenticated(expected);
      const pending = receipt(expected);
      const data = await rpc(expected, `${rpcPrefix}_read`, { p_org: expected.org });
      if (request === epoch) emit({ data, loading: false, uncertain: !!pending });
      return data;
    } catch (error) {
      if (request === epoch) emit({ data: null, loading: false, error: mapError(error), ...(expected ? {} : { scopeKey: null }) });
      throw error;
    }
  };
  const execute = async (expected, pending) => {
    inFlight = true;
    emit({ busy: true, error: null, uncertain: false });
    let written = false;
    try {
      const result = await rpc(expected, `${rpcPrefix}_write`, { p_org: expected.org, p_key: pending.key, p_action: pending.action, p_data: pending.payload });
      written = true;
      try { journal.removeItem(receiptKey(expected)); }
      catch { emit({ uncertain: true, error: 'biz.error.receipt' }); return result; }
      emit({ uncertain: false });
      await refresh().catch(() => {});
      return result;
    } catch (error) {
      const definitelyRejected = !written && ((error.status >= 400 && error.status < 500 && error.status !== 408) || ['42501', '22023', '23503', '23505', 'PGRST202', 'PGRST205'].includes(error.code));
      if (definitelyRejected) {
        try { journal.removeItem(receiptKey(expected)); }
        catch { if (scope()?.uid === expected.uid && identity(scope()) === identity(expected)) emit({ uncertain: true, error: 'biz.error.receipt' }); throw fail('biz.error.receipt'); }
      }
      if (scope()?.uid === expected.uid && identity(scope()) === identity(expected)) emit({ uncertain: !definitelyRejected && !written, error: mapError(error) });
      if (definitelyRejected && error.message === versionConflict) await refresh().catch(() => {});
      throw error;
    } finally {
      inFlight = false;
      emit({ busy: false });
    }
  };
  const mutate = async (action, payload) => {
    if (inFlight) throw fail('biz.error.busy');
    inFlight = true;
    try {
      const expected = current();
      await authenticated(expected);
      if (receipt(expected)) { emit({ uncertain: true }); throw fail('biz.error.pending'); }
      const pending = { scopeKey: identity(expected), key: key(), action, payload: JSON.parse(JSON.stringify(payload)) };
      try { journal.setItem(receiptKey(expected), JSON.stringify(pending)); } catch { throw fail('biz.error.receipt'); }
      return await execute(expected, pending);
    } finally { inFlight = false; }
  };
  const retryPending = async () => {
    if (inFlight) throw fail('biz.error.busy');
    inFlight = true;
    try {
      const expected = current();
      await authenticated(expected);
      const pending = receipt(expected);
      if (!pending) { emit({ uncertain: false }); return refresh(); }
      return await execute(expected, pending);
    } finally { inFlight = false; }
  };
  return {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => snapshot,
    refresh, mutate, retryPending,
    report: async (filters) => {
      const expected = current();
      return rpc(expected, `${rpcPrefix}_report`, { ...reportArgs(filters), p_org: expected.org });
    },
    invalidate: () => { epoch += 1; emit({ data: null, loading: false, error: null, uncertain: false, scopeKey: null }); },
  };
}

export function useScopedBusiness(space, createClient = createBusinessClient) {
  const mode = useSession();
  const scoped = useMemo(() => createClient({
    client: getClient, journal: globalThis.localStorage,
    scope: () => {
      if (getMode() !== 'signedIn' || !ME.id) return null;
      const org = space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id;
      return org === undefined ? null : { uid: ME.id, org };
    },
  }), [space, createClient]);
  const snapshot = useSyncExternalStore(scoped.subscribe, scoped.getSnapshot, scoped.getSnapshot);
  useEffect(() => {
    let alive = true, subscription;
    scoped.refresh().catch(() => {});
    getClient().then((sb) => {
      if (!alive || !sb) return;
      subscription = sb.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') { scoped.invalidate(); queueMicrotask(() => { if (alive) scoped.refresh().catch(() => {}); }); }
      }).data.subscription;
    });
    return () => { alive = false; subscription?.unsubscribe(); scoped.invalidate(); };
  }, [scoped, mode]);
  const org = space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id;
  const visible = getMode() === 'signedIn' && snapshot.scopeKey === `${ME.id}:${org ?? 'me'}`;
  return { ...snapshot, data: visible ? snapshot.data : null, ...scoped };
}

export function useBusiness(space) {
  return useScopedBusiness(space);
}
