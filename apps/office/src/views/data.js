// 여러 보기의 데이터 — 할 일 읽기(공간별)·쓰기 실행·보기 설정 저장. 계산은 model.js(순수), 화면은 Board.jsx.
// 부하(DB 위생): 읽기는 기존 그대로 — 할 일은 core/tasks.js 저장소(useTasks), 개인 공간에서 겹쳐 볼 조직 할 일은 조직마다 세션에 한 번
// (office_task_list). 쓰기는 사람이 누를 때만, 여러 건을 한꺼번에 바꾸면 쓰기 N번 뒤 읽기는 공간마다 한 번·일정 창 한 번만. 폴링 없음.
// 할 일 분류(유건 10/4)는 공간마다 세션에 한 번 읽고(office_task_category_list), 분류를 바꾼 뒤에는 돌려받은 목록을 그대로 쓴다.
// 바뀐 기록(office_task_history)은 할 일 패널을 열 때·고친 뒤에만 읽는다.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ME, SPACES, canManage, getMode } from '../core/session.js';
import { useTasks, loadTasks, taskAction, rpc, orgOf, trackWrite, shareSampleTasks, shareOrgTasks, taskError } from '../core/tasks.js';
import { viewRows, taskOrgKeys } from '../core/task-model.js';
import { writeEvent, refreshEvents, loadPeople } from '../calendar/api.js';
import { writableOrgs, idOf } from '../calendar/shared.js';
import { SAMPLE_TASKS, SAMPLE_TASK_CATEGORIES, sampleTaskWrite, sampleCategoryWrite, sampleTaskHistory } from '../data/calendar-sample.js';
import { crewName } from '../core/store.js';

const sample = () => getMode() === 'sample';
// 할 일 쓰기 오류 → 사전 키는 core/tasks.js(taskError) 한 곳에서 정한다 — 한 건 쓰기(taskAction)·여러 건 쓰기·예시 모드가 같은 글자를 보이게(분리 검수 LOW-4)

/* ── 할 일 읽기 ── */
let orgRows = new Map(), orgOwner = null, version = 0; // 개인 공간에 겹칠 조직 할 일(조직 키 → 행)과 그 행을 읽은 계정
// 계정이 바뀌면 옛 계정이 읽은 조직 할 일을 버리고 새로 읽는다 — 할 일 화면이 옛 행을 계속 보여 배지와 숫자가 어긋났다(18차 2차 검수 LOW-D)
const ownOrgRows = () => { if (orgOwner !== ME.id) { orgRows = new Map(); orgOwner = ME.id; } return orgRows; };
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const loading = new Map();
function loadOrg(space, force = false) {
  const map = ownOrgRows(), owner = ME.id, key = `${owner}|${space}`;
  if (!force && (map.has(space) || loading.has(key))) return loading.get(key);
  const p = rpc('office_task_list', { p_org: orgOf(space) })
    .then((rows) => { if (owner === ME.id) map.set(space, rows ?? []); }, () => { if (owner === ME.id && !map.has(space)) map.set(space, []); })
    .finally(() => { if (loading.get(key) === p) loading.delete(key); if (owner === ME.id) shareOrgTasks(space, map.get(space)); emit(); }); // 메뉴 배지·챙길 것도 이 행으로 센다(18차 검수 M4 — 새 읽기 없이)
  loading.set(key, p);
  return p;
}

/** 이 공간 보기에 들어갈 할 일(+ space 키). 개인 공간은 내 할 일 + 속한 조직(손님 제외)에서 나에게 맡겨진 할 일 — 메뉴 배지·챙길 것과 같은 함수(core/task-model.js viewRows) */
export function useViewTasks(space) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const own = useTasks(space).rows;
  const orgs = space === 'me' ? taskOrgKeys(SPACES) : [];
  useEffect(() => { if (!sample()) orgs.forEach((k) => loadOrg(k)); }, [space, orgs.join(), ME.id]);
  const view = useMemo(() => {
    if (!sample()) return { rows: viewRows({ space, own: own ?? [], orgRows: ownOrgRows(), orgKeys: orgs, me: ME.id }) };
    // 예시 할 일에는 분류 이름을 붙여 준다(서버 office_task_list가 붙이는 것과 같은 칸)
    const live = (key) => SAMPLE_TASKS.filter((x) => x.org === (key === 'me' ? null : key) && !x.cancelled_at).map((x) => ({ ...x, category: SAMPLE_TASK_CATEGORIES[key]?.find((c) => c.id === x.category_id)?.name ?? null }));
    const mineRows = live(space), byOrg = new Map(orgs.map((k) => [k, live(k)]));
    return { rows: viewRows({ space, own: mineRows, orgRows: byOrg, orgKeys: orgs, me: ME.id }), mineRows, byOrg };
  }, [own, space, version, orgs.join(), ME.id]);
  // 예시 모드: 같은 예시 행을 메뉴 배지·챙길 것(18차)에도 — 배지는 할 일 저장소만 보고 예시 데이터는 이 묶음에 있다. 로그인은 저장소·조직 행 공유(loadOrg)가 이미 같은 데이터
  useEffect(() => { if (!view.mineRows) return; shareSampleTasks(space, view.mineRows); view.byOrg.forEach((rows, k) => shareOrgTasks(k, rows)); }, [view, space]);
  return view.rows;
}

/** 사람 이름·조직 직원(맡기기 판정) — 조직 공간은 useTasks가 이미 받은 직원 목록, 개인 공간·예시는 조직마다 한 번(loadPeople 캐시) */
const peopleOf = new Map();
export function usePeople(space) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const { people } = useTasks(space);
  useEffect(() => {
    if (!sample() && space !== 'me') return;
    const orgs = space === 'me' ? writableOrgs() : SPACES.filter((s) => s.key === space);
    let live = true;
    Promise.all(orgs.map((s) => loadPeople(idOf(s)).then((p) => { peopleOf.set(s.key, p); }).catch(() => {}))).then(() => { if (live) emit(); });
    return () => { live = false; };
  }, [space]);
  return useMemo(() => {
    if (!sample() && space !== 'me' && people) peopleOf.set(space, people);
    const names = new Map([[ME.id, ME.name]]);
    for (const list of peopleOf.values()) for (const p of list) if (!names.has(p.user_id)) names.set(p.user_id, p.name);
    return {
      me: ME.id,
      name: (key) => (!key || key === 'none' ? '' : key.startsWith('a:') ? crewName(key.slice(2)) || key.slice(2) : names.get(key.slice(2)) ?? '?'),
      members: (k) => { const list = peopleOf.get(k); return list ? new Set(list.filter((p) => p.role !== 'guest').map((p) => p.user_id)) : null; },
      list: (k) => peopleOf.get(k) ?? [],
    };
  }, [people, space, version]);
}

/* ── 할 일 분류 ── */
const cats = new Map(), catLoading = new Map(); // 공간 키 → [{ id, name, position, tasks }]
function loadCats(space, force = false) {
  if (sample() || space === 'shared') return;
  if (!force && (cats.has(space) || catLoading.has(space))) return catLoading.get(space);
  const p = rpc('office_task_category_list', { p_org: orgOf(space) })
    .then((rows) => { cats.set(space, rows ?? []); }, () => { if (!cats.has(space)) cats.set(space, []); })
    .finally(() => { catLoading.delete(space); emit(); });
  catLoading.set(space, p);
  return p;
}
/** 그 공간의 분류(관리 순서) — 예시는 화면 메모리(할 일 수는 관리할 수 있는 공간만, 서버와 같다), 로그인은 읽어 둔 목록 */
export function categoriesOf(space) {
  if (!sample()) return cats.get(space) ?? [];
  const counts = space === 'me' || canManage(space);
  return (SAMPLE_TASK_CATEGORIES[space] ?? []).slice().sort((a, b) => a.position - b.position)
    .map((c) => ({ ...c, tasks: counts ? SAMPLE_TASKS.filter((x) => x.category_id === c.id && !x.cancelled_at).length : null }));
}
/** 분류 이름 → id(같은 이름은 대소문자 무시) — 칸반 '분류로 묶기'에서 칸을 옮길 때 */
export const categoryIdOf = (space, name) => categoriesOf(space).find((c) => c.name.toLowerCase() === String(name ?? '').toLowerCase())?.id ?? null;
/** 공간들의 분류를 읽어 둔다(공간마다 세션에 한 번). 반환은 다시 그릴 때 바뀌는 판 번호 */
export function useTaskCategories(spaces) {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  const key = [...new Set(spaces)].filter((s) => s && s !== 'shared').join();
  useEffect(() => { if (!sample()) key.split(',').filter(Boolean).forEach((s) => loadCats(s)); }, [key]);
  return v;
}
/** 분류 관리 쓰기 — category.create|rename|order|delete. 이름이 바뀌거나 지우면 그 공간 할 일 목록을 다시 읽는다(분류 이름·미분류가 바로 보이게) */
export async function writeCategory(space, action, data) {
  if (sample()) {
    try { sampleCategoryWrite(space, action, data); } catch (e) { throw new Error(taskError(e)); }
    emit();
    return;
  }
  try { cats.set(space, (await rpc('office_task_category_write', { p_org: orgOf(space), p_action: action, p_data: data })) ?? []); }
  catch (e) { throw new Error(taskError(e)); } finally { emit(); }
  if (action === 'category.rename' || action === 'category.delete') { // 분류 관리는 보고 있는 공간의 것이라 그 공간 목록은 이미 받아 둔 상태다
    await Promise.all([loadTasks(space, true), ownOrgRows().has(space) && loadOrg(space, true)].filter(Boolean));
  }
}
/** 할 일의 바뀐 기록(최근 300줄, 새것부터) — [{ kind, at, actor, name, from, to }] */
export async function loadTaskHistory(space, id) {
  if (sample()) return sampleTaskHistory(id);
  try { return (await rpc('office_task_history', { p_org: orgOf(space), p_id: id })) ?? []; } catch (e) { throw new Error(taskError(e)); }
}

/** 권한 판정 문맥(model.js) — 관리자 = 조직 owner·admin(개인 공간은 관리자 없음, 서버와 같다). categoryOf: 할 일 분류 이름 → id */
export const makeCtx = (today, people) => ({ today, me: ME.id, isAdmin: (space) => space !== 'me' && canManage(space), members: people.members, categoryOf: categoryIdOf });

/* ── 쓰기 ── */
async function writeTask(w, optimistic) {
  if (sample()) { try { sampleTaskWrite(w.space, w.action, w.data); } catch (e) { throw new Error(taskError(e)); } return; }
  if (optimistic) return taskAction(w.space, w.action, w.data, w.patch); // 한 건은 먼저 화면에 반영하고 실패하면 되돌린다(다시 읽기 포함)
  try { await rpc('office_task_write', { p_org: orgOf(w.space), p_action: w.action, p_data: w.data }); } catch (e) { throw new Error(taskError(e)); }
}

/** 계획(model.js)대로 쓴다 — 한 건씩 보내고, 끝나면 다시 읽기는 공간마다 한 번·일정 창 한 번. view: 보고 있는 공간
 *  (개인 공간에서 본 조직 할 일은 그 조직 목록을, 나머지는 공간 할 일 저장소를 다시 읽는다). 반환 { ok, failed: 첫 오류의 사전 키 | null } */
export const runWrites = (writes, view) => trackWrite(() => writeAll(writes, view)); // 쓰는 동안 탭 복귀 다시 읽기를 미룬다(18차)
async function writeAll(writes, view) {
  let ok = 0, failed = null, events = false;
  const orgs = new Set(), stores = new Set();
  for (const w of writes) {
    try {
      if (w.type === 'task') {
        const cached = view === 'me' && w.space !== 'me', optimistic = writes.length === 1 && !cached && !sample();
        await writeTask(w, optimistic);
        if (!optimistic) (cached ? orgs : stores).add(w.space);
      } else {
        const action = w.type.slice(6);
        await writeEvent(action, action === 'save' ? w.row : action === 'skip' ? { id: w.id, day: w.day } : { id: w.id }, { refresh: false });
        events = true;
      }
      ok++;
    } catch (e) { failed ??= e.message; }
  }
  if (sample()) emit();
  else await Promise.all([...[...orgs].map((k) => loadOrg(k, true)), ...[...stores].map((k) => loadTasks(k, true))]);
  if (events) await refreshEvents();
  return { ok, failed };
}

/* ── 보기 설정(사람마다 — 이 브라우저에, 계정별 키) ── */
const cfgKey = (id) => `argo-office-views:${ME.id}:${id}`;
export function readCfg(id) { try { return JSON.parse(localStorage.getItem(cfgKey(id)) ?? 'null'); } catch { return null; } }
export function writeCfg(id, cfg) { try { localStorage.setItem(cfgKey(id), JSON.stringify(cfg)); } catch { /* 사생활 보호 모드 — 이번만 */ } }
