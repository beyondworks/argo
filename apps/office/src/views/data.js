// 여러 보기의 데이터 — 할 일 읽기(공간별)·쓰기 실행·보기 설정 저장. 계산은 model.js(순수), 화면은 Board.jsx.
// 부하(DB 위생): 읽기는 기존 그대로 — 할 일은 core/tasks.js 저장소(useTasks), 개인 공간에서 겹쳐 볼 조직 할 일은 조직마다 세션에 한 번
// (office_task_list). 쓰기는 사람이 누를 때만, 여러 건을 한꺼번에 바꾸면 쓰기 N번 뒤 읽기는 공간마다 한 번·일정 창 한 번만. 폴링 없음.
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { ME, SPACES, canManage, getMode } from '../core/session.js';
import { useTasks, loadTasks, taskAction, rpc, orgOf, taskError } from '../core/tasks.js';
import { writeEvent, refreshEvents, loadPeople } from '../calendar/api.js';
import { writableOrgs, idOf } from '../calendar/shared.js';
import { SAMPLE_TASKS, sampleTaskWrite } from '../data/calendar-sample.js';
import { crewName } from '../core/store.js';

const sample = () => getMode() === 'sample';

/* ── 할 일 읽기 ── */
let orgRows = new Map(), version = 0; // 개인 공간에 겹칠 조직 할 일(조직 키 → 행)
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const loading = new Map();
function loadOrg(space, force = false) {
  if (!force && (orgRows.has(space) || loading.has(space))) return loading.get(space);
  const p = rpc('office_task_list', { p_org: orgOf(space) })
    .then((rows) => { orgRows.set(space, rows ?? []); }, () => { if (!orgRows.has(space)) orgRows.set(space, []); })
    .finally(() => { loading.delete(space); emit(); });
  loading.set(space, p);
  return p;
}

/** 이 공간 보기에 들어갈 할 일(+ space 키). 개인 공간은 내 할 일 + 속한 조직에서 나에게 맡겨진 할 일 */
export function useViewTasks(space) {
  useSyncExternalStore(subscribe, () => version, () => version);
  const own = useTasks(space).rows;
  const orgs = space === 'me' ? writableOrgs().map((s) => s.key) : [];
  useEffect(() => { if (!sample()) orgs.forEach((k) => loadOrg(k)); }, [space, orgs.join()]);
  return useMemo(() => {
    const tag = (key) => (x) => ({ ...x, space: key });
    if (sample()) {
      const here = SAMPLE_TASKS.filter((x) => x.org === (space === 'me' ? null : space) && !x.cancelled_at).map(tag(space));
      return space === 'me' ? [...here, ...SAMPLE_TASKS.filter((x) => x.org && x.assignee === ME.id && !x.cancelled_at).map((x) => ({ ...x, space: x.org }))] : here;
    }
    const mine = (own ?? []).map(tag(space));
    return [...mine, ...orgs.flatMap((k) => (orgRows.get(k) ?? []).filter((x) => x.assignee === ME.id).map(tag(k)))];
  }, [own, space, version, orgs.join()]);
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

/** 권한 판정 문맥(model.js) — 관리자 = 조직 owner·admin(개인 공간은 관리자 없음, 서버와 같다) */
export const makeCtx = (today, people) => ({ today, me: ME.id, isAdmin: (space) => space !== 'me' && canManage(space), members: people.members });

/* ── 쓰기 ── */
async function writeTask(w, optimistic) {
  if (sample()) { try { sampleTaskWrite(w.space, w.action, w.data); } catch (e) { throw new Error(taskError(e)); } return; }
  if (optimistic) return taskAction(w.space, w.action, w.data, w.patch); // 한 건은 먼저 화면에 반영하고 실패하면 되돌린다(다시 읽기 포함)
  try { await rpc('office_task_write', { p_org: orgOf(w.space), p_action: w.action, p_data: w.data }); } catch (e) { throw new Error(taskError(e)); }
}

/** 계획(model.js)대로 쓴다 — 한 건씩 보내고, 끝나면 다시 읽기는 공간마다 한 번·일정 창 한 번. view: 보고 있는 공간
 *  (개인 공간에서 본 조직 할 일은 그 조직 목록을, 나머지는 공간 할 일 저장소를 다시 읽는다). 반환 { ok, failed: 첫 오류의 사전 키 | null } */
export async function runWrites(writes, view) {
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
