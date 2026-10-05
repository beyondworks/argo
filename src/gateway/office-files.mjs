// 에이전트 문서함·드라이브 도구(office_files) — 분리 검수 MEDIUM 4(PARITY-B V14·O2·C9). 인트라넷 에이전트 도구
// docs_list·docs_read·docs_upload·customers_attach·drive_list·drive_mkdir·drive_upload를 아르고 오피스로 옮긴 것("에이전트도 오피스로 쓴다").
// 규칙은 회사 도구(office-company.mjs)와 같다: 다루는 범위는 지금 메신저 조직 채널의 그 조직뿐, 주인의 기기 세션으로만(사람 권한 그대로 — 서버 RLS·함수가 판정),
// 손님 턴은 chat.mjs 처리기가 먼저 거절, 손님·조직 밖 사람이 있을 수 있는 방에서는 다루지 않는다. 통장사본 글자는 주인과의 1:1에서만(office-audience.mjs).
// 문서함: RPC office_file_list(검색) · office_file_get(전문) · office_file_write(자리 → R2 → 등록, 출처 agent). 파일 바이트는 R2(argo-office) —
// 오피스 서버 함수 api/storage가 DB가 허락한 키로만 서명 주소를 주고(upload-url), 이 기기가 R2에 직접 PUT한 뒤 commit(서버가 크기 확인)한다. R2 접근 키는 이 기기에 두지 않는다.
// 드라이브: 오피스 서버 함수(api/drive list·import·mkdir·export)를 주인 로그인 JWT로 — 구글 토큰은 서버에만 있다. 오피스 주소 ARGO_OFFICE_ORIGIN(https 또는 루프백).
// 부하: 사람이 시킬 때만 부른다(폴링 없음). 붙이기는 파일당 RPC 2 + 오피스 서버 함수 2 + R2 PUT 1.
// 바깥 글(S1): 파일 제목·요약·읽은 글자(남이 보낸 견적서·계약서 OCR), 드라이브 이름은 남이 쓴 글이다 — 목록·읽기 결과는 경계 블록으로 감싼다(office-audience.mjs outsideOf).
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { audienceOf, ONLY_DM, mixedRefusal, outsideOf, OUTSIDE_RULE } from './office-audience.mjs';

export const DEFAULT_ORIGIN = 'https://argo-office.vercel.app'; // 운영 오피스(9/30 운영 반영) — 메일 도구(office-mail.mjs)도 같은 주소를 쓴다
export const filesDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  jwt: async () => (await (await import('../devicesession.mjs')).getFreshDeviceSession())?.access_token ?? null,
  fetch: (...a) => fetch(...a),
  origin: () => process.env.ARGO_OFFICE_ORIGIN || DEFAULT_ORIGIN,
  newId: () => randomUUID(),
  wsRoot: async (wsId) => (await import('../workspace.mjs')).paths(wsId).root,
  workRoots: async (wsId) => (await import('../workroots.mjs')).loadActiveWorkRoots(wsId),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const CATS = ['quote', 'contract', 'bizcert', 'card', 'bankbook', 'evidence', 'archive', 'general'];
const MAX_BYTES = 50 * 1024 * 1024; // 오피스 파일 상한(DB 자리 받기와 같은 값)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIST_CAP = 30, READ_CAP = 20_000;
const MIME = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.hwpx': 'application/hwp+zip', '.zip': 'application/zip' };

/** 오피스 문서함 경로의 파일 이름 — apps/office/src/files/model.js safeName과 같은 규칙 */
export function safeName(name = 'file') {
  const s = String(name).normalize('NFC').replace(/\.{2,}/g, '').replace(/[\\/\u0000-\u001f\u007f]+/g, '_').replace(/^\.+/, '').trim();
  const m = /(\.[A-Za-z0-9]{1,8})$/.exec(s);
  const ext = m ? m[1] : '', base = (m ? s.slice(0, -ext.length) : s).replace(/[^\p{L}\p{N} ._()-]+/gu, '_').slice(0, 100) || 'file';
  return `${base}${ext.toLowerCase()}`;
}
/** 오피스 주소 — https, 또는 같은 기계의 http 루프백만(다른 곳으로 주인 로그인 토큰을 보내지 않게) */
export function officeOrigin(value) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) return u.origin;
  } catch { /* 아래 */ }
  return null;
}

function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
  return data;
}
const ERRORS = {
  file_forbidden: ['권한이 없다(손님은 조직 문서함을 쓰지 못한다)', 'not allowed'], file_input: ['입력이 올바르지 않다(거래처·폴더는 이 조직 것이어야 한다)', 'invalid input (customer/folder must belong to this org)'],
  file_not_found: ['그런 파일이 없다 — files로 다시 확인하라', 'no such file — check with files'], file_quota: ['저장 공간이 가득 찼다(조직 풀) — 사장에게 휴지통 정리를 부탁하라', 'storage is full (org pool) — ask the owner to clean up'],
  file_limit: ['한도에 걸렸다(열린 올리기 50개·파일 2만 개)', 'limit reached'], file_conflict: ['같은 항목이 이미 있다', 'already exists'],
  not_connected: ['주인의 구글 드라이브가 오피스에 연결돼 있지 않다 — 오피스 문서함 › 구글 드라이브에서 연결해 달라고 알려라', 'the owner has not connected Google Drive in Office'],
  expired: ['드라이브 연결이 만료됐다 — 오피스에서 다시 연결해 달라고 알려라', 'the Drive connection expired — reconnect in Office'],
  need_write: ['드라이브 보내기 권한(drive.file)이 아직 없다 — 오피스 문서함 › 구글 드라이브에서 보내기 권한을 한 번 켜 달라고 알려라', 'Drive write permission is not granted yet — enable it once in Office'],
  scopes: ['드라이브 권한이 모자란다 — 다시 연결해 달라고 알려라', 'missing Drive permission — reconnect'], link_only: ['그 드라이브 항목은 링크로만 붙일 수 있다(양식·폴더)', 'that Drive item can only be linked'],
  too_big: ['50MB가 넘는다', 'over 50 MB'], missing: ['드라이브에 그 파일이 없다', 'not found in Drive'], not_configured: ['오피스의 구글 연결이 설정돼 있지 않다', 'Google is not configured in Office'],
  quota: ['저장 공간이 가득 찼다(조직 풀)', 'storage is full'], file_too_big: ['파일 하나 한도를 넘는다(25MB)', 'over the per-file limit (25 MB)'],
};
function errText(code, lang, raw = '') {
  if (ERRORS[code]) return pick(`오피스 거절: ${ERRORS[code][0]}.`, `Office refused: ${ERRORS[code][1]}.`, lang);
  return pick(`오피스 호출 실패: ${String(raw || code || '알 수 없는 오류').slice(0, 200)}. 사장에게 그대로 알려라.`, `Office call failed: ${String(raw || code || 'unknown').slice(0, 200)}. Tell the owner as is.`, lang);
}
const rpcError = (e, lang) => { const msg = String(e?.message ?? e ?? ''); return errText(Object.keys(ERRORS).find((c) => msg.includes(c)), lang, msg); };
const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round((n ?? 0) / 1024))}KB`);

/** 경로가 크루의 책상(이 회사 워크스페이스 또는 지정 작업 폴더) 안이고 금지 구역이 아닌가 — 심링크 탈출 포함(permission-gate와 같은 판정) */
async function deskPath(p, wsId) {
  const { makeInWorkspace, makeInWorkRoots, makeIsForbidden } = await import('../permission-gate.mjs');
  const root = await filesDeps.wsRoot(wsId);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const inside = (await makeInWorkspace(root)(abs)) || (await makeInWorkRoots(await filesDeps.workRoots(wsId).catch(() => []))(abs));
  if (!inside) return null;
  if (await makeIsForbidden(root)(abs)) return null;
  return abs;
}

/** 오피스 파일 저장소 서버 함수(api/storage) — 주인 로그인 JWT로 */
async function storageApi(op, body, origin, jwt) {
  const r = await filesDeps.fetch(`${origin}/api/storage/${op}`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? `HTTP ${r.status}`), { rpc: true });
  return d;
}
/** R2 서명 주소는 https(로컬 시험만 루프백 http) — 다른 곳으로 파일을 보내지 않게 */
const signedTarget = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || (x.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(x.hostname)); } catch { return false; } };

async function officeApi(method, op, body, lang) {
  const origin = officeOrigin(filesDeps.origin());
  if (!origin) return { text: pick('오피스 주소(ARGO_OFFICE_ORIGIN)가 https가 아니라 드라이브를 쓰지 않는다 — 사장에게 알려라.', 'The Office address (ARGO_OFFICE_ORIGIN) is not https, so Drive is not used — tell the owner.', lang) };
  const jwt = await filesDeps.jwt().catch(() => null);
  if (!jwt) return { text: pick('메신저(오피스) 로그인이 없어 드라이브를 쓸 수 없다 — 사장에게 알려라.', 'Not signed in, so Drive is unavailable — tell the owner.', lang) };
  const url = method === 'GET' ? `${origin}/api/drive/${op}?${new URLSearchParams(Object.entries(body).filter(([, v]) => v))}` : `${origin}/api/drive/${op}`;
  const r = await filesDeps.fetch(url, { method, headers: { authorization: `Bearer ${jwt}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(120_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { text: errText(d.error, lang, `HTTP ${r.status}`) };
  return { data: d };
}

export async function filesTool(args, { ctx = null, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  if (ctx?.kind === 'msgr-rules') return pick('메신저 위임 턴에서는 문서함 도구를 쓰지 않는다 — 요청한 동료에게 돌려줘라.', 'The files tool is not available in a delegated messenger turn — hand it back.', lang);
  if (ctx?.kind !== 'msgr' || !ctx.orgId) return pick('문서함·드라이브는 메신저 조직 채널 대화에서만 다룬다(그 조직의 것). 지금 대화에서는 쓸 수 없다고 알려라.', 'Files and Drive are only available in a messenger org channel (that org). Say it is unavailable here.', lang);
  let c;
  try { c = await filesDeps.session(); } catch (e) { return pick(`메신저 세션을 불러오지 못했다: ${String(e?.message ?? e).slice(0, 160)}.`, `Could not load the messenger session: ${String(e?.message ?? e).slice(0, 160)}.`, lang); }
  if (!c?.client || !c.uid) return pick('메신저에 로그인돼 있지 않아 오피스를 다룰 수 없다 — 사장에게 Argo 설정에서 메신저(오피스) 계정에 로그인해 달라고 알려라.', 'Not signed in to the messenger, so Office is unavailable — ask the owner to sign in in Argo settings.', lang);
  if (!ownerId || ownerId !== c.uid || ctx.uid !== c.uid) return pick('이 기기의 메신저 로그인 계정이 이 크루 주인의 계정이 아니라 오피스를 다루지 않는다 — 사장에게 알려라.', 'The messenger account on this device is not this crew\'s owner, so Office is not used — tell the owner.', lang);
  const org = ctx.orgId;
  try {
    const who = await audienceOf(c.client, ctx, c.uid);
    if (who === 'mixed') return mixedRefusal(lang);
    const owner = who === 'owner';
    const quiet = (f) => !owner && f.category === 'bankbook'; // 통장사본 글자(계좌번호)는 1:1에서만
    const ox = outsideOf('files', lang);
    const FILE_TEXT = ['파일 제목·요약·읽은 글자는 사람들이 쓰거나 보낸 글', 'file titles, summaries and extracted text written or sent by people'];
    const DRIVE_TEXT = ['드라이브 이름·링크는 사람들이 쓴 글', 'Drive names and links written by people'];

    if (a.action === 'files') {
      if (a.customer_id && !UUID.test(a.customer_id)) return pick('customer_id는 업무 › 거래처의 id(uuid)다.', 'customer_id must be a customer uuid.', lang);
      const d = unwrap(await c.client.rpc('office_file_list', { p_org: org, p_q: String(a.q ?? '').trim().slice(0, 200) || null, p_trash: false, p_customer: a.customer_id || null }));
      const list = d?.files ?? [];
      if (!list.length) return pick('조건에 맞는 파일이 없다.', 'No files match.', lang);
      return [pick(`문서함 ${list.length}건${d.more ? '(더 있음 — q로 좁혀라)' : ''}(제목 · 분류 · 크기 · 글자 · 거래처 · id):`, `${list.length} files${d.more ? ' (more — narrow with q)' : ''} (title · category · size · text · customer · id):`, lang),
        ox.block(list.slice(0, LIST_CAP).map((f) => `- ${ox.line(f.title)} · ${f.category} · ${f.kind === 'link' ? pick('링크', 'link', lang) : kb(f.size)} · ${f.ocr_status} · ${f.customer_id ? `customer=${f.customer_id}` : '—'} · id=${f.id}`
          + (f.summary && !quiet(f) ? `\n  ${ox.line(String(f.summary).slice(0, 160))}` : '')), FILE_TEXT),
        pick('전문은 file_read에 id를 줘라.', 'Use file_read with the id for the full text.', lang)].join('\n');
    }
    if (a.action === 'file_read') {
      if (!a.id) return pick('file_read에는 id(files가 보여 준 것)가 필요하다.', 'file_read needs an id from files.', lang);
      const f = unwrap(await c.client.rpc('office_file_get', { p_org: org, p_id: a.id }));
      const head = `${pick('파일', 'File', lang)} id=${f.id ?? a.id} · ${f.category} · ${pick('글자', 'text', lang)} ${f.ocr_status}${f.customer_id ? ` · customer=${f.customer_id}` : ''}`;
      const named = [`${pick('제목', 'Title', lang)}: ${ox.line(f.title)}`, ...(f.link_url ? [`${pick('링크', 'Link', lang)}: ${ox.line(f.link_url)}`] : [])];
      if (quiet(f)) return `${head}\n${ox.block(named, FILE_TEXT)}\n${pick(`통장사본 글자(계좌번호)는 ${ONLY_DM(lang)} 보여 준다.`, `Bank-book text (account numbers) is shown ${ONLY_DM(lang)}.`, lang)}`;
      const raw = String(f.full_text || f.summary || ''); // 길이 상한은 JSON으로 감싸기 전 글자 수로
      if (!raw) return `${head}\n${ox.block(named, FILE_TEXT)}\n${pick('읽힌 글자가 없다(오피스에서 글자 읽기를 다시 해 달라고 할 수 있다).', 'No extracted text yet.', lang)}`;
      return `${head}\n${ox.block([...named, '---', ox.text(raw.slice(0, READ_CAP)), ...(raw.length > READ_CAP ? [pick(`…(앞 ${READ_CAP}자만)`, `…(first ${READ_CAP} chars)`, lang)] : [])], FILE_TEXT)}`;
    }
    if (a.action === 'attach') {
      if (!a.path) return pick('attach에는 path(작업 공간 안 파일 경로)가 필요하다.', 'attach needs a path inside the workspace.', lang);
      if (a.customer_id && !UUID.test(a.customer_id)) return pick('customer_id는 업무 › 거래처의 id(uuid)다.', 'customer_id must be a customer uuid.', lang);
      if (a.category && !CATS.includes(a.category)) return pick(`category는 ${CATS.join('|')} 중 하나.`, `category must be one of ${CATS.join('|')}.`, lang);
      const abs = await deskPath(String(a.path), ctx.wsId);
      if (!abs) return pick('그 경로는 이 회사 작업 공간(또는 지정 작업 폴더) 밖이라 올리지 않는다.', 'That path is outside the workspace (or work folders), so it is not uploaded.', lang);
      const st = await stat(abs).catch(() => null);
      if (!st?.isFile()) return pick('그 경로에 파일이 없다.', 'No file at that path.', lang);
      if (st.size > MAX_BYTES) return pick('50MB가 넘어 올리지 않는다.', 'Over 50 MB — not uploaded.', lang);
      const origin = officeOrigin(filesDeps.origin());
      if (!origin) return pick('오피스 주소(ARGO_OFFICE_ORIGIN)가 https가 아니라 문서함에 올리지 않는다 — 사장에게 알려라.', 'The Office address (ARGO_OFFICE_ORIGIN) is not https, so nothing is uploaded — tell the owner.', lang);
      const jwt = await filesDeps.jwt().catch(() => null);
      if (!jwt) return pick('메신저(오피스) 로그인이 없어 문서함에 올릴 수 없다 — 사장에게 알려라.', 'Not signed in, so the file box is unavailable — tell the owner.', lang);
      const bytes = await readFile(abs), name = safeName(a.title || basename(abs)), mime = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream';
      const id = filesDeps.newId();
      const { key } = unwrap(await c.client.rpc('office_file_write', { p_org: org, p_action: 'file.reserve', p_data: { id, filename: name, size: bytes.length, mime } })); // 자리(키는 DB가 정함)
      const up = await storageApi('upload-url', { key }, origin, jwt);
      if (!signedTarget(up.url)) return pick('오피스가 준 올리기 주소가 https가 아니라 올리지 않았다 — 사장에게 알려라.', 'The upload address from Office is not https — not uploaded.', lang);
      const put = await filesDeps.fetch(up.url, { method: 'PUT', headers: up.headers, body: bytes, signal: AbortSignal.timeout(120_000) });
      if (!put.ok) return pick(`저장소에 올리지 못했다(HTTP ${put.status}).`, `Upload failed (HTTP ${put.status}).`, lang);
      await storageApi('commit', { key }, origin, jwt); // 서버가 R2 크기를 확인해 기록
      // 등록이 실패하면 객체는 등록 전으로 남고 오피스 정리 크론이 1시간 뒤 지운다(이 기기는 R2를 지울 수 없다)
      unwrap(await c.client.rpc('office_file_write', { p_org: org, p_action: 'file.create', p_data: { id, title: name, filename: name, mime, size: bytes.length, storage_path: key,
        category: a.category ?? 'general', customer_id: a.customer_id || null, source: 'agent', tags: a.customer_id ? [] : ['agent'] } }));
      return pick(`문서함에 붙였다: ${ox.line(name)} · ${a.category ?? 'general'}${a.customer_id ? ` · 거래처 ${a.customer_id}` : ''} (id=${id}). 글자 읽기는 사람이 오피스에서 열 때 한다.`,
        `Attached to Office files: ${ox.line(name)} · ${a.category ?? 'general'}${a.customer_id ? ` · customer ${a.customer_id}` : ''} (id=${id}).`, lang);
    }
    if (a.action === 'drive') {
      const r = await officeApi('GET', 'list', { q: String(a.q ?? '').trim(), folder: a.folder ?? '', view: a.view ?? '' }, lang);
      if (r.text) return r.text;
      const list = r.data?.files ?? [];
      if (!list.length) return pick('드라이브에 맞는 항목이 없다.', 'Nothing matches in Drive.', lang);
      return [pick(`구글 드라이브 ${list.length}건(이름 · 종류 · id):`, `Google Drive, ${list.length} items (name · type · id):`, lang),
        ox.block(list.slice(0, 50).map((f) => `- ${ox.line(f.name)} · ${f.isFolder ? pick('폴더', 'folder', lang) : ox.line(f.mimeType)}${f.size ? ` · ${kb(f.size)}` : ''} · id=${ox.id(f.id)}`), DRIVE_TEXT),
        pick('문서함으로 가져오려면 drive_import에 id를, 폴더 안을 보려면 drive에 folder=id를 줘라.', 'Use drive_import with an id to copy into Office files, or drive with folder=id.', lang)].join('\n');
    }
    if (a.action === 'drive_import') {
      if (!a.drive_id) return pick('drive_import에는 drive_id(drive가 보여 준 id)가 필요하다.', 'drive_import needs drive_id.', lang);
      if (a.customer_id && !UUID.test(a.customer_id)) return pick('customer_id는 업무 › 거래처의 id(uuid)다.', 'customer_id must be a customer uuid.', lang);
      const r = await officeApi('POST', 'import', { org, id: a.drive_id, ...(a.customer_id ? { customerId: a.customer_id } : {}) }, lang);
      if (r.text) return r.text;
      // 드라이브 쪽 이름·링크는 남이 쓴 글 — 쓰기 확인 문장에서도 경계 블록 안에(검수 #fix-cross M2)
      return `${pick(`드라이브에서 문서함으로 가져왔다(id=${ox.id(r.data.id)}) — 파일 이름:`, `Imported from Drive into Office files (id=${ox.id(r.data.id)}) — file name:`, lang)}\n${ox.block([ox.line(r.data.title)], DRIVE_TEXT)}`;
    }
    if (a.action === 'drive_mkdir') {
      const name = String(a.name ?? '').trim();
      if (!name) return pick('drive_mkdir에는 name이 필요하다.', 'drive_mkdir needs a name.', lang);
      const r = await officeApi('POST', 'mkdir', { name, ...(a.folder ? { parent: a.folder } : {}) }, lang);
      if (r.text) return r.text;
      return `${pick('드라이브에 폴더를 만들었다 — 이름 · id · 링크:', 'Created a Drive folder — name · id · link:', lang)}\n${ox.block([`${ox.line(r.data.name)} (id=${ox.id(r.data.id)})${r.data.link ? ` ${ox.line(r.data.link)}` : ''}`], DRIVE_TEXT)}`;
    }
    if (a.action === 'drive_export') {
      if (!a.id) return pick('drive_export에는 id(files가 보여 준 문서함 파일 id)가 필요하다.', 'drive_export needs an Office file id.', lang);
      const r = await officeApi('POST', 'export', { org, id: a.id, ...(a.folder ? { folder: a.folder } : {}) }, lang);
      if (r.text) return r.text;
      return `${pick('드라이브로 보냈다 — 이름 · id · 링크:', 'Sent to Drive — name · id · link:', lang)}\n${ox.block([`${ox.line(r.data.name)} (id=${ox.id(r.data.id)})${r.data.link ? ` ${ox.line(r.data.link)}` : ''}`], DRIVE_TEXT)}`;
    }
    return pick('action은 files·file_read·attach·drive·drive_import·drive_mkdir·drive_export 중 하나다.', 'action must be files, file_read, attach, drive, drive_import, drive_mkdir or drive_export.', lang);
  } catch (e) {
    return rpcError(e, lang);
  }
}

export function filesDescription(lang = 'ko') {
  return lang === 'en'
    ? 'Argo Office files and Google Drive for the org of this messenger channel. action=files searches the file box (q: title, file name, extracted text, tags; customer_id filter) and lists id, category, size, text status; file_read returns one file\'s full extracted text by id; attach uploads a file from the workspace (path) into the file box, optionally to a customer (customer_id) with category quote|contract|bizcert|card|bankbook|evidence|archive|general (e.g. a business card → card). Drive (the owner\'s connected Google Drive): drive lists items (q search, folder id, view home|mydrive|shared|drives|starred), drive_import copies a Drive file into the file box (drive_id, optional customer_id), drive_mkdir creates a folder (name, folder = parent id), drive_export sends a file-box file to Drive (id, folder). Bank-book text is shown only in a 1:1 chat with the owner; nothing is available in rooms with guests. ' + OUTSIDE_RULE('en')
    : '이 메신저 채널 조직의 아르고 오피스 문서함과 구글 드라이브. action=files는 문서함 검색(q: 제목·파일명·읽은 글자·태그, customer_id로 거래처 거르기) — id·분류·크기·글자 상태, file_read는 id로 한 건의 읽은 글자 전문, attach는 작업 공간 파일(path)을 문서함에 올린다 — customer_id를 주면 그 거래처 파일, category quote|contract|bizcert|card|bankbook|evidence|archive|general(명함이면 card). 드라이브(주인이 연결한 구글 드라이브): drive는 목록(q 검색·folder id·view home|mydrive|shared|drives|starred), drive_import는 드라이브 파일을 문서함으로 가져오기(drive_id, customer_id 선택), drive_mkdir는 새 폴더(name, folder = 부모 id), drive_export는 문서함 파일을 드라이브로 보내기(id, folder). 통장사본 글자는 주인과의 1:1 대화에서만, 손님이 있는 방에서는 아무것도 다루지 않는다. ' + OUTSIDE_RULE('ko');
}
