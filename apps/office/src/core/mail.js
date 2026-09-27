// 메일(내 공간) — 연결한 계정(Gmail·Google Workspace)의 메일을 서버 함수(api/mail)로 읽고 보낸다. 본문은 DB에 두지 않는다.
// 목록은 이 기기에 캐시해 바로 그리고(가게 상태), 읽음·보관은 보낼 목록(transport 'mail.flag')으로 뒤에서 반영한다.
import { getClient } from './supabase.js';
import { getMode } from './session.js';
import { update, getState } from './store.js';
import { outbox } from './sync.js';
import { VIEWABLE } from './viewable.js';

const CAP = 3 * 1024 * 1024; // ponytail: 서버 함수 요청 한도(4.5MB, base64 4/3배) 안 — 큰 첨부는 브라우저 → Gmail 직접 올리기로 넓힌다
export const ATTACH_CAP = CAP;

export async function api(op, body, { method = body ? 'POST' : 'GET', query } = {}) {
  const sb = await getClient();
  const jwt = (await sb?.auth.getSession())?.data.session?.access_token;
  const r = await fetch(`/api/mail/${op}${query ? `?${new URLSearchParams(query)}` : ''}`, {
    method, headers: { ...(jwt ? { authorization: `Bearer ${jwt}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  if (op === 'attachment' && r.ok) return r.blob();
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? 'mail'), { code: data.error ?? 'server', status: r.status, transient: r.status >= 500 && r.status !== 503 });
  return data;
}

let config = null;
export const mailConfig = () => (config ??= api('config').catch(() => { config = null; return { google: null }; }));

/** 연결한 계정 목록 — 없어진 계정의 캐시 메일은 치운다(예시 메일 포함) */
export async function loadAccounts() {
  if (getMode() !== 'signedIn') return;
  const sb = await getClient();
  const { data, error } = await sb.from('office_mail_accounts').select('id, provider, address, display_name, hosted_domain, status').order('created_at');
  if (error) throw error;
  const ids = new Set(data.map((a) => a.id));
  update((s) => ({ mailAccounts: data, mails: s.mails.filter((m) => ids.has(m.account)) }));
}

/** 폴더 목록을 계정마다 가져와 합친다 — 아직 안 보낸 읽음·보관이 있는 메일은 이 기기 값을 지킨다 */
export async function pullMail(folder) {
  const accounts = (getState().mailAccounts ?? []).filter((a) => a.status === 'ok');
  if (getMode() !== 'signedIn' || !accounts.length) return;
  const busy = (id) => outbox.has(`mail:${id}`);
  const results = await Promise.allSettled(accounts.map((a) => api('list', null, { query: { account: a.id, folder } })));
  const got = [], done = new Set();
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') { done.add(accounts[i].id); got.push(...r.value.items); }
    else if (r.reason?.code === 'expired') update((s) => ({ mailAccounts: s.mailAccounts.map((a) => (a.id === accounts[i].id ? { ...a, status: 'expired' } : a)) }));
  });
  update((s) => {
    const local = new Map(s.mails.map((m) => [m.id, m]));
    const fresh = got.map((m) => (busy(m.id) && local.has(m.id) ? { ...m, unread: local.get(m.id).unread, folder: local.get(m.id).folder } : m));
    const ids = new Set(fresh.map((m) => m.id));
    // 이번에 받은 계정·폴더의 옛 캐시는 새 목록으로 바꾸고, 다른 폴더·못 받은 계정·보내는 중인 메일은 그대로
    const keep = s.mails.filter((m) => !ids.has(m.id) && !(done.has(m.account) && m.folder === folder && !busy(m.id)));
    return { mails: [...keep, ...fresh] };
  });
  return results.map((r, i) => (r.status === 'rejected' ? { account: accounts[i], code: r.reason?.code } : null)).filter(Boolean);
}

const bodies = new Map(); // 본문은 이 탭에서만(저장하지 않는다)
export async function readMail(m) {
  if (!bodies.has(m.id)) bodies.set(m.id, api('read', null, { query: { account: m.account, id: m.gid } }).catch((e) => { bodies.delete(m.id); throw e; }));
  return bodies.get(m.id);
}

/** Google 로그인 → 권한 승인 화면으로 보낸다(돌아오는 곳: /me/mail/connect) */
export async function connectGoogle(hint) {
  const { url } = await api('start', { hint });
  location.assign(url);
}
export const finishConnect = (code, state) => api('finish', { code, state });
export async function disconnectAccount(id) {
  await api('disconnect', { account: id });
  await loadAccounts();
}

export const saveDraft = (msg) => api('draft', msg);
export const sendMail = (msg) => api('send', msg);

/** 파일 → { name, type, data(base64) } */
export const fileToPart = (f) => new Promise((ok, no) => {
  const r = new FileReader();
  r.onload = () => ok({ name: f.name, type: f.type, data: String(r.result).split(',')[1] ?? '' });
  r.onerror = () => no(r.error);
  r.readAsDataURL(f);
});

/** 첨부 열기 — PDF·그림·글·영상은 새 탭에서 바로, 나머지는 내려받기. 탭은 누른 순간에 연다(받은 뒤 열면 팝업 차단에 걸린다) */
export async function openAttachment(m, a) {
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
