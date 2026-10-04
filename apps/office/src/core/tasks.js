// 할 일(성과 기록 1단계, 유건 9/29) — 서버 office_task_* 함수로만 읽고 쓴다(표를 직접 읽는 길은 없다).
// 부하: 모듈을 열 때 1~2회 읽기, 사람이 누를 때만 쓰기. 폴링 없음.
// 다른 기기 변경 반영(18차): 탭(창)으로 돌아올 때만, 화면에 떠 있는 공간의 할 일 목록을 1분에 한 번까지 다시 읽는다(행 목록 하나, 쓰기 0, 쓰는 중이면 건너뜀).
import { useEffect, useSyncExternalStore } from 'react';
import { getClient } from './supabase.js';
import { ME, SPACES, useSession, getMode } from './session.js';
import { refetchDue, onTabReturn, keepResponse, makeDayClock } from './refetch.js';
import { viewRows, taskOrgKeys } from './task-model.js';

export const orgOf = (space) => (space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id);
const ERRORS = { task_forbidden: 'permission', task_assignee: 'assignee', task_done: 'done', task_cancelled: 'cancelled', task_conflict: 'conflict', task_input: 'input', task_not_found: 'missing', task_signin: 'signin', task_limit: 'limit', task_dates: 'dates', task_category: 'category', task_category_name: 'categoryName' }; // 사전 글자는 할 일 화면 사전(task-i18n.js)
export const taskError = (e) => `task.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'permission' : 'request')}`;

// 계정 표시(18차 검수 LOW 10): 공간 키('me' 등)는 계정마다 같으므로 행마다 쓴 계정을 적어 두고, 지금 계정 것만 보인다 — 계정을 바꾸는 사이 옛 계정 목록이 섞이지 않게
let state = {};
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn());
const set = (space, patch) => { const prev = state[space]?.owner === ME.id ? state[space] : {}; state = { ...state, [space]: { ...prev, ...patch, owner: ME.id } }; emit(); };
const mine = (space) => (state[space]?.owner === ME.id ? state[space] : undefined);
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
// 진행 중인 읽기는 계정마다 — 계정을 바꾼 순간 옛 계정의 읽기를 넘겨받으면 그 응답은 버려져 새 계정 할 일이 비었다(18차 2차 검수 LOW-C)
const busy = new Map(), bk = (space) => `${ME.id ?? ''}|${space}`;
export function loadTasks(space, again, quiet) {
  const k = bk(space);
  if (!again && (busy.has(k) || Date.now() - (mine(space)?.at ?? 0) < 30e3)) return busy.get(k);
  const p = fetchTasks(space, quiet).finally(() => { if (busy.get(k) === p) busy.delete(k); });
  busy.set(k, p);
  return p;
}
/** quiet = 탭 복귀 다시 읽기 — '불러오는 중'을 띄우지 않고 직원 목록은 다시 받지 않으며, 실패하면 보던 목록을 그대로 둔다 */
async function fetchTasks(space, quiet) {
  const org = orgOf(space);
  if (org === undefined) return;
  if (!quiet) set(space, { loading: true, error: null });
  const started = Date.now(), owner = ME.id;
  try {
    const [rows, people] = await Promise.all([rpc('office_task_list', { p_org: org }), quiet ? mine(space)?.people : org ? rpc('office_org_people', { p_org: org }) : []]);
    // 계정이 바뀌었거나(LOW 10), 탭 복귀 읽기 사이 쓰기가 시작됐거나 더 새 읽기가 먼저 끝났으면 이 응답은 옛것이다
    if (!keepResponse({ owner, nowOwner: ME.id, quiet, writing, started, newerAt: mine(space)?.at ?? 0 })) return;
    set(space, { rows: rows ?? [], people: people ?? [], loading: false, error: null, at: Date.now() });
  } catch (e) { if (!quiet && owner === ME.id) set(space, { loading: false, error: taskError(e) }); }
}

/** 쓰는 중인 할 일 쓰기 수 — 탭 복귀 다시 읽기가 쓰는 사이에 끼지 않게(여러 건 쓰기는 views/data.js가 이것으로 감싼다) */
let writing = 0;
export async function trackWrite(job) { writing++; try { return await job(); } finally { writing--; } }

/** 쓰기 — patch를 주면 먼저 화면에 반영하고, 실패하면 되돌린 뒤 사전 키를 담은 오류를 던진다 */
export const taskAction = (space, action, data, patch) => trackWrite(async () => {
  const before = mine(space)?.rows;
  if (patch && before) set(space, { rows: before.map((r) => (r.id === data.id ? { ...r, ...patch } : r)) });
  try { await rpc('office_task_write', { p_org: orgOf(space), p_action: action, p_data: data }); }
  catch (e) { if (before) set(space, { rows: before }); throw new Error(taskError(e)); }
  await loadTasks(space, true);
});

// 탭 복귀 다시 읽기 — 할 일을 보여 주는 곳(할 일 화면·카드, 메뉴 배지 — 같은 공간 키라 한 번만)이 있는 공간을, 이미 받아 둔 것만 1분에 한 번까지.
// 자정을 넘겼으면 '오늘'을 다시 계산하게 알린다(LOW 6)
const shown = new Map(), tried = {}; // 할 일을 보여 주는 곳 수(공간마다), 탭 복귀로 마지막에 읽으려 한 때
const day = makeDayClock();
// 개인 공간에 겹친 조직 할 일 다시 읽기 — 그 행을 읽어 둔 곳(views/data.js)이 넣는다. 개인 공간이 떠 있으면 같은 탭 복귀에 같이 부른다
// (10/4 실제 계정 점검: 다른 기기에서 나에게 맡긴 조직 할 일이 탭 복귀 뒤에도 배지·챙길 것·현황 카드에 안 들어왔다 — 18차 LOW 8)
let orgRefetch = null;
export const setOrgRefetch = (fn) => { orgRefetch = fn; };
onTabReturn(() => {
  if (!document.hidden && day.check()) emit();
  if (getMode() !== 'signedIn') return;
  for (const space of shown.keys()) {
    const s = mine(space), now = Date.now();
    if (!s?.rows || !refetchDue({ hidden: document.hidden, now, last: Math.max(tried[space] ?? 0, s.at ?? 0), busy: writing > 0 || busy.has(bk(space)) })) continue;
    tried[space] = now;
    loadTasks(space, true, true);
  }
  if (shown.has('me')) orgRefetch?.(writing > 0);
});
const useShown = (space, on = true) => useEffect(() => { if (!on) return undefined; shown.set(space, (shown.get(space) ?? 0) + 1); return () => { const n = shown.get(space) - 1; if (n > 0) shown.set(space, n); else shown.delete(space); }; }, [space, on]);

export function useTasks(space) {
  const mode = useSession();
  const snapshot = useSyncExternalStore(subscribe, () => mine(space), () => mine(space));
  useEffect(() => { if (mode === 'signedIn') loadTasks(space); }, [space, mode]);
  useShown(space);
  return snapshot ?? {};
}

/* ── 메뉴 배지·챙길 것(18차)이 세는 행 ── 이미 받아 둔 것만 본다(새로 읽지 않는다). 할 일 화면과 같은 함수(task-model.js viewRows)로 묶는다(검수 M4):
   개인 공간 = 내 할 일 + 할 일 화면이 이미 읽어 둔 조직 할 일 중 나에게 맡겨진 것. 예시 모드는 보기 데이터(views/data.js)가 넣어 준 예시 행 */
const samples = {}, orgShared = new Map(), rowsCache = new Map();
let orgVer = 0;
export const shareSampleTasks = (space, rows) => { if (samples[space] !== rows) { samples[space] = rows; emit(); } };
/** 할 일 화면이 읽어 둔 조직 할 일(조직 공간 키 → 행) — views/data.js가 읽을 때마다 넣는다 */
export const shareOrgTasks = (key, rows) => { if (orgShared.get(key)?.rows !== rows) { orgShared.set(key, { rows, owner: ME.id }); orgVer++; emit(); } };
function badgeRows(space) {
  const own = mine(space)?.rows ?? samples[space], c = rowsCache.get(space);
  if (c && c.own === own && c.orgVer === orgVer && c.me === ME.id && c.spaces === SPACES) return c.rows;
  const orgRows = new Map([...orgShared].filter(([, v]) => v.owner === ME.id).map(([k, v]) => [k, v.rows]));
  const rows = viewRows({ space, own, orgRows, orgKeys: space === 'me' ? taskOrgKeys(SPACES) : [], me: ME.id });
  rowsCache.set(space, { own, orgVer, me: ME.id, spaces: SPACES, rows });
  return rows;
}
/** 없으면 undefined(배지 숨김). watch = 탭 복귀 다시 읽기에 이 공간을 넣는다(메뉴 배지 — 할 일 화면과 같은 키, LOW 6) */
export function useTaskRows(space, watch = false) {
  useShown(space, watch);
  return useSyncExternalStore(subscribe, () => badgeRows(space), () => badgeRows(space));
}
/** 한국 날짜 — 자정을 넘긴 뒤 탭으로 돌아오거나 다시 그릴 때(화면 이동 등) 바뀐다(배지·챙길 것의 '오늘').
 *  탭 복귀 때만 바꾸면 탭을 떠나지 않고 자정을 넘긴 사람의 배지가 할 일 화면(그릴 때마다 kstDay)과 어긋났다(18차 2차 검수 LOW-B) */
const todayNow = () => { day.check(); return day.day(); };
export const useTaskDay = () => useSyncExternalStore(subscribe, todayNow, todayNow);
