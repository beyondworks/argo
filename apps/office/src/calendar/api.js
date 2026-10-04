// 일정 데이터 — 서버 office_event_list / office_event_write 함수로만(표를 직접 읽는 길은 없다). 명세: 유건 9/30.
// 부하: 달력을 열거나 읽기 창(한 달 격자·목록 31일·거래처 360일)이 바뀔 때 1회 읽기, 저장·삭제 때만 쓰기. 폴링 없음.
// 연속 월 보기는 스크롤이 멈춘 뒤 보이는 주의 달 격자 창(보통 2~3개)만 읽는다 — 지나간 달은 캐시에서 꺼내 다시 받지 않는다.
// 읽은 창은 화면 메모리에 두고 다시 쓰며(같은 창을 다시 받지 않음), 쓰기 뒤에만 비우고 지금 창을 한 번 다시 읽는다.
// 예시 모드(서버 설정 없음)는 아래 예시 일정을 화면 메모리에서 읽고 쓴다(새로고침하면 처음으로).
// 다른 기기 변경 반영(18차): 탭(창)으로 돌아올 때만, 떠 있는 창을 1분에 한 번까지 한 번에 다시 읽는다(창을 덮는 한 범위로 읽기 1회, 쓰기 0, 쓰는 중이면 건너뜀).
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { configured } from '../core/supabase.js';
import { rpc } from '../core/tasks.js';
import { ME, getMode } from '../core/session.js';
import { refetchDue, onTabReturn, keepResponse } from '../core/refetch.js';
import { kstStart, unionWindow, eventsIn } from './model.js';
import { SAMPLE_PEOPLE, SAMPLE_CUSTOMERS, sampleList, sampleWrite } from '../data/calendar-sample.js';

const ERRORS = { calendar_forbidden: 'forbidden', calendar_invalid: 'invalid', calendar_not_found: 'missing', calendar_limit: 'limit', task_signin: 'signin' };
export const calError = (e) => `cal.error.${ERRORS[e?.message] ?? (String(e?.code) === '42501' ? 'forbidden' : 'request')}`;

/* ── 읽기 창 캐시 ── */
let cache = new Map(), version = 0;
const active = new Map(); // 지금 화면에 떠 있는 창(키 → 보는 곳 수) — 쓰기 뒤 이것만 다시 읽는다
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };

/** 버린 응답의 창 — 아직 떠 있으면 지금 계정으로 다시 읽고, 아니면 비운다 */
const stale = (key, from, to) => { cache.delete(key); if (active.has(key)) return fetchWindow(key, from, to); emit(); };
const list = (from, to) => rpc('office_event_list', { p_from: new Date(kstStart(from)).toISOString(), p_to: new Date(kstStart(to)).toISOString() });
async function fetchWindow(key, from, to) {
  cache.set(key, { ...cache.get(key), loading: true, error: null });
  emit();
  const owner = ME.id;
  try {
    const data = configured ? await list(from, to) : sampleList();
    if (!keepResponse({ owner, nowOwner: ME.id })) return stale(key, from, to); // 계정을 바꾸는 사이 온 옛 계정 응답은 버린다(18차 검수 LOW 10)
    cache.set(key, { events: data?.events ?? [], orgs: data?.orgs ?? [], loading: false, error: null, at: Date.now() });
  } catch (e) { if (owner !== ME.id) return stale(key, from, to); cache.set(key, { ...cache.get(key), loading: false, error: calError(e) }); }
  emit();
}

/* ── 탭 복귀 다시 읽기(18차) ── */
let writing = 0, tried = 0, gen = 0; // gen = 캐시를 비우고 다시 읽은 횟수(쓰기 뒤 refreshEvents) — 그 사이에 시작한 탭 복귀 읽기는 옛것이라 버린다
onTabReturn(async () => {
  const keys = [...active.keys()], now = Date.now(), g = gen, owner = ME.id;
  if (!keys.length || !configured || getMode() !== 'signedIn') return;
  const oldest = Math.min(...keys.map((k) => cache.get(k)?.at ?? 0)); // 떠 있는 창 중 가장 오래전에 읽은 것
  if (!refetchDue({ hidden: document.hidden, now, last: Math.max(tried, oldest), busy: writing > 0 || keys.some((k) => cache.get(k)?.loading) })) return;
  tried = now;
  const span = unionWindow(keys);
  let data = null;
  try { if (span) data = await list(span.from, span.to); } catch { return; } // 조용히 — 보던 일정을 그대로 두고 다음 복귀 때 다시
  if (writing || g !== gen || !keepResponse({ owner, nowOwner: ME.id })) return; // 읽는 사이 쓰기가 시작됐거나 쓰기 뒤 다시 읽기가 지나갔거나 계정이 바뀌었다
  const events = data?.events ?? [];
  if (!data || events.length >= 3000) { await Promise.all(keys.map((k) => fetchWindow(k, ...k.split('|')))); return; } // 400일을 넘거나 서버 한도(3000건)에 닿으면 창마다 따로
  // 덮는 범위 안의 떠 있는 창만 새 일정으로. 떠 있지 않은 창은 버린다(다시 보일 때 새로 읽는다 — 옛 일정을 꺼내 보이지 않게), 읽는 사이 새로 뜬 창은 그대로
  const fresh = new Map(), at = Date.now();
  for (const k of active.keys()) {
    const [f, t] = k.split('|');
    if (f >= span.from && t <= span.to) fresh.set(k, { events: eventsIn(events, kstStart(f), kstStart(t)), orgs: data.orgs ?? [], loading: false, error: null, at });
    else if (cache.has(k)) fresh.set(k, cache.get(k));
  }
  cache = fresh;
  emit();
});

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

/** 여러 창(연속 월 보기) — fetchWins: 읽어 둘 창(스크롤이 멈춘 뒤 보이는 주의 창), showWins: 그릴 창(이미 읽은 것만 꺼낸다, 새로 읽지 않음).
 *  창 단위·키가 useEvents와 같아 같은 기간은 한 번만 읽는다. 반환 { events(창을 합쳐 id로 한 번씩), loading, error } */
export function useEventWindows(fetchWins, showWins) {
  const v = useSyncExternalStore(subscribe, () => version, () => version);
  const keyOf = ([f, t]) => `${f}|${t}`;
  const fkeys = fetchWins.map(keyOf), fsig = fkeys.join(','), ssig = showWins.map(keyOf).join(',');
  useEffect(() => {
    for (const k of fkeys) { active.set(k, (active.get(k) ?? 0) + 1); if (!cache.has(k)) fetchWindow(k, ...k.split('|')); }
    return () => { for (const k of fkeys) { const n = active.get(k) - 1; if (n > 0) active.set(k, n); else active.delete(k); } };
  }, [fsig]);
  return useMemo(() => {
    const byId = new Map();
    for (const k of ssig.split(',')) for (const e of cache.get(k)?.events ?? []) byId.set(e.id, e);
    const wins = fkeys.map((k) => cache.get(k));
    return { events: [...byId.values()], loading: wins.some((w) => !w || w.loading), error: wins.find((w) => w?.error)?.error ?? null };
  }, [ssig, fsig, v]);
}

/** 쓰기 — 실패하면 사전 키를 담은 오류를 던진다. 성공하면 읽은 창을 비우고 보고 있는 창만 다시 읽는다 */
export async function writeEvent(action, data, { refresh = true } = {}) {
  let out;
  writing++;
  try { out = configured ? await rpc('office_event_write', { p_action: action, p_data: data }) : sampleWrite(action, data); }
  catch (e) { throw new Error(calError(e)); }
  finally { writing--; }
  if (refresh) await refreshEvents();
  return out;
}
/** 읽은 창을 비우고 보고 있는 창만 다시 읽는다 — 여러 건을 한꺼번에 쓴 뒤 한 번만(여러 보기의 한꺼번에 바꾸기) */
export async function refreshEvents() {
  cache = new Map(); gen++;
  await Promise.all([...active.keys()].map((k) => fetchWindow(k, ...k.split('|'))));
}

/* ── 조직 사람·거래처(상세 창을 열 때만, 화면 메모리에 한 번) ── */
const once = new Map();
const remember = (key, fn) => { if (!once.has(key)) once.set(key, fn().catch((e) => { once.delete(key); throw e; })); return once.get(key); };
export const loadPeople = (org) => remember(`people:${org}`, async () => (configured ? (await rpc('office_org_people', { p_org: org })) ?? [] : SAMPLE_PEOPLE[org] ?? []));
/** 일정 scope('o:'+조직 또는 'u:'+나)의 거래처 — 업무 데이터 읽기(office_business_read)의 거래처 목록을 쓴다 */
export const loadCustomers = (org) => remember(`cust:${org ?? 'me'}`, async () => (configured
  ? ((await rpc('office_business_read', { p_org: org }))?.customers ?? []).filter((c) => !c.archived_at).map((c) => ({ id: c.id, name: c.name })) // 보관한 거래처는 고르기에서 뺀다(이미 연결된 일정은 상세 창이 이름을 따로 붙인다)
  : SAMPLE_CUSTOMERS[org ?? 'me'] ?? []));
