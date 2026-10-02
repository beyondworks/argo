// 구글 드라이브 ↔ 오피스(순수 함수). 가져오기·보내기 동작은 api/drive/[op].js, 규칙은 test/files-server.test.mjs.
// 인트라넷 lib/integrations/drive.ts와 같은 보기(홈=최근·내 드라이브·공유 문서함·공유 드라이브·중요 문서함)와 같은 검색(이름 포함, 따옴표 이스케이프).

export const READ_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** 쓰기는 이 앱이 만든 파일·폴더만(drive.file) — 드라이브 전체 쓰기(drive)보다 좁다. 보내기·새 폴더를 처음 쓸 때만 더 받는다 */
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const scopesFor = (write) => [READ_SCOPE, ...(write ? [WRITE_SCOPE] : [])];
export const hasScope = (granted, s) => String(granted ?? '').split(/\s+/).includes(s);

export const VIEWS = ['home', 'mydrive', 'shared', 'drives', 'starred'];
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FIELDS = 'nextPageToken,files(id,name,mimeType,iconLink,webViewLink,modifiedTime,size,owners(displayName),shortcutDetails)';
const ALL = { corpora: 'allDrives', includeItemsFromAllDrives: 'true', supportsAllDrives: 'true' };
const ID = /^[A-Za-z0-9_-]{1,200}$/;
export const validId = (id) => typeof id === 'string' && ID.test(id);
/** 드라이브 쿼리 문자열 안의 값 — 역슬래시·작은따옴표 이스케이프(인트라넷 drive.ts:177-178) */
export const quoteQ = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** 목록 요청 → { path, params } — 우선순위 q > folder > view (인트라넷 api/drive/files/route.ts와 같다) */
export function listRequest({ view = 'mydrive', folder = '', q = '', page = '' } = {}) {
  const base = { pageSize: '100', fields: FIELDS, ...(page ? { pageToken: page } : {}) };
  const s = String(q ?? '').trim().slice(0, 200);
  if (s) return { path: '/files', params: { ...base, pageSize: '50', q: `name contains ${quoteQ(s)} and trashed = false`, orderBy: 'modifiedTime desc', corpora: 'user' } };
  if (folder && folder !== 'root') {
    if (!validId(folder)) throw Object.assign(new Error('input'), { status: 400, code: 'input' });
    return { path: '/files', params: { ...base, q: `${quoteQ(folder)} in parents and trashed = false`, orderBy: 'folder,name', ...ALL } };
  }
  switch (VIEWS.includes(view) ? view : 'mydrive') {
    case 'home': return { path: '/files', params: { ...base, pageSize: '50', q: `trashed = false and mimeType != '${FOLDER_MIME}'`, orderBy: 'viewedByMeTime desc', ...ALL } };
    case 'shared': return { path: '/files', params: { ...base, q: 'sharedWithMe = true and trashed = false', orderBy: 'modifiedTime desc' } };
    case 'starred': return { path: '/files', params: { ...base, q: 'starred = true and trashed = false', orderBy: 'folder,name', ...ALL } };
    case 'drives': return { path: '/drives', params: { pageSize: '100', fields: 'nextPageToken,drives(id,name)', ...(page ? { pageToken: page } : {}) } };
    default: return { path: '/files', params: { ...base, q: "'root' in parents and trashed = false", orderBy: 'folder,name', ...ALL } };
  }
}

/** 구글 파일 → 화면 줄. 바로가기는 가리키는 대상으로 */
export function mapFile(f) {
  const target = f.shortcutDetails?.targetId ? { id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType } : null;
  const mimeType = target?.mimeType ?? f.mimeType ?? 'application/octet-stream';
  return {
    id: target?.id ?? f.id ?? '', name: f.name ?? '', mimeType, iconLink: f.iconLink ?? null, webViewLink: f.webViewLink ?? null,
    modifiedTime: f.modifiedTime ?? null, size: f.size ? Number(f.size) : null, owners: f.owners?.[0]?.displayName ?? null, isFolder: mimeType === FOLDER_MIME,
  };
}
/** 공유 드라이브 → 폴더처럼(눌러서 안으로) */
export const mapDrive = (d) => ({ id: d.id, name: d.name ?? '', mimeType: FOLDER_MIME, iconLink: null, webViewLink: `https://drive.google.com/drive/folders/${d.id}`, modifiedTime: null, size: null, owners: null, isFolder: true });

/** 구글 문서류는 파일이 아니라서 내보내기 형식으로 받는다 — 문서·프레젠테이션 PDF, 시트 xlsx, 그림 png. 그 밖의 구글 형식(양식·지도)은 링크로만 */
const EXPORT = {
  'application/vnd.google-apps.document': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.presentation': ['application/pdf', '.pdf'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  'application/vnd.google-apps.drawing': ['image/png', '.png'],
};
export function exportFormat(mime) {
  const e = EXPORT[mime];
  return e ? { mime: e[0], ext: e[1] } : null;
}
export const isGoogleNative = (mime) => String(mime ?? '').startsWith('application/vnd.google-apps.');
/** 가져올 수 있나 — 폴더·바로가기 대상 없음·내보낼 수 없는 구글 형식은 링크만 */
export const importable = (f) => !f.isFolder && (!isGoogleNative(f.mimeType) || !!exportFormat(f.mimeType));
/** 내보낸 파일 이름 — 확장자가 없으면 붙인다 */
export const exportName = (name, ext) => (name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`);

/** 여러 부분 업로드 본문(메타데이터 JSON + 파일) — files.create uploadType=multipart */
export function multipartBody(meta, bytes, mime, boundary = `argo${Date.now().toString(36)}`) {
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`);
  return { body: Buffer.concat([head, Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--`)]), type: `multipart/related; boundary=${boundary}` };
}
