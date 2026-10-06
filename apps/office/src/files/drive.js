// 구글 드라이브(화면 쪽) — 로그인: 서버 함수 api/drive(요청자 JWT), 예시 모드: sample.js의 예시 드라이브.
// 즐겨찾기·시작 화면은 인트라넷과 같이 이 기기에 사람마다 둔다(localStorage). 드라이브 호출은 사람이 열거나 폴더를 바꿀 때만.
import { configured, getClient } from '../core/supabase.js';
import { orgOf } from '../core/tasks.js';
import { ME } from '../core/session.js';
import { apiUrl, isDesktop, openExternal } from '../core/platform.js';
import { classify, kindOf } from './model.js';
import { addLink, refreshFiles, ocrFile } from './api.js';
import * as S from './sample.js';

async function api(op, body, query) {
  const sb = await getClient();
  const jwt = (await sb?.auth.getSession())?.data.session?.access_token;
  const r = await fetch(apiUrl(`/api/drive/${op}${query ? `?${new URLSearchParams(query)}` : ''}`), {
    method: body ? 'POST' : 'GET', headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? 'request'), { code: data.error ?? 'request', status: r.status });
  return data;
}

export async function driveStatus() {
  if (!configured) return { configured: true, connected: true, address: 'sample@argo.example', write: true, sample: true };
  const cfg = await api('config').catch(() => ({ google: null }));
  if (!cfg.google) return { configured: false, connected: false };
  return { configured: true, ...(await api('status')) };
}
/** 연결 시작 — 웹은 구글 동의 화면으로 이동, 데스크톱은 브라우저에서 열고 돌아와 새로고침 */
export async function driveConnect({ write = false } = {}) {
  const { url } = await api('start', { write });
  if (isDesktop()) { await openExternal(url); return 'desktop'; }
  location.assign(url);
  return 'web';
}
export const driveFinish = (code, state) => api('finish', { code, state });
export const driveDisconnect = () => (configured ? api('disconnect', {}) : Promise.resolve({ ok: true }));

export async function driveList({ view, folder, q, page } = {}) {
  if (!configured) return S.sampleDriveList({ view, folder, q });
  return api('list', null, Object.fromEntries(Object.entries({ view, folder, q, page }).filter(([, v]) => v)));
}

/** 가져오기 — 파일마다 서버가 드라이브에서 받아 문서함 Storage에 올리고 등록한다. 가져온 뒤 글자 읽기는 화면이 뒤에서 */
export async function driveImport(space, files, { folderId = null, customerId = null } = {}) {
  const done = [];
  for (const f of files) {
    if (!configured) {
      const s = S.sampleDriveFile(f.id) ?? f;
      const ext = s.mimeType === 'application/vnd.google-apps.spreadsheet' ? '.xlsx' : s.mimeType.startsWith('application/vnd.google-apps.') ? '.pdf' : '';
      const name = ext && !s.name.endsWith(ext) ? `${s.name}${ext}` : s.name;
      const mime = ext === '.pdf' ? 'application/pdf' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : s.mimeType;
      const id = crypto.randomUUID();
      await S.sampleWrite(space, 'file.create', { id, title: name, filename: name, mime, size: s.size ?? 40_000, storage_path: `sample/${id}`, source: 'drive', drive_id: s.id,
        category: classify({ name, mime }), folder_id: folderId, customer_id: customerId, sample: !!s.sampleKind, sampleKind: s.sampleKind });
      done.push({ id, title: name, mime });
      continue;
    }
    done.push(await api('import', { org: orgOf(space) ?? null, id: f.id, folderId, customerId }));
  }
  await refreshFiles();
  for (const d of done) { // 가져온 파일도 올린 파일처럼 뒤에서 글자를 읽어 분류·거래처를 맞춘다(예시 모드는 그려 만든 예시 파일을 브라우저에서 읽는다)
    const f = { id: d.id, kind: 'file', title: d.title, filename: d.title, mime: d.mime, category: classify({ name: d.title, mime: d.mime }), customer_id: customerId };
    if (['pdf', 'image', 'doc'].includes(kindOf(d.title, d.mime))) ocrFile(space, f, { auto: true }).catch(() => {});
  }
  return done;
}
/** 링크로 붙이기 — 내용은 드라이브에 두고 문서함에는 링크만 */
export async function driveLink(space, files, { folderId = null, customerId = null } = {}) {
  for (const f of files) {
    await addLink(space, { title: f.name.slice(0, 300), link_url: f.webViewLink, drive_id: f.id, mime: f.mimeType, category: classify({ name: f.name, mime: f.mimeType }), folder_id: folderId, customer_id: customerId });
  }
  return files.length;
}
/** 드라이브로 보내기(drive.file) — need_write면 화면이 쓰기 권한을 더 받게 한다 */
export async function driveExport(space, fileId, folder = 'root') {
  if (!configured) return { name: 'sample', link: null };
  return api('export', { org: orgOf(space) ?? null, id: fileId, folder });
}
export async function driveMkdir(name, parent = 'root') {
  if (!configured) return { id: `d-new-${Date.now()}`, name };
  return api('mkdir', { name, parent });
}

/* ── 이 기기에 사람마다: 즐겨찾기·시작 화면(인트라넷 drive/page.tsx:60-71) ── */
const favKey = () => `argo-office-drive-fav:${ME.id}`, pinKey = () => `argo-office-drive-start:${ME.id}`;
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } };
const keep = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* 저장소 없음 */ } };
export const readFavs = () => read(favKey(), []);
export const toggleFav = (f) => { const list = readFavs(), on = list.some((x) => x.id === f.id); const next = on ? list.filter((x) => x.id !== f.id) : [...list, { id: f.id, name: f.name, mimeType: f.mimeType, isFolder: f.isFolder, webViewLink: f.webViewLink }].slice(-50); keep(favKey(), next); return next; };
export const readPin = () => read(pinKey(), null);
export const setPin = (v) => keep(pinKey(), v);
