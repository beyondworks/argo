// 일정 데이터 — 서버 office_event_list / office_event_write 함수로만(표를 직접 읽는 길은 없다). 명세: 유건 9/30.
// 부하: 달력을 열거나 읽기 창(한 달 격자·목록 31일·거래처 360일)이 바뀔 때 1회 읽기, 저장·삭제 때만 쓰기. 폴링 없음.
// 읽은 창은 화면 메모리에 두고 다시 쓰며(같은 창을 다시 받지 않음), 쓰기 뒤에만 비우고 지금 창을 한 번 다시 읽는다.
// 예시 모드(서버 설정 없음)는 아래 예시 일정을 화면 메모리에서 읽고 쓴다(새로고침하면 처음으로).
import { useEffect, useSyncExternalStore } from 'react';
import { configured } from '../core/supabase.js';
import { rpc } from '../core/tasks.js';
import { kstStart } from './model.js';
import { SAMPLE_PEOPLE, SAMPLE_CUSTOMERS, SAMPLE_TASKS, sampleList, sampleWrite } from '../data/calendar-sample.js';

const ERRORS = { calendar_forbidden: 'forbidden', calendar_invalid: 'invalid', calendar_not_found: 'missing', calendar_limit: 'limit', task_signin: 'signin' };
export const calError = (e) => `cal.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'forbidden' : 'request')}`;

/* ── 읽기 창 캐시 ── */
let cache = new Map(), version = 0;
const active = new Map(); // 지금 화면에 떠 있는 창(키 → 보는 곳 수) — 쓰기 뒤 이것만 다시 읽는다
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

async function fetchWindow(key, from, to) {
  cache.set(key, { ...cache.get(key), loading: true, error: null });
  emit();
  try {
    const data = configured ? await rpc('office_event_list', { p_from: new Date(kstStart(from)).toISOString(), p_to: new Date(kstStart(to)).toISOString() }) : sampleList();
    cache.set(key, { events: data?.events ?? [], orgs: data?.orgs ?? [], loading: false, error: null });
  } catch (e) { cache.set(key, { ...cache.get(key), loading: false, error: calError(e) }); }
  emit();
}

/** [from, to) 한국 날짜 창의 일정 — { events, orgs, loading, error }. 같은 창은 한 번만 읽는다 */
export function useEvents(from, to) {
  const key = `${from}|${to}`;
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    active.set(key, (active.get(key) ?? 0) + 1);
    if (!cache.has(key)) fetchWindow(key, from, to);
    return () => { const n = active.get(key) - 1; if (n > 0) active.set(key, n); else active.delete(key); };
  }, [key]);
  return cache.get(key) ?? { loading: true };
}

/** 쓰기 — 실패하면 사전 키를 담은 오류를 던진다. 성공하면 읽은 창을 비우고 보고 있는 창만 다시 읽는다 */
export async function writeEvent(action, data, { refresh = true } = {}) {
  let out;
  try { out = configured ? await rpc('office_event_write', { p_action: action, p_data: data }) : sampleWrite(action, data); }
  catch (e) { throw new Error(calError(e)); }
  if (!refresh) return out;
  cache = new Map();
  await Promise.all([...active.keys()].map((k) => fetchWindow(k, ...k.split('|'))));
  return out;
}

/* ── 조직 사람·거래처(상세 창을 열 때만, 화면 메모리에 한 번) ── */
const once = new Map();
const remember = (key, fn) => { if (!once.has(key)) once.set(key, fn().catch((e) => { once.delete(key); throw e; })); return once.get(key); };
export const loadPeople = (org) => remember(`people:${org}`, async () => (configured ? (await rpc('office_org_people', { p_org: org })) ?? [] : SAMPLE_PEOPLE[org] ?? []));
/** 일정 scope('o:'+조직 또는 'u:'+나)의 거래처 — 업무 데이터 읽기(office_business_read)의 거래처 목록을 쓴다 */
export const loadCustomers = (org) => remember(`cust:${org ?? 'me'}`, async () => (configured
  ? ((await rpc('office_business_read', { p_org: org }))?.customers ?? []).map((c) => ({ id: c.id, name: c.name }))
  : SAMPLE_CUSTOMERS[org ?? 'me'] ?? []));
/** 개인 공간에서 겹쳐 볼 조직 할 일(나에게 맡겨진 것만 쓰는 쪽에서 거른다) — 달력을 열 때 조직마다 한 번 */
export const loadOrgTasks = (org) => remember(`tasks:${org}`, async () => (configured ? (await rpc('office_task_list', { p_org: org })) ?? [] : SAMPLE_TASKS.filter((x) => x.org === org)));
export const sampleTasks = (org) => SAMPLE_TASKS.filter((x) => x.org === org);
