// 할 일(성과 기록 1단계, 유건 9/29) — 서버 office_task_* 함수로만 읽고 쓴다(표를 직접 읽는 길은 없다).
// 부하: 모듈을 열 때 1~2회 읽기, 사람이 누를 때만 쓰기. 폴링 없음.
import { useEffect, useSyncExternalStore } from 'react';
import { getClient } from './supabase.js';
import { ME, SPACES, useSession } from './session.js';

export const orgOf = (space) => (space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id);
const ERRORS = { task_forbidden: 'permission', task_assignee: 'assignee', task_done: 'done', task_cancelled: 'cancelled', task_conflict: 'conflict', task_input: 'input', task_not_found: 'missing', task_signin: 'signin', task_limit: 'limit' };
export const taskError = (e) => `task.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'permission' : 'request')}`;

let state = {};
const listeners = new Set();
const set = (space, patch) => { state = { ...state, [space]: { ...state[space], ...patch } }; listeners.forEach((fn) => fn()); };
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function rpc(fn, args) { // 성과 기록(core/perf.js)도 같은 세션 확인으로 부른다
  const sb = await getClient();
  const session = sb ? (await sb.auth.getSession()).data?.session : null;
  if (!session || session.user?.id !== ME.id) throw new Error('task_signin'); // 다른 계정 세션으로 쓰지 않는다
  const { data, error } = await sb.rpc(fn, args).setHeader('Authorization', `Bearer ${session.access_token}`);
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data;
}

// 같은 공간을 여러 곳(현황·할 일·일정 카드)이 동시에 열어도 읽기는 한 번 — 30초 안에 받은 것은 다시 받지 않는다. 쓰기 뒤에는 again으로 새로 읽는다
const busy = new Map();
export function loadTasks(space, again) {
  if (!again && (busy.has(space) || Date.now() - (state[space]?.at ?? 0) < 30e3)) return busy.get(space);
  const p = fetchTasks(space).finally(() => { if (busy.get(space) === p) busy.delete(space); });
  busy.set(space, p);
  return p;
}
async function fetchTasks(space) {
  const org = orgOf(space);
  if (org === undefined) return;
  set(space, { loading: true, error: null });
  try {
    const [rows, people] = await Promise.all([rpc('office_task_list', { p_org: org }), org ? rpc('office_org_people', { p_org: org }) : []]);
    set(space, { rows: rows ?? [], people: people ?? [], loading: false, at: Date.now() });
  } catch (e) { set(space, { loading: false, error: taskError(e) }); }
}

/** 쓰기 — patch를 주면 먼저 화면에 반영하고, 실패하면 되돌린 뒤 사전 키를 담은 오류를 던진다 */
export async function taskAction(space, action, data, patch) {
  const before = state[space]?.rows;
  if (patch && before) set(space, { rows: before.map((r) => (r.id === data.id ? { ...r, ...patch } : r)) });
  try { await rpc('office_task_write', { p_org: orgOf(space), p_action: action, p_data: data }); }
  catch (e) { if (before) set(space, { rows: before }); throw new Error(taskError(e)); }
  await loadTasks(space, true);
}

export function useTasks(space) {
  const mode = useSession();
  const snapshot = useSyncExternalStore(subscribe, () => state[space], () => state[space]);
  useEffect(() => { if (mode === 'signedIn') loadTasks(space); }, [space, mode]);
  return snapshot ?? {};
}
