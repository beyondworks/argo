// 문서함 데이터 — 로그인: office_file_* 함수(표를 직접 읽는 길 없음) + 파일 바이트는 R2(core/r2.js — 브라우저 ↔ R2 직접, 서명은 DB가 허락한 키만),
// 예시 모드: 이 브라우저 IndexedDB(sample.js). 부하: 문서함을 열거나 검색어가 바뀔 때 목록 1회 읽기, 사람이 누를 때만 쓰기, 글자 읽기 결과는 파일당 1회 쓰기.
// 휴지통 30일·남은 객체 정리는 서버 크론만 한다(로그인 모드 — 화면은 정리하지 않는다).
// 같은 목록 키(공간·휴지통·검색·거래처)는 한 번만 읽어 화면 메모리에 두고, 쓰기 뒤에는 보고 있는 목록만 다시 읽는다. 폴링 없음.
import { useEffect, useSyncExternalStore } from 'react';
import { configured, getClient } from '../core/supabase.js';
import { rpc, orgOf } from '../core/tasks.js';
import { ME } from '../core/session.js';
import { apiUrl, isDesktop, saveAttachment } from '../core/platform.js';
import { matches, uploadCheck, storagePath, segOf, classify, findCustomer, matchCustomer, clip, kindOf, ocrable, purgeDue } from './model.js';
import * as S from './sample.js';

const ERR = { file_forbidden: 'permission', file_input: 'input', file_not_found: 'missing', file_missing: 'missing', file_conflict: 'conflict', file_limit: 'limit', file_quota: 'quota', file_folder_not_empty: 'notEmpty', task_signin: 'signin',
  file_daily_limit: 'daily', uploads_paused: 'paused', file_size_mismatch: 'request', r2_not_configured: 'storage', storage: 'storage' };
const r2 = () => import('../core/r2.js'); // 로그인 모드에서만 받는다(첫 화면 묶음에 넣지 않는다)
const why = (e) => (/^files\.err\.[a-zA-Z_]+$/.test(e?.message ?? '') ? e.message.slice(10) : 'request'); // write()가 던진 사전 키 → 올리기 실패 이유
export const fileError = (e) => `files.err.${ERR[e?.code] ?? ERR[e?.message] ?? (String(e?.code) === '42501' ? 'permission' : 'request')}`;
const orgKey = (space) => (configured ? orgOf(space) : space); // 예시 공간은 id가 없어 키를 쓴다

/* ── 목록 캐시 ── */
let cache = new Map(), version = 0;
const active = new Map();
const listeners = new Set();
const emit = () => { version++; listeners.forEach((l) => l()); };
const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const keyOf = (space, { trash = false, q = '', customer = null } = {}) => JSON.stringify([space, !!trash, q.trim(), customer]);

async function fetchList(key) {
  const [space, trash, q, customer] = JSON.parse(key);
  cache.set(key, { ...cache.get(key), loading: true, error: null }); emit();
  try {
    const data = configured
      ? await rpc('office_file_list', { p_org: orgOf(space), p_q: q || null, p_trash: trash, p_customer: customer })
      : await S.sampleList(space, { q, trash, customer, match: matches });
    cache.set(key, { ...data, loading: false, error: null, at: Date.now() });
  } catch (e) { cache.set(key, { ...cache.get(key), loading: false, error: fileError(e) }); }
  emit();
}
/** 목록 — { files, folders, more, bytes, manager, loading, error } */
export function useFiles(space, opts = {}) {
  const key = keyOf(space, opts);
  useSyncExternalStore(subscribe, () => version, () => version);
  useEffect(() => {
    active.set(key, (active.get(key) ?? 0) + 1);
    if (!cache.has(key)) fetchList(key);
    return () => { const n = active.get(key) - 1; if (n > 0) active.set(key, n); else active.delete(key); };
  }, [key]);
  return cache.get(key) ?? { loading: true };
}
/** 쓰기 뒤: 읽은 목록을 비우고 보고 있는 목록만 다시 읽는다 */
export async function refreshFiles() {
  cache = new Map();
  await Promise.all([...active.keys()].map(fetchList));
}

async function write(space, action, data, { refresh = true } = {}) {
  let out;
  try { out = configured ? await rpc('office_file_write', { p_org: orgOf(space), p_action: action, p_data: data }) : await S.sampleWrite(space, action, data); }
  catch (e) { throw Object.assign(new Error(fileError(e)), { code: e?.code ?? e?.message }); }
  if (refresh) await refreshFiles();
  return out;
}
export const getFile = (space, id) => (configured ? rpc('office_file_get', { p_org: orgOf(space), p_id: id }) : S.sampleGet(space, id));
export const updateFile = (space, id, patch) => write(space, 'file.update', { id, ...patch });
export const trashFiles = (space, ids) => write(space, 'file.trash', { ids });
export const restoreFiles = (space, ids) => write(space, 'file.restore', { ids });
export const createFolder = (space, name, parent = null) => write(space, 'folder.create', { id: crypto.randomUUID(), name, parent_id: parent });
export const renameFolder = (space, id, name) => write(space, 'folder.rename', { id, name });
export const moveFolder = (space, id, parent) => write(space, 'folder.move', { id, parent_id: parent });
export const deleteFolder = (space, id) => write(space, 'folder.delete', { id });
export const addLink = (space, link) => write(space, 'link.create', { id: crypto.randomUUID(), source: 'drive', ...link });

/** 영구 삭제 — DB가 기록을 지우며 객체를 지우기로 정하고(한 트랜잭션), 그 키만 서버가 R2에서 지운다(실패해도 정리 크론이 지운다) */
export async function purgeFiles(space, files) {
  const out = await write(space, 'file.purge', { ids: files.map((f) => f.id) });
  if (configured && out?.keys?.length) await (await r2()).flushKeys(out.keys);
  return out;
}
/** 예시 모드 휴지통 30일 정리 — 기기당 하루 한 번(문서함을 열 때). 로그인 모드는 서버 크론이 한다(화면이 R2를 지우지 않는다) */
export async function purgeExpired(space) {
  if (configured) return 0;
  const key = `argo-office-files:purged:${ME.id}:${space}`;
  let last = null; try { last = localStorage.getItem(key); } catch { /* 저장소 없음 */ }
  if (!purgeDue(last)) return 0;
  try { localStorage.setItem(key, String(Date.now())); } catch { /* 저장소 없음 */ }
  const ex = await S.sampleExpired(space);
  if (!ex.files?.length) return 0;
  await purgeFiles(space, ex.files.map((f) => ({ id: f.id, kind: 'file', storage_path: f.path })));
  return ex.files.length;
}

/* ── 파일 내용 ── */
export async function fileBlob(space, f) {
  if (!configured) return S.sampleBlobGet(f);
  try { return await (await r2()).objectBlob(f.storage_path); }
  catch (e) { throw Object.assign(new Error('files.err.request'), { code: e?.code ?? 'storage' }); }
}
/** 받기 — 데스크톱은 저장 창, 웹은 내려받기 */
export async function downloadFile(space, f) {
  const blob = await fileBlob(space, f);
  if (!blob) throw new Error('files.err.missing');
  const name = f.filename || f.title;
  if (isDesktop()) return saveAttachment(blob, name);
  const url = URL.createObjectURL(blob), a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/* ── 거래처 목록(필터·연결용) ── */
let customers = new Map();
export async function loadCustomers(space) {
  if (!customers.has(space)) customers.set(space, (configured
    ? rpc('office_business_read', { p_org: orgOf(space) }).then((d) => (d?.customers ?? []).map((c) => ({ id: c.id, name: c.name, biz_no: c.biz_no ?? '', status: c.status ?? 'active' })))
    : Promise.resolve(S.sampleCustomers(space))).catch((e) => { customers.delete(space); throw e; })); // 예시: 업무 예시 원장 하나(LOW 5)
  return customers.get(space);
}

/* ── 글자 읽기 ── */
let ocrConfig = null;
async function authHeader() {
  const sb = await getClient();
  const jwt = (await sb?.auth.getSession())?.data.session?.access_token;
  return jwt ? { authorization: `Bearer ${jwt}` } : {};
}
/** 서버 OCR(PaddleOCR 사이드카)이 설정됐나 — 화면 메모리에 한 번 */
export const serverOcr = () => (ocrConfig ??= (configured ? fetch(apiUrl('/api/files/config')).then((r) => r.json()).then((c) => !!c.ocr).catch(() => false) : Promise.resolve(false)));

/** 파일 글자 읽기 → { status, text } — 문서(docx 등)는 브라우저에서 바로, PDF·그림은 서버 OCR(있으면) → 브라우저 OCR */
export async function readFileText(space, f, blob = null) {
  const kind = kindOf(f.filename || f.title, f.mime);
  if (kind === 'doc') {
    const { extractDocText } = await import('./extract.js');
    return extractDocText(blob ?? await fileBlob(space, f), f.filename || f.title);
  }
  if (!ocrable(f)) return { status: 'unsupported', text: '' };
  if (configured && await serverOcr()) {
    try {
      const r = await fetch(apiUrl('/api/files/ocr'), { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ org: orgOf(space), id: f.id }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) return { status: d.status, text: d.text ?? '', saved: true };
      if (r.status < 500 && r.status !== 429) return { status: 'failed', text: '' }; // 입력·권한 문제는 실패로. 설정 없음(503)·시간당 한도(429)·서버 시간 초과(5xx)는 브라우저에서 읽는다
    } catch { /* 서버에 닿지 않으면 브라우저에서 */ }
  }
  const { readTextInBrowser } = await import('../core/ocr-browser.js');
  return readTextInBrowser(blob ?? await fileBlob(space, f), f.filename || f.title, f.mime);
}
/** 글자 읽기 + 저장 + (자동으로 정한 분류·거래처를 글자로 더 맞추기) — 올린 뒤 뒤에서, 'OCR 다시'에서 */
export async function ocrFile(space, f, { blob = null, auto = false } = {}) {
  await write(space, 'file.ocr', { id: f.id, ocr_status: 'pending' }).catch(() => {});
  const r = await readFileText(space, f, blob);
  const { summary, full_text } = clip(r.text);
  if (!r.saved) await write(space, 'file.ocr', { id: f.id, ocr_status: r.status, summary, full_text }, { refresh: false });
  if (auto && r.status === 'done' && r.text) {
    const patch = {};
    if ((f.category ?? 'general') === 'general') { const c = classify({ name: f.filename || f.title, text: r.text, mime: f.mime }); if (c !== 'general') patch.category = c; }
    if (!f.customer_id) { const c = findCustomer({ name: f.title, text: r.text }, await loadCustomers(space).catch(() => [])); if (c) patch.customer_id = c.id; }
    if (Object.keys(patch).length) await write(space, 'file.update', { id: f.id, ...patch }, { refresh: false });
  }
  await refreshFiles();
  return r;
}

/* ── 올리기 ── */
/** 한 파일: 검사 → 자동 분류(이름) → 거래처 찾기(이름) → 자리(키는 서버가 정함) → R2에 올리기·확인 → 등록 → (뒤에서) 글자 읽기.
 *  등록이 실패하면 객체는 등록 전(uploaded)으로 남고 정리 크론이 1시간 뒤 지운다(화면은 R2를 지울 수 없다) */
export async function uploadOne(space, file, { folderId = null, customerId = null, category = null, source = 'upload', title, summary, tags = [], dealId = null, ocr = true, refDoc = null, refEsign = null } = {}) {
  const bad = uploadCheck(file);
  if (bad) return { ok: false, reason: bad };
  const id = crypto.randomUUID(), name = file.name;
  const org = orgKey(space);
  let path = storagePath(segOf(configured ? org : 'sample', ME.id), id, name); // 예시 모드 경로(로그인 모드는 서버가 준 키로 바꾼다)
  const cs = await loadCustomers(space).catch(() => []);
  const cust = customerId ?? findCustomer({ name: title || name, text: summary ?? '' }, cs)?.id ?? null;
  const cat = category ?? classify({ name: title || name, text: summary ?? '', mime: file.type });
  const text = summary ? clip(summary) : null;
  const row = { id, title: (title || name).slice(0, 300), filename: name.slice(0, 300), mime: (file.type || '').slice(0, 200), size: file.size, storage_path: path,
    category: cat, customer_id: cust, folder_id: folderId, source, tags, deal_id: dealId, ...(refDoc ? { ref_doc: refDoc } : {}), ...(refEsign ? { ref_esign: refEsign } : {}),
    ...(text ? { ocr_status: 'done', ...text } : {}) };
  if (configured) {
    // 올리기 자리 먼저(용량 — 분리 검수 MEDIUM 1). 서버는 이 자리의 키·크기·형식으로만 서명한다
    try { path = (await write(space, 'file.reserve', { id, filename: name, size: file.size, mime: file.type || '' }, { refresh: false })).key; } catch (e) { return { ok: false, reason: why(e) }; }
    row.storage_path = path;
    try { await (await r2()).putObject(path, file); } catch (e) { return { ok: false, reason: ERR[e?.code] ?? 'storage' }; }
  } else await S.sampleBlobPut(id, file);
  try { await write(space, 'file.create', row, { refresh: false }); }
  catch (e) { return { ok: false, reason: why(e) }; }
  const f = { ...row, kind: 'file' };
  if (ocr && !text && (ocrable(f) || kindOf(name, file.type) === 'doc')) queueOcr(space, f, file);
  return { ok: true, file: f };
}
/** 여러 파일 순차 올리기 — onProgress(done, total). 결과는 파일마다 true 또는 실패 이유 */
export async function uploadMany(space, files, opts = {}, onProgress = () => {}) {
  const list = [...files], out = [];
  for (let i = 0; i < list.length; i++) {
    onProgress(i, list.length);
    const r = await uploadOne(space, list[i], opts).catch(() => ({ ok: false, reason: 'request' }));
    out.push(r.ok ? true : r.reason);
  }
  onProgress(list.length, list.length);
  await refreshFiles();
  return out;
}
/** 글자 읽기 줄(한 번에 하나 — 브라우저 OCR이 동시에 여러 개 돌면 화면이 멈춘다) */
let chain = Promise.resolve();
const pending = new Set();
export const ocrPending = (id) => pending.has(id);
function queueOcr(space, f, blob) {
  pending.add(f.id);
  chain = chain.then(() => ocrFile(space, f, { blob, auto: true })).catch((e) => console.warn('[office] ocr', e?.message)).finally(() => { pending.delete(f.id); emit(); });
}

/* ── 다른 화면이 문서함에 넣기(견적·계약·서명본 — 트랙 A, src/core/doc-store.js가 부른다) ── */
export async function saveGenerated(space, { file, filename, title, category = 'general', customerId = null, customerName = null, dealId = null, tags = [], summary = '', refDoc = null, refEsign = null }) {
  const cs = await loadCustomers(space).catch(() => []);
  const cust = customerId ?? matchCustomer(customerName, cs)?.id ?? null;
  const named = file instanceof File && file.name === filename ? file : new File([file], filename, { type: file.type || 'application/pdf' });
  const source = refEsign ? 'esign' : refDoc ? 'generated' : 'upload'; // 예시 모드 표시용 — 로그인 모드에서는 서버가 ref로 다시 정한다
  const r = await uploadOne(space, named, { title, category, customerId: cust, source, tags, summary: summary || title, dealId, ocr: false, refDoc, refEsign });
  if (!r.ok) throw Object.assign(new Error(`files.err.${r.reason}`), { code: r.reason });
  await refreshFiles();
  return { id: r.file.id, title: r.file.title, category: r.file.category, customer_id: r.file.customer_id };
}
