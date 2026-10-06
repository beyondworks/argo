// 화면 쪽 파일 저장소(로그인 모드) — 바이트는 브라우저 ↔ Cloudflare R2가 직접 주고받는다. 서명 주소는 오피스 서버 함수(api/storage)가 DB가 허락한 키만 만든다.
// 올리기: (부르는 쪽이 DB에서 자리·키를 받은 뒤) upload-url → R2에 PUT → commit(서버가 크기 확인). 열기: read-url(여러 키 한 번에) → R2 GET.
// 화면 메모리 캐시 두 가지(DB·서버 호출을 줄이려고): ① 서명 주소 — 만료 1분 전까지 다시 쓴다 ② 파일 내용 — 최근 연 것 합계 50MB까지(오래된 것부터 버린다).
// 만료된 주소로 R2가 거절하면(CORS 헤더 없는 403이라 네트워크 오류로 보인다) 주소를 새로 받아 한 번만 다시 한다. 예시 모드(5400)는 이 파일을 쓰지 않는다.
import { apiUrl } from './platform.js';

const fail = (code) => Object.assign(new Error(code), { code });
const urls = new Map();   // key → { url, until }
const blobs = new Map();  // key → Blob (넣은 순서 = 오래된 순서)
let blobBytes = 0;
const BLOB_CAP = 50 * 1024 * 1024;

/** 바꿔 끼울 수 있는 의존(테스트가 가짜를 넣는다) */
export const r2Deps = {
  fetch: (...a) => fetch(...a),
  async jwt() { const { getClient } = await import('./supabase.js'); return (await (await getClient())?.auth.getSession())?.data.session?.access_token ?? null; },
};
async function authHeader() {
  const jwt = await r2Deps.jwt();
  if (!jwt) throw fail('task_signin');
  return { authorization: `Bearer ${jwt}` };
}
/** 서버 함수 한 번 — 오류는 { code }로(file_missing·file_size_mismatch·r2_not_configured·uploads_paused …) */
export async function storageCall(op, body) {
  const r = await r2Deps.fetch(apiUrl(`/api/storage/${op}`), { method: 'POST', headers: { 'content-type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(d.error ?? 'storage');
  return d;
}

/** 자리를 받은 키로 올리기 — upload-url → PUT(형식·크기·덮어쓰기 금지가 서명돼 있다) → commit */
export async function putObject(key, blob) {
  const up = await storageCall('upload-url', { key });
  let r;
  try { r = await r2Deps.fetch(up.url, { method: 'PUT', headers: up.headers, body: blob }); } catch { throw fail('storage'); }
  if (!r.ok) throw fail(r.status === 412 ? 'file_conflict' : 'storage');
  await storageCall('commit', { key });
}

/** 여러 키의 GET 서명 주소 — 캐시에 없거나 1분 안에 만료되는 것만 서버에 묻는다. 허락되지 않은 키는 결과에 없다 */
export async function readUrls(keys) {
  const now = Date.now(), need = [...new Set(keys)].filter((k) => !(urls.get(k)?.until > now + 60_000));
  for (let i = 0; i < need.length; i += 50) {
    const d = await storageCall('read-url', { keys: need.slice(i, i + 50) });
    const until = Date.now() + (d.expiresIn ?? 600) * 1000;
    for (const [k, url] of Object.entries(d.urls ?? {})) urls.set(k, { url, until });
  }
  return Object.fromEntries(keys.filter((k) => urls.has(k)).map((k) => [k, urls.get(k).url]));
}

function remember(key, blob) {
  if (blob.size > BLOB_CAP) return;
  blobs.set(key, blob); blobBytes += blob.size;
  for (const [k, b] of blobs) { if (blobBytes <= BLOB_CAP) break; blobs.delete(k); blobBytes -= b.size; }
}
/** 파일 내용(Blob) — 같은 세션에서 다시 열면 서버·R2를 부르지 않는다 */
export async function objectBlob(key) {
  const hit = blobs.get(key);
  if (hit) { blobs.delete(key); blobs.set(key, hit); return hit; } // 최근 것으로
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = (await readUrls([key]))[key];
    if (!url) throw fail('file_missing');
    const r = await r2Deps.fetch(url).catch(() => null);
    if (r?.ok) { const b = await r.blob(); remember(key, b); return b; }
    urls.delete(key); // 만료·네트워크 — 주소를 새로 받아 한 번 더
  }
  throw fail('storage');
}

/** 지우기로 정한 키(DB가 deleting으로 바꾼 것)를 R2에서 지워 달라고 — 실패해도 정리 크론이 지운다 */
export async function flushKeys(keys) {
  const list = (keys ?? []).filter(Boolean);
  for (const k of list) { urls.delete(k); const b = blobs.get(k); if (b) { blobs.delete(k); blobBytes -= b.size; } }
  for (let i = 0; i < list.length; i += 50) await storageCall('flush', { keys: list.slice(i, i + 50) }).catch(() => {});
}
