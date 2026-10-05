// 문서함 공유 링크(15차, 유건 결정 5 — 메일 큰 첨부) — 만들기·끊기·목록(로그인)과 공개 화면(/f#<토큰>)의 열기·내려받기(로그인 없음).
// 토큰은 이 기기에서 만들고(32바이트 무작위) 서버·DB에는 SHA-256만 보낸다 — 링크 주소는 만든 사람 화면에만 한 번 나타난다(다시 복사할 수 없다, 새로 만든다).
// 로그인: office_file_link_write·office_file_link_list(사람 권한) / 공개: api/files link·link-get(서버가 토큰을 확인하고 5분짜리 서명 주소).
// 예시 모드: 이 브라우저 IndexedDB(sample.js) — 같은 브라우저에서 링크를 열면 같은 흐름이 보인다.
// 부하: 만들기·끊기는 누를 때 1회, 목록은 파일 상세를 열 때 1회. 폴링 없음.
import { configured } from '../core/supabase.js';
import { apiUrl, publicWebUrl, isDesktop, saveAttachment } from '../core/platform.js';
import { LINK_DAYS, linkTokenOk, newLinkToken, sha256Hex, linkPath } from './link-model.js';
export { LINK_DAYS, linkTokenOk, linkDaysLeft } from './link-model.js';
export const linkUrl = (token) => publicWebUrl(linkPath(token)); // /f#<토큰> — 토큰은 서버로 가지 않는 조각에

const tasks = () => import('../core/tasks.js'); // 로그인 RPC(세션 확인 포함) — 공개 화면 묶음에는 싣지 않는다
const sample = () => import('./sample.js');
async function write(space, action, data) {
  if (!configured) return (await sample()).sampleLinkWrite(space, action, data);
  const { rpc, orgOf } = await tasks();
  return rpc('office_file_link_write', { p_org: orgOf(space), p_action: action, p_data: data });
}

/** 링크 만들기 → { id, url(이번 한 번만), expiresAt } */
export async function createLink(space, file, { days = LINK_DAYS, source = 'manual' } = {}) {
  const token = newLinkToken(), id = crypto.randomUUID();
  const out = await write(space, 'link.create', { id, file_id: file.id, token_hash: await sha256Hex(token), days, source });
  return { id, url: linkUrl(token), expiresAt: out?.expires_at ?? null };
}
export const revokeLink = (space, id) => write(space, 'link.revoke', { id });
/** 파일의 살아 있는 링크 — { can, links: [{ id, source, created_at, expires_at, mine }] } */
export async function listLinks(space, fileId) {
  if (!configured) return (await sample()).sampleLinkList(space, fileId);
  const { rpc, orgOf } = await tasks();
  return rpc('office_file_link_list', { p_org: orgOf(space), p_file: fileId });
}

/* ── 공개 화면(로그인 없음) ── */
const gone = () => Object.assign(new Error('gone'), { code: 'gone' });
async function publicCall(op, token) {
  const r = await fetch(apiUrl(`/api/files/${op}`), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }); // 토큰은 본문으로만(접근 기록에 남지 않게)
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error ?? 'request'), { code: d.error ?? 'request', status: r.status });
  return d;
}
/** 링크 정보 — { name, size, mime, expiresAt, org } | 열 수 없으면 code 'gone' */
export async function openLink(token) {
  if (!linkTokenOk(token)) throw gone();
  if (!configured) { // 예시: 공간 이름은 여기서 붙인다(sample.js는 node 시험에서도 읽혀 session을 들이지 않는다)
    const r = await (await sample()).sampleLinkOpen(await sha256Hex(token));
    const { SPACES } = await import('../core/session.js');
    return { ...r, org: SPACES.find((s) => s.key === r.space && s.kind === 'org')?.name ?? null };
  }
  return publicCall('link', token);
}
/** 내려받기 — 누를 때마다 서버가 토큰을 다시 확인하고 5분짜리 서명 주소를 준다 */
export async function downloadLink(token) {
  if (!linkTokenOk(token)) throw gone();
  if (!configured) {
    const { blob, name } = await (await sample()).sampleLinkBlob(await sha256Hex(token));
    if (isDesktop()) return saveAttachment(blob, name);
    const url = URL.createObjectURL(blob), a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return;
  }
  const { url } = await publicCall('link-get', token);
  const a = Object.assign(document.createElement('a'), { href: url, rel: 'noopener noreferrer' }); // 서명 주소가 내려받기(attachment)라 이 화면은 그대로 남는다
  document.body.appendChild(a); a.click(); a.remove();
}
