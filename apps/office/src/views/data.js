// 여러 보기의 데이터 — 할 일 읽기(공간별)·쓰기 실행·보기 설정 저장. 계산은 model.js(순수), 화면은 Board.jsx.
// 부하(DB 위생): 할 일은 core/tasks.js 저장소(useTasks) 하나 — 개인 공간에서 겹쳐 볼 조직 할 일은 그 조직 목록이 아직 없을 때만 받고(직원 목록 포함, 조직마다 한 번),
// 그 뒤는 탭 복귀(1분에 한 번)·쓰기 뒤에만 다시 읽는다. 쓰기는 사람이 누를 때만, 여러 건을 한꺼번에 바꾸면 쓰기 N번 뒤 읽기는 공간마다 한 번·일정 창 한 번만. 폴링 없음.
// 할 일 분류(유건 10/4)는 공간마다 세션에 한 번 읽고(office_task_category_list), 분류를 바꾼 뒤에는 돌려받은 목록을 그대로 쓴다.
// 바뀐 기록(office_task_history)은 할 일 패널을 열 때·고친 뒤에만 읽는다.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ME, SPACES, canManage, getMode } from '../core/session.js';
import { useTasks, useTaskRows, ensureTasks, rowsIn, loadTasks, taskAction, rpc, orgOf, trackWrite, shareSampleTasks, taskError } from '../core/tasks.js';
import { viewRows, taskOrgKeys } from '../core/task-model.js';
import { writeEvent, refreshEvents, loadPeople } from '../calendar/api.js';
import { writableOrgs, idOf } from '../calendar/shared.js';
import { SAMPLE_TASKS, SAMPLE_TASK_CATEGORIES, sampleTaskWrite, sampleCategoryWrite, sampleTaskHistory } from '../data/calendar-sample.js';
import { crewName } from '../core/store.js';

const sample = () => getMode() === 'sample';
// 할 일 쓰기 오류 → 사전 키는 core/tasks.js(taskError) 한 곳에서 정한다 — 한 건 쓰기(taskAction)·여러 건 쓰기·예시 모드가 같은 글자를 보이게(분리 검수 LOW-4)

/* ── 할 일 읽기 ── */
let version = 0;
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

/** 이 공간 보기에 들어갈 할 일(+ space 키). 개인 공간은 내 할 일 + 속한 조직(손님 제외)에서 나에게 맡겨진 할 일 — 메뉴 배지·챙길 것과 같은 저장소·같은 함수(core/tasks.js useTaskRows → task-model.js viewRows).
 *  조직 할 일은 조직 화면과 같은 저장소(core/tasks.js)에 받는다 — 따로 사본을 두면 조직 화면에서 고친 일이 개인 공간에 옛 값으로 남았다(10/4 분리 검수) */
export function useViewTasks(space) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const st = useTasks(space);
  const orgs = space === 'me' ? taskOrgKeys(SPACES) : [];
  useEffect(() => { if (!sample()) orgs.forEach((k) => ensureTasks(k)); }, [space, orgs.join(), ME.id]);
  const live = useTaskRows(space);
  const demo = useMemo(() => {
    if (!sample()) return null;
    // 예시 할 일에는 분류 이름을 붙여 준다(서버 office_task_list가 붙이는 것과 같은 칸)
    const rowsIn = (key) => SAMPLE_TASKS.filter((x) => x.org === (key === 'me' ? null : key) && !x.cancelled_at).map((x) => ({ ...x, category: SAMPLE_TASK_CATEGORIES[key]?.find((c) => c.id === x.category_id)?.name ?? null }));
    const mineRows = rowsIn(space), byOrg = new Map(orgs.map((k) => [k, rowsIn(k)]));
    return { rows: viewRows({ space, own: mineRows, orgRows: byOrg, orgKeys: orgs, me: ME.id }), mineRows, byOrg };
  }, [space, version, orgs.join(), ME.id]);
  // 예시 모드: 같은 예시 행을 메뉴 배지·챙길 것(18차)에도 — 배지는 할 일 저장소만 보고 예시 데이터는 이 묶음에 있다
  useEffect(() => { if (!demo) return; shareSampleTasks(space, demo.mineRows); demo.byOrg.forEach((rows, k) => shareSampleTasks(k, rows)); }, [demo, space]);
  // 내 할 일을 못 읽었어도 받아 둔 조직 할 일은 보인다(10/4 재검수 — 합치기 전과 같게). 받는 중이면 빈 목록
  return demo ? demo.rows : live ?? (st.error && orgs.length ? viewRows({ space, own: [], orgRows: new Map(orgs.map((k) => [k, rowsIn(k)])), orgKeys: orgs, me: ME.id }) : []);
}

// 분류·직원 캐시는 읽은 계정 것만 — 새로고침 없이 계정이 바뀌면(로그아웃 뒤 다른 계정 로그인 등) 비운다(10/4 재검수: 옛 계정의 개인 분류가 보였다)
let dataOwner = null;
const ownData = () => { if (dataOwner !== ME.id) { dataOwner = ME.id; cats.clear(); catLoading.clear(); peopleOf.clear(); } };

/** 사람 이름·조직 직원(맡기기 판정) — 조직 공간은 useTasks가 이미 받은 직원 목록, 개인 공간·예시는 조직마다 한 번(loadPeople 캐시) */
const peopleOf = new Map();
export function usePeople(space) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const { people } = useTasks(space);
  useEffect(() => {
    if (!sample() && space !== 'me') return;
    const orgs = space === 'me' ? writableOrgs() : SPACES.filter((s) => s.key === space);
    let live = true;
    const owner = ME.id;
    Promise.all(orgs.map((s) => loadPeople(idOf(s)).then((p) => { if (owner === ME.id) { ownData(); peopleOf.set(s.key, p); } }).catch(() => {}))).then(() => { if (live) emit(); });
    return () => { live = false; };
  }, [space, ME.id]);
  return useMemo(() => {
    ownData();
    if (!sample() && space !== 'me' && people) peopleOf.set(space, people);
    const names = new Map([[ME.id, ME.name]]);
    for (const list of peopleOf.values()) for (const p of list) if (!names.has(p.user_id)) names.set(p.user_id, p.name);
    return {
      me: ME.id,
      name: (key) => (!key || key === 'none' ? '' : key.startsWith('a:') ? crewName(key.slice(2)) || key.slice(2) : names.get(key.slice(2)) ?? '?'),
      members: (k) => { const list = peopleOf.get(k); return list ? new Set(list.filter((p) => p.role !== 'guest').map((p) => p.user_id)) : null; },
      list: (k) => peopleOf.get(k) ?? [],
    };
  }, [people, space, version, ME.id]);
}

/* ── 할 일 분류 ── */
const cats = new Map(), catLoading = new Map(); // 공간 키 → [{ id, name, position, tasks }]
function loadCats(space, force = false) {
  if (sample() || space === 'shared') return;
  ownData();
  if (!force && (cats.has(space) || catLoading.has(space))) return catLoading.get(space);
  const owner = ME.id;
  const p = rpc('office_task_category_list', { p_org: orgOf(space) })
    .then((rows) => { if (owner === ME.id) cats.set(space, rows ?? []); }, () => { if (owner === ME.id && !cats.has(space)) cats.set(space, []); })
    .finally(() => { if (catLoading.get(space) === p) catLoading.delete(space); emit(); });
  catLoading.set(space, p);
  return p;
}
/** 그 공간의 분류(관리 순서) — 예시는 화면 메모리(할 일 수는 관리할 수 있는 공간만, 서버와 같다), 로그인은 읽어 둔 목록 */
export function categoriesOf(space) {
  if (!sample()) { ownData(); return cats.get(space) ?? []; }
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
  useEffect(() => { if (!sample()) key.split(',').filter(Boolean).forEach((s) => loadCats(s)); }, [key, ME.id]);
  return v;
}
/** 분류 관리 쓰기 — category.create|rename|order|delete. 이름이 바뀌거나 지우면 그 공간 할 일 목록을 다시 읽는다(분류 이름·미분류가 바로 보이게) */
export async function writeCategory(space, action, data) {
  if (sample()) {
    try { sampleCategoryWrite(space, action, data); } catch (e) { throw new Error(taskError(e)); }
    emit();
    return;
  }
  const owner = ME.id;
  try { const next = (await rpc('office_task_category_write', { p_org: orgOf(space), p_action: action, p_data: data })) ?? []; if (owner === ME.id) { ownData(); cats.set(space, next); } }
  catch (e) { throw new Error(taskError(e)); } finally { emit(); }
  if (action === 'category.rename' || action === 'category.delete') { // 분류 관리는 보고 있는 공간의 것이라 그 공간 목록은 이미 받아 둔 상태다
    await loadTasks(space, true);
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

/** 계획(model.js)대로 쓴다 — 한 건씩 보내고, 끝나면 다시 읽기는 그 할 일의 공간마다 한 번·일정 창 한 번.
 *  한 건이면 먼저 화면에 반영한다 — 개인 공간에서 본 조직 할 일도 같은 저장소라 그대로 반영·되돌리기(10/4 재검수). 반환 { ok, failed: 첫 오류의 사전 키 | null } */
export const runWrites = (writes) => trackWrite(() => writeAll(writes)); // 쓰는 동안 탭 복귀 다시 읽기를 미룬다(18차)
async function writeAll(writes) {
  let ok = 0, failed = null, events = false;
  const stores = new Set();
  for (const w of writes) {
    try {
      if (w.type === 'task') {
        const optimistic = writes.length === 1 && !sample();
        await writeTask(w, optimistic);
        if (!optimistic) stores.add(w.space);
      } else {
        const action = w.type.slice(6);
        await writeEvent(action, action === 'save' ? w.row : action === 'skip' ? { id: w.id, day: w.day } : { id: w.id }, { refresh: false });
        events = true;
      }
      ok++;
    } catch (e) { failed ??= e.message; }
  }
  if (sample()) emit();
  else await Promise.all([...stores].map((k) => loadTasks(k, true)));
  if (events) await refreshEvents();
  return { ok, failed };
}

/* ── 보기 설정(사람마다 — 이 브라우저에, 계정별 키) ── */
const cfgKey = (id) => `argo-office-views:${ME.id}:${id}`;
export function readCfg(id) { try { return JSON.parse(localStorage.getItem(cfgKey(id)) ?? 'null'); } catch { return null; } }
export function writeCfg(id, cfg) { try { localStorage.setItem(cfgKey(id), JSON.stringify(cfg)); } catch { /* 사생활 보호 모드 — 이번만 */ } }
