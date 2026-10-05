// 메일(내 공간) — 연결한 계정(Gmail·Google Workspace)의 메일을 서버 함수(api/mail)로 읽고 보낸다. 본문은 DB에 두지 않는다.
// 목록은 이 기기에 캐시해 바로 그리고(가게 상태), 읽음·보관은 보낼 목록(transport 'mail.flag'), 별표는 따로 'mail.star'로 뒤에서 반영한다.
// 15차: 더 보기(다음 쪽 토큰)·검색(여러 계정 합치기)·바뀐 것만 받기(sync — 계정별 변경 번호는 이 기기 localStorage, DB 쓰기 0)·
//       요청 제한 남은 시간·초안 고치기/보내기/지우기·예시 모드의 같은 흐름(가짜 발송·가짜 초안).
// 자동 갱신(wantSync): 메일 화면이 보이는 동안 30초, 새 메일 알림을 켰으면 다른 화면에서도 60초 — 숨긴 탭에서는 멈춘다(서버 주기 작업 없음).
//   부하: 열린 탭 하나·계정 하나, 메일 화면을 보는 동안 분당 서버 함수 2회(+ 계정마다 DB 읽기 2·Gmail history 2). 다른 화면은 알림을 켰을 때만 분당 1회.
import { getClient } from './supabase.js';
import { getMode, ME } from './session.js';
import { update, getState } from './store.js';
import { outbox } from './sync.js';
import { VIEWABLE } from './viewable.js';
import { isDesktop, apiUrl, saveAttachment } from './platform.js';
import { restore, persist, forget, scopedStorageKey, getStorageScope } from './save.js';
import { mergeList, applySync, newArrivals, byDate, replySubject, ATTACH_CAP as CAP } from '../pages/mail-model.js';
import { t, registerDict } from './i18n.js';
import { MAIL_DICT } from '../pages/mail-i18n.js';

registerDict(MAIL_DICT); // 예시 메일 글도 사전에서(메일 화면보다 먼저 불릴 수 있다 — 알림 감시·첫 화면의 받은편지함 받기)

export const ATTACH_CAP = CAP; // ponytail: 서버 함수 요청 한도(4.5MB, base64 4/3배) 안 — 넘는 파일은 문서함 링크로(유건 결정 5)

/* ── 요청 제한(429) — 남은 시간을 화면이 보이고, 그동안은 자동 갱신·새로고침을 쉬게 한다 ── */
let limitUntil = 0;
const limitL = new Set();
export const limitLeft = () => Math.max(0, Math.ceil((limitUntil - Date.now()) / 1000));
export const subscribeLimit = (l) => { limitL.add(l); return () => limitL.delete(l); };
export const getLimitUntil = () => limitUntil;
function noteLimit(sec) {
  const until = Date.now() + Math.max(1, Number(sec) || 30) * 1000;
  if (until <= limitUntil) return;
  limitUntil = until; limitL.forEach((l) => l());
  setTimeout(() => limitL.forEach((l) => l()), until - Date.now() + 50);
}

export async function api(op, body, { method = body ? 'POST' : 'GET', query } = {}) {
  const sb = await getClient();
  const jwt = (await sb?.auth.getSession())?.data.session?.access_token;
  const r = await fetch(apiUrl(`/api/mail/${op}${query ? `?${new URLSearchParams(query)}` : ''}`), {
    method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  if (op === 'attachment' && r.ok) return r.blob();
  const data = await r.json().catch(() => ({}));
  if (r.status === 429) noteLimit(data.retryAfter ?? r.headers.get('retry-after'));
  if (!r.ok) throw Object.assign(new Error(data.error ?? 'mail'), { code: data.error ?? 'server', status: r.status, retryAfter: data.retryAfter, transient: r.status >= 500 && r.status !== 503 });
  return data;
}

let config = null;
// 못 읽으면 failed — '서버에 Google 연결 설정이 없다'와 나눈다(OFC-08: 읽기 실패가 설정 없음으로 보였다). 실패는 기억하지 않아 다음에 다시 읽는다
export const mailConfig = () => (config ??= api('config').catch(() => { config = null; return { google: null, failed: true }; }));
const real = () => getMode() === 'signedIn';
const okAccounts = () => (getState().mailAccounts ?? []).filter((a) => a.status === 'ok');
const busy = (id) => outbox.has(`mail:${id}`) || outbox.has(`star:${id}`);
const markExpired = (id) => update((s) => ({ mailAccounts: s.mailAccounts.map((a) => (a.id === id ? { ...a, status: 'expired' } : a)) }));

/** 연결한 계정 목록 — 없어진 계정의 캐시 메일은 치운다(예시 메일 포함) */
export async function loadAccounts() {
  if (!real()) return;
  const sb = await getClient();
  const { data, error } = await sb.from('office_mail_accounts').select('id, provider, address, display_name, hosted_domain, status').order('created_at');
  if (error) throw error;
  const ids = new Set(data.map((a) => a.id));
  update((s) => ({ mailAccounts: data, mails: s.mails.filter((m) => ids.has(m.account)) }));
}

/* ── 목록·더 보기·검색 ── */
const pages = new Map(); // 보기(또는 'q:<검색어>') → { 계정: 다음 쪽 토큰 | null } — 이 탭 메모리에만
export const hasMore = (key) => Object.values(pages.get(key) ?? {}).some(Boolean);

/** 목록 받기 — view: 메일함(보기), more: 다음 쪽, q: 검색어(모든 메일에서, 계정마다 받아 합친다). 돌려주는 값 { ids(받은 메일), failed, more } */
export async function pullMail(view, { more = false, q = null } = {}) {
  if (!real()) return sampleList(view, q);
  const accounts = okAccounts();
  if (!accounts.length) return { ids: [], failed: [], more: false };
  const key = q ? `q:${q}` : view;
  const tokens = more ? pages.get(key) ?? {} : {};
  const targets = more ? accounts.filter((a) => tokens[a.id]) : accounts;
  // 목록·검색은 요청 본문으로(POST) — 검색어가 주소에 실리면 서버·CDN 접근 기록에 남는다(분리 검수 LOW-11)
  const results = await Promise.allSettled(targets.map((a) => api('list', { account: a.id, folder: view ?? 'inbox', ...(q ? { q } : {}), ...(more ? { page: tokens[a.id] } : {}) })));
  const got = [], done = new Set(), next = { ...(more ? tokens : {}) }, failed = [];
  results.forEach((r, i) => {
    const a = targets[i];
    if (r.status === 'fulfilled') { done.add(a.id); got.push(...r.value.items); next[a.id] = r.value.next ?? null; return; }
    failed.push({ account: a, code: r.reason?.code, retryAfter: r.reason?.retryAfter });
    if (r.reason?.code === 'expired') markExpired(a.id);
  });
  pages.set(key, next);
  update((s) => ({ mails: mergeList(s.mails, got, { view: q ? null : view, done, busy, append: more || !!q, hasMore: next }) }));
  return { ids: got.sort(byDate).map((m) => m.id), failed, more: hasMore(key) };
}

/* ── 바뀐 것만 받기(Gmail history) ── */
const HIST = () => scopedStorageKey('argo-office-mail-history');
const seen = new Set(); // 이번 화면에서 한 번 이상 맞춘 계정 — 처음 맞출 때(닫혀 있던 동안 온 메일)는 알리지 않는다
let syncing = null;
/** 계정마다 변경 번호부터 바뀐 것을 받아 목록에 반영 → { arrivals(알릴 새 메일), reset } . 겹쳐 부르면 진행 중인 것을 같이 기다린다 */
export function syncMail(opts = {}) { return (syncing ??= runSync(opts).finally(() => { syncing = null; })); }
async function runSync({ view = 'inbox' } = {}) {
  if (getMode() === 'sample') return sampleSync();
  if (!real() || limitLeft() > 0) return { arrivals: [], skipped: true };
  const accounts = okAccounts();
  if (!accounts.length) return { arrivals: [] };
  const key = HIST(), hist = restore(key, {});
  const res = await api('sync', { accounts: accounts.map((a) => ({ account: a.id, since: hist[a.id] ?? null })) });
  if (HIST() !== key) return { arrivals: [] }; // 기다리는 사이 로그아웃·계정 전환 — 이 결과는 지금 저장 범위 것이 아니다(10/4 4차 검수 L4)
  const arrivals = [];
  let reset = false;
  for (const r of res.results ?? []) {
    if (r.error) { if (r.error === 'expired') markExpired(r.account); if (r.error === 'rate_limited') noteLimit(r.retryAfter); continue; }
    if (r.historyId) hist[r.account] = r.historyId;
    const first = !seen.has(r.account);
    seen.add(r.account);
    if (r.reset) { reset = true; continue; }
    if (r.primed) continue;
    const changed = r.changed ?? [], gone = new Set((r.gone ?? []).map((g) => `${r.account}.${g}`));
    if (!first) arrivals.push(...newArrivals(getState().mails, changed));
    update((s) => ({ mails: applySync(s.mails, changed, gone, busy) }));
  }
  persist(key, hist, 0);
  if (reset) await pullMail(view).catch(() => {}); // 변경 기록이 만료됐거나 한꺼번에 많이 바뀌면 보고 있는 목록을 새로 받는다
  return { arrivals, reset };
}

/* ── 자동 갱신 — 화면이 보이는 동안만, 여러 곳이 원하면 가장 짧은 간격으로 하나만 ── */
const wants = new Map();
let timer = null, lastSync = 0;
const listeners = new Set();
export const lastSynced = () => lastSync;
export const subscribeSync = (l) => { listeners.add(l); return () => listeners.delete(l); };
/** opts: { ms, view, notify } — 돌려받은 함수로 그만둔다 */
export function wantSync(id, opts) { wants.set(id, opts); schedule(); return () => { wants.delete(id); schedule(); }; }
function schedule() {
  clearTimeout(timer); timer = null;
  if (!wants.size || typeof document === 'undefined' || document.hidden || getMode() === 'signedOut' || getMode() === 'loading') return;
  const ms = Math.min(...[...wants.values()].map((w) => w.ms));
  timer = setTimeout(tick, Math.max(0, lastSync + ms - Date.now(), limitUntil - Date.now()));
}
async function tick() {
  timer = null;
  const ws = [...wants.values()];
  lastSync = Date.now();
  try {
    const out = await syncMail({ view: ws.find((w) => w.view)?.view });
    if (out?.arrivals?.length && ws.some((w) => w.notify)) import('./mail-notify.js').then((m) => m.notifyMail(out.arrivals)).catch(() => {});
  } catch { /* 다음 차례에 다시 */ }
  listeners.forEach((l) => l());
  schedule();
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => schedule()); // 숨기면 멈추고, 돌아오면 밀린 만큼 바로
/** 새로고침 단추 — 지금 바로(목록 + 바뀐 것) */
export async function refreshMail(view, q) {
  lastSync = Date.now();
  const list = await pullMail(view, { q });
  await syncMail({ view }).catch(() => {});
  listeners.forEach((l) => l());
  schedule();
  return list;
}

/* ── 새 메일 알림 켜기(이 기기) ── */
const NOTIFY = 'argo-office-mail-notify';
export const notifyOn = () => { try { return localStorage.getItem(NOTIFY) === '1'; } catch { return false; } };
export function setNotifyOn(on) {
  try { if (on) localStorage.setItem(NOTIFY, '1'); else localStorage.removeItem(NOTIFY); } catch { /* 저장소 없음 */ }
  window.dispatchEvent(new Event('office-mail-notify'));
}
export const subscribeNotify = (cb) => { window.addEventListener('office-mail-notify', cb); return () => window.removeEventListener('office-mail-notify', cb); };

/* ── 본문 ── */
const bodies = new Map(); // 본문은 이 탭에서만(저장하지 않는다)
export async function readMail(m) {
  if (!m.account) return { text: (m.body ?? []).join('\n\n') || m.snippet || '', html: null, attachments: [], cc: m.cc ?? '', to: m.to ?? '', messageId: '', references: '' }; // 예시 메일
  if (!bodies.has(m.id)) bodies.set(m.id, api('read', null, { query: { account: m.account, id: m.gid } }).catch((e) => { bodies.delete(m.id); throw e; }));
  return bodies.get(m.id);
}
export const forgetBody = (id) => bodies.delete(id);

/** 별표 — 화면을 먼저 바꾸고 보낼 목록으로(실패하면 transport가 알린다). 읽음·보관과 따로 보내 서로의 값을 덮지 않는다 */
export function toggleStar(m) {
  const on = !m.starred;
  update((s) => ({ mails: s.mails.map((x) => (x.id === m.id ? { ...x, starred: on } : x)) }), m.account ? [[`star:${m.id}`, { type: 'mail.star', id: m.id, on }]] : []);
}

/** Google 로그인 → 권한 승인 화면으로 보낸다(돌아오는 곳: /me/mail/connect) */
export async function connectGoogle(hint) {
  const { url } = await api('start', { hint, ...(isDesktop() ? { desktop: true } : {}) });
  if (isDesktop()) {
    const { startDesktopMail } = await import('./desktop-auth.js'); // 데스크톱에서만 받는다
    const result = await startDesktopMail(url);
    await loadAccounts();
    await pullMail('inbox');
    return result;
  }
  location.assign(url);
}
export const finishConnect = (code, state) => api('finish', { code, state });
export async function disconnectAccount(id) {
  await api('disconnect', { account: id });
  await loadAccounts();
}

/* ── 쓰기·초안 — 예시 모드는 가게 상태에 가짜 초안·보낸 메일을 남긴다(같은 흐름) ── */
const sampleId = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sampleMail = (msg) => ({ to: msg.to ?? '', cc: msg.cc ?? '', subject: msg.subject ?? '', snippet: (msg.text ?? '').replace(/\s+/g, ' ').slice(0, 120), body: String(msg.text ?? '').split(/\n{2,}/), html: msg.html ?? null, at: new Date().toISOString(), unread: false, from: t('mailx.me'), addr: getState().mailAccounts?.[0]?.address ?? ME.email });
export async function saveDraft(msg) {
  if (real()) return api('draft', msg);
  const id = msg.draftId ?? sampleId('sd');
  update((s) => ({ mails: [...s.mails.filter((m) => m.draftId !== id), { id, draftId: id, folder: 'drafts', ...sampleMail(msg) }] }));
  return { draftId: id };
}
export async function sendMail(msg) {
  if (!real()) {
    update((s) => ({ mails: [...s.mails.filter((m) => !msg.draftId || m.draftId !== msg.draftId), { id: sampleId('ss'), folder: 'sent', ...sampleMail(msg) }] }));
    return { id: 'sample' };
  }
  const out = await api('send', msg); // 보낸편지함 다시 받기는 작성 창이 한다(15차 C12) — 견적·계약 서명 메일(esign-flow)이 서명자마다 목록을 받지 않게
  if (msg.draftId) update((s) => ({ mails: s.mails.filter((m) => m.draftId !== msg.draftId) })); // 보낸 초안은 서버가 지웠다 — 목록에서도
  return out;
}
/** 임시 보관함 메일을 그대로 보내기 */
export async function sendDraft(m) {
  if (!m.account) { update((s) => ({ mails: s.mails.map((x) => (x.id === m.id ? { ...x, folder: 'sent', draftId: undefined, at: new Date().toISOString() } : x)) })); return; }
  await api('draftSend', { account: m.account, draftId: m.draftId });
  update((s) => ({ mails: s.mails.filter((x) => x.id !== m.id) }));
  pullMail('sent').catch(() => {});
}
/** 임시 보관함 메일 지우기(되돌릴 수 없다 — 화면이 확인을 받는다) */
export async function deleteDraft(m) {
  if (m.account) await api('draftDelete', { account: m.account, draftId: m.draftId });
  update((s) => ({ mails: s.mails.filter((x) => x.id !== m.id) }));
}

/* ── 쓰던 메일(이 기기) — 새로고침·탭 닫기 뒤에 이어 연다. 첨부 파일 자체는 남기지 않는다 ── */
const SNAP = () => scopedStorageKey('argo-office-mail-compose');
export const readSnap = () => restore(SNAP(), null);
export const saveSnap = (snap) => { if (getStorageScope()) persist(SNAP(), snap, 200); }; // 로그아웃 뒤 늦게 끝난 저장은 남기지 않는다(10/4 4차 검수 L4)
export const clearSnap = () => forget(SNAP());
/** 마지막으로 본 메일함(이 기기) */
const VIEW_KEY = 'argo-office-mail-view';
export const readView = () => { try { return localStorage.getItem(VIEW_KEY) || 'inbox'; } catch { return 'inbox'; } };
export const writeView = (v) => { try { localStorage.setItem(VIEW_KEY, v); } catch { /* 저장소 없음 */ } };

/* ── 예시 모드(로그인 전) ── */
function sampleList(view, q) {
  const all = getState().mails;
  if (!q) return { ids: all.filter((m) => m.folder === view).map((m) => m.id), failed: [], more: false };
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (m) => { const s = [m.subject, m.from, m.addr, m.to, m.snippet, ...(m.body ?? [])].join(' ').toLowerCase(); return words.every((w) => s.includes(w)); };
  return { ids: all.filter((m) => m.folder !== 'trash' && hit(m)).sort(byDate).map((m) => m.id), failed: [], more: false };
}
let sampleArrived = false, sampleFirst = 0;
/** 예시: 자동 갱신 흐름을 보이려고 처음 한 번만 새 메일 한 통이 들어온다(이 화면에서만) — 첫 확인에서는 없고, 다음 확인(30초쯤 뒤)에 온다 */
function sampleSync() {
  if (sampleArrived) return { arrivals: [] };
  if (!sampleFirst) { sampleFirst = Date.now(); return { arrivals: [] }; }
  if (Date.now() - sampleFirst < 20_000) return { arrivals: [] };
  sampleArrived = true;
  const body = t('mailx.s.newBody').split('\n\n');
  const m = { id: 'm-new', folder: 'inbox', from: t('mailx.s.newFrom'), addr: 'minsu.kim@hanbit.example', subject: t('mailx.s.newSubject'), at: new Date().toISOString(), unread: true, body, snippet: body[0] };
  if (getState().mails.some((x) => x.id === m.id)) return { arrivals: [] };
  update((s) => ({ mails: [...s.mails, m] }));
  return { arrivals: [m] };
}
/** 예시: 별표·임시 보관함 흐름이 보이게 처음 한 번 채운다 */
export function seedSample() {
  if (getMode() !== 'sample' || getState().mails.some((m) => m.id === 'sd-sample')) return;
  const body = t('mailx.s.draftBody').split('\n\n'), m1 = getState().mails.find((m) => m.id === 'm1');
  update((s) => ({ mails: [...s.mails.map((m) => (m.id === 'm4' ? { ...m, starred: true } : m)),
    { id: 'sd-sample', draftId: 'sd-sample', folder: 'drafts', from: t('mailx.me'), addr: 'yoogeon@beyondworks.example', to: m1?.addr ?? 'jihyun.park@hanbit-corp.example', subject: replySubject(m1?.subject ?? ''),
      at: new Date(Date.now() - 40 * 60_000).toISOString(), unread: false, snippet: body.join(' '), body }] }));
}

/** 파일 → { name, type, data(base64) } */
export const fileToPart = (f) => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok({ name: f.name, type: f.type, data: String(r.result).split(',')[1] ?? '' });
  r.onerror = () => no(r.error);
  r.readAsDataURL(f);
});

/** 첨부 열기 — PDF·그림·글·영상은 새 탭에서 바로, 나머지는 내려받기. 탭은 누른 순간에 연다(받은 뒤 열면 팝업 차단에 걸린다) */
export async function openAttachment(m, a) {
  if (isDesktop()) return downloadAttachment(m, a);
  if (!VIEWABLE.test(a.type ?? '')) return downloadAttachment(m, a);
  const w = window.open('', '_blank');
  try {
    const blob = await api('attachment', null, { query: { account: m.account, id: m.gid, att: a.id, name: a.name, type: a.type } });
    const url = URL.createObjectURL(new Blob([blob], { type: a.type }));
    if (w) { w.opener = null; w.location.href = url; } else location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000);
  } catch (e) { w?.close(); throw e; }
}

export async function downloadAttachment(m, a) {
  const blob = await api('attachment', null, { query: { account: m.account, id: m.gid, att: a.id, name: a.name } });
  if (isDesktop()) return saveAttachment(blob, a.name);
  const url = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: url, download: a.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 틀에 넣기 전 걷어낸다 — CSP·sandbox가 못 막는 문서 이동(meta refresh·base href)과 끼워 넣기(link·object·iframe·form),
 *  링크는 http(s)·mailto·tel·#만(새 창은 sandbox를 벗어나므로 javascript:·data: 금지). DOMParser 문서는 스크립트가 돌지 않는다 */
const DROP = 'script,meta,base,link,object,embed,iframe,frame,frameset,form,portal';
export function cleanMailHtml(html, parse = (h) => new DOMParser().parseFromString(h, 'text/html')) {
  const doc = parse(String(html ?? ''));
  doc.querySelectorAll(DROP).forEach((e) => e.remove());
  // 두 번 변환된 기호(&amp;amp;) 되돌리기 — 9/27 실측: 링크드인 메일의 프로필 사진 주소가 '&amp;v=…'로 와서 서명이 깨져 403, 본문엔 'Chairman &amp; CEO'
  const once = (v) => v.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (m, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]);
  doc.querySelectorAll('[src],[href],[srcset],[background]').forEach((el) => ['src', 'href', 'srcset', 'background'].forEach((a) => { const v = el.getAttribute(a); if (v?.includes('&amp;')) el.setAttribute(a, v.replace(/&amp;/g, '&')); }));
  const walk = doc.createTreeWalker(doc.body, 4);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/&(amp|lt|gt|quot|#39|#x27);/.test(n.nodeValue)) n.nodeValue = once(n.nodeValue);
  // 크기를 클래스 이름으로만 적고 스타일은 싣지 않은 메일(9/27 링크드인: w-[88px] h-8 rounded-full…) — 그 값만 읽어 그림에 적용한다.
  // 대괄호 값(w-[88px]) → 숫자 눈금(w-8 = 32px) → w-full 순. 숫자 width·height 속성이 있으면 그것을 따른다
  const size = (cls, k) => {
    const b = new RegExp(`(?:^|\\s)${k}-\\[(\\d+(?:\\.\\d+)?)px\\]`).exec(cls)?.[1];
    if (b) return `${b}px`;
    const n = new RegExp(`(?:^|\\s)${k}-(\\d+(?:\\.5)?)(?:\\s|$)`).exec(cls)?.[1];
    if (n) return `${n * 4}px`;
    return new RegExp(`(?:^|\\s)${k}-full(?:\\s|$)`).test(cls) ? '100%' : null;
  };
  doc.querySelectorAll('img[class]').forEach((img) => {
    const c = img.className;
    const w = !/^\d+$/.test(img.getAttribute('width') ?? '') && size(c, 'w'), h = !/^\d+$/.test(img.getAttribute('height') ?? '') && size(c, 'h'), mw = size(c, 'max-w');
    if (w) img.style.width = w;
    if (h) img.style.height = h;
    if (mw) img.style.maxWidth = mw;
    if (/(?:^|\s)rounded-full(?:\s|$)/.test(c)) img.style.borderRadius = '50%';
  });
  doc.querySelectorAll('[href]').forEach((a) => { if (!/^(https?:|mailto:|tel:|#)/i.test(a.getAttribute('href').trim())) a.removeAttribute('href'); });
  return [...doc.head.querySelectorAll('style')].map((s) => s.outerHTML).join('') + doc.body.innerHTML; // 메일은 <head>의 style을 쓴다
}

/** 메일 HTML을 격리된 틀에 넣을 문서 — 스크립트 없음(sandbox), 그림·글꼴 외 연결 차단(CSP), 이동·끼워 넣기 태그 제거, 링크는 새 탭.
 *  ponytail: 서버 정화(sanitize-html) 대신 브라우저 DOMParser로 걷어내고 sandbox + CSP로 막는다 — 틀 안은 출처가 없어 앱 쿠키·저장소에 닿지 않는다 */
export function mailDoc(html, { paper = 'transparent' } = {}) {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data: https:"; // 그림은 바로 보인다(유건 9/27: 깨지면 안 된다) — 본문 속 그림(cid)은 서버가 data:로 바꿔 넣는다
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">
<style>body{margin:0;padding:14px 16px;font:14px/1.6 -apple-system,'Pretendard Variable',sans-serif;color:#1d1d1f;background:${paper};word-break:keep-all;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${cleanMailHtml(html)}</body></html>`;
}

/** 메일 종이색 — 순백 대신 화면 톤. 메일 HTML은 밝은 바탕을 전제로 쓰이므로 다크 테마에서도 밝은 종이(글자색 쪽으로 섞은 톤)로 둔다 */
export function mailPaper() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return /dark/.test(cs.colorScheme) ? `color-mix(in srgb, ${v('--fg')} 86%, ${v('--bg')})` : `color-mix(in srgb, ${v('--card')} 62%, ${v('--bg')})`;
}

/** 회사 관리자에게 보낼 안내문 — 외부 앱이 막힌 Workspace에서 신뢰 등록을 요청할 때 */
export const adminNote = (t, cfg) => t('mailc.adminNote', { client: cfg?.google?.clientId ?? '-', scopes: (cfg?.google?.scopes ?? []).join('\n') });
