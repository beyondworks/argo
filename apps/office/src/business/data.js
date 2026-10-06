import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { getClient } from '../core/supabase.js';
import { ME, SPACES, getMode, useSession } from '../core/session.js';
import { validateFilters } from './dashboard-model.js';
import { isSameUserEcho } from '../core/auth-events.js';
import { createSampleBusinessClient } from './sample-business.js';

const fail = (message, code = message) => Object.assign(new Error(message), { code });
const journalKey = (scope, namespace) => `${namespace}:${scope.uid}:${scope.org ?? 'me'}`;
const identity = (scope) => `${scope.uid}:${scope.org ?? 'me'}`;
export function businessError(error) {
  if (error?.message?.startsWith('biz.')) return error.message;
  const specific = {
    business_aggregate_limit: 'aggregate', business_insufficient_stock: 'stock', business_version_conflict: 'version', business_amount_exceeds_balance: 'balance',
    business_order_state: 'orderState', business_number: 'number', business_quantity: 'quantity', business_not_found: 'missing',
    business_kind_in_use: 'kindInUse', business_product_only: 'productOnly', business_total_limit: 'total', business_dates: 'dates',
    business_idempotency_conflict: 'pending', business_input: 'input', business_owner: 'owner', business_settings: 'input', business_settings_duplicate: 'input', business_kind: 'input',
    business_amount_locked: 'amountLocked', business_line_in_use: 'lineInUse', business_customer_archived: 'archived', business_edit_limit: 'editLimit', business_due: 'due', // 14차
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
      globalThis.dispatchEvent?.(new CustomEvent('office:biz-written', { detail: pending.action })); // 거래처를 바꿨으면 문서함·일정이 거래처 목록을 비운다(core/biz-events.js, OFC-10)
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
    call: async (fn, args = {}) => { const expected = current(); return rpc(expected, fn, { ...args, p_org: expected.org }); }, // 따로 붙은 함수(거래 담당자 등) — 같은 범위·세션 확인을 거친다
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
      subscription = sb.auth.onAuthStateChange((event, session) => {
        if (isSameUserEcho(event, session, { signedIn: getMode() === 'signedIn', uid: ME.id })) return; // 탭 복귀 때 오는 같은 사용자 SIGNED_IN은 다시 읽지 않는다
        if (event === 'SIGNED_OUT' || event === 'SIGNED_IN') { scoped.invalidate(); queueMicrotask(() => { if (alive) scoped.refresh().catch(() => {}); }); }
      }).data.subscription;
    });
    return () => { alive = false; subscription?.unsubscribe(); scoped.invalidate(); };
  }, [scoped, mode]);
  const org = space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id;
  const visible = getMode() === 'signedIn' && snapshot.scopeKey === `${ME.id}:${org ?? 'me'}`;
  return { ...snapshot, data: visible ? snapshot.data : null, ...scoped };
}

/** 예시 데이터 모드(서버 없음) — 이 브라우저의 예시 원장(sample-business.js). 다른 화면·다른 탭(서명 링크)에서 바뀌면 다시 읽는다 */
function useSampleBusiness(space) {
  const client = useMemo(() => createSampleBusinessClient({ storage: globalThis.localStorage, space, people: [{ user_id: ME.id, name: ME.name }] }), [space]);
  const snapshot = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  useEffect(() => {
    client.refresh();
    const again = () => client.refresh();
    const onStorage = (e) => { if (e.key?.startsWith('argo-office-sample-business:')) again(); };
    window.addEventListener('office:biz-refresh', again); window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener('office:biz-refresh', again); window.removeEventListener('storage', onStorage); };
  }, [client]);
  return { ...snapshot, ...client };
}

export function useBusiness(space) {
  // 모드는 앱이 뜰 때 정해지고 바뀌지 않는다(서버 설정 유무) — 훅 순서가 흔들리지 않는다
  return getMode() === 'sample' ? useSampleBusiness(space) : useScopedBusiness(space);
}
