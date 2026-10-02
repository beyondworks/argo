// 로그인 모드의 문서·전자서명 저장소 — Supabase RPC(office_docs_read/write, 조직 권한은 서버가 확인)와 Storage 버킷 office-docs(비공개).
// 경로: <o-조직|u-사람>/docs/<문서>.pdf · <…>/esign/<서명>/orig.pdf·final.pdf·s-<서명자>-<n>.png. 버킷 정책이 첫 칸으로 조직 권한을 본다.
// 서명 링크 토큰은 여기서 만들고 해시만 서버로 보낸다(원문은 메일에만). 공개 서명은 서버 함수(api/esign)가 맡는다.
import { getClient } from '../core/supabase.js';
import { SPACES, ME } from '../core/session.js';
import { apiUrl, publicWebUrl, isDesktop } from '../core/platform.js';
import { newToken, sha256Hex, expiresAt, signLink, TOKEN_DAYS } from './esign-model.js';

const BUCKET = 'office-docs';
const fail = (code, extra) => Object.assign(new Error(code), { code, ...extra });
const orgOf = (space) => (space === 'me' ? null : SPACES.find((s) => s.key === space && s.kind === 'org')?.id ?? null);
const seg = (space) => { const o = orgOf(space); return o ? `o-${o}` : `u-${ME.id}`; };
const uid = () => globalThis.crypto.randomUUID();
const origin = () => (isDesktop() ? publicWebUrl('/') : location.origin);

function mapError(error) {
  const m = /^docs_([a-z_]+)/.exec(error?.message ?? '');
  if (m) return fail(m[1]);
  if (/^file_quota/.test(error?.message ?? '')) return fail('quota'); // 범위 저장 공간(문서함·문서 합) 가득 — 분리 검수 MEDIUM 1
  if (/^file_(limit|conflict)/.test(error?.message ?? '')) return fail('upload', { cause: error });
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(error?.code)) return fail('schema');
  if (['42501', 'PGRST301'].includes(String(error?.code))) return fail('permission');
  return fail('request', { cause: error });
}
async function sb() { const c = await getClient(); if (!c) throw fail('signIn'); return c; }
async function rpc(fn, args) { const { data, error } = await (await sb()).rpc(fn, args); if (error) throw mapError(error); return data; }
const write = (space, action, data) => rpc('office_docs_write', { p_org: orgOf(space), p_action: action, p_data: data });
async function upload(path, bytes, type = 'application/pdf') {
  const { error } = await (await sb()).storage.from(BUCKET).upload(path, new Blob([bytes], { type }), { contentType: type, upsert: false });
  if (error) throw fail('upload', { cause: error });
}
async function download(path) {
  const { data, error } = await (await sb()).storage.from(BUCKET).download(path);
  if (error) throw fail('missing_file', { cause: error });
  return new Uint8Array(await data.arrayBuffer());
}
async function remove(paths) { const list = paths.filter(Boolean); if (list.length) await (await sb()).storage.from(BUCKET).remove(list).catch(() => {}); }

async function api(op, body, jwt) {
  const r = await fetch(apiUrl(`/api/esign/${op}`), { method: 'POST', headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) }, body: JSON.stringify(body) }); // 토큰은 본문으로(주소·접근 기록에 남지 않게)
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(data.error ?? 'request');
  return data;
}
const bytesOf = async (url) => { const r = await fetch(url); if (!r.ok) throw fail('missing_file'); return new Uint8Array(await r.arrayBuffer()); };

export default {
  mode: 'live',
  load: (space) => rpc('office_docs_read', { p_org: orgOf(space) }), // 목록 — 입력값·칸 배치는 빠져 있다
  getDoc: (space, id) => rpc('office_docs_get', { p_org: orgOf(space), p_kind: 'doc', p_id: id }),
  getEsign: (space, id) => rpc('office_docs_get', { p_org: orgOf(space), p_kind: 'esign', p_id: id }),
  async saveDoc(space, d) {
    const id = d.id ?? uid();
    const path = `${seg(space)}/docs/${id}.pdf`;
    if (d.pdf) { await write(space, 'doc.reserve', { id, size: d.pdf.byteLength }); await upload(path, d.pdf); } // 자리(용량·정책) → 올리기
    try {
      return await write(space, 'doc.save', { id, kind: d.kind, title: d.title, customer_name: d.customer_name ?? '', customer_id: d.customer_id || null, order_id: d.order_id || null,
        input: d.input ?? {}, ...(d.pdf ? { pdf_path: path, pdf_size: d.pdf.byteLength, pdf_hash: d.pdf_hash ?? '' } : {}), filename: d.filename ?? '', supply: d.supply ?? 0, vat: d.vat ?? 0, total: d.total ?? 0 });
    } catch (e) { if (d.pdf && !d.id) await remove([path]); throw e; } // 기록이 안 남으면 올린 파일도 치운다(쌓이는 부산물 방지)
  },
  docPdf: (space, doc) => download(doc.pdf_path),
  async deleteDoc(space, id) { const r = await write(space, 'doc.delete', { id }); await remove(r?.paths ?? []); },

  async createEsign(space, { id = uid(), title, docId = null, orderId = null, pdf, docHash, fields = [], signers = [], pages = null }) {
    const orig = `${seg(space)}/esign/${id}/orig.pdf`;
    await write(space, 'esign.reserve', { id, size: pdf.byteLength }); // 자리(용량·정책) → 올리기
    await upload(orig, pdf);
    try { return await write(space, 'esign.create', { id, title, doc_id: docId, order_id: orderId, orig_path: orig, doc_hash: docHash, fields, signers, pages }); }
    catch (e) { await remove([orig]); throw e; }
  },
  updateEsign: (space, id, patch) => write(space, 'esign.update', { id, ...patch }),
  async sendEsign(space, id, { signers, fields, account }) {
    const tokens = await Promise.all(signers.map(async () => { const token = newToken(); return { token, hash: await sha256Hex(token) }; }));
    const esign = await write(space, 'esign.send', { id, fields, mail_account: account || null, expires_at: expiresAt(Date.now(), TOKEN_DAYS), signers: signers.map((s, i) => ({ name: s.name, email: s.email, token_hash: tokens[i].hash })) });
    return { esign, links: signers.map((s, ord) => ({ ord, name: s.name, email: s.email, link: signLink(origin(), tokens[ord].token) })) };
  },
  async resend(space, id, signerId) {
    const token = newToken();
    const s = await write(space, 'esign.resend', { id, signer_id: signerId, token_hash: await sha256Hex(token), expires_at: expiresAt(Date.now(), TOKEN_DAYS) });
    return { ord: s.ord, name: s.name, email: s.email, link: signLink(origin(), token) };
  },
  cancelEsign: (space, id) => write(space, 'esign.cancel', { id }),
  async deleteEsign(space, id) {
    const r = await write(space, 'esign.delete', { id });
    await remove(r?.paths ?? []);
  },
  /** 완료 다시 시도 — 서명본 합성은 서버(서비스 키)가, 권한·상태 확인은 내 로그인으로 DB가 */
  async finishEsign(space, id) {
    const { data } = await (await sb()).auth.getSession();
    if (!data?.session?.access_token) throw fail('signIn');
    return api('finish', { org: orgOf(space), id }, data.session.access_token);
  },
  markFiled: (space, id) => write(space, 'esign.filed', { id }),
  markNotified: (space, id) => write(space, 'esign.notified', { id }),
  esignPdf: (space, e, which = 'orig') => download(which === 'final' ? e.final_path : e.orig_path),
  events: (space, id) => rpc('office_docs_events', { p_org: orgOf(space), p_id: id }),
  mails: async () => [], // 로그인 모드의 보낸 메일은 메일 계정(보낸편지함)에 있다

  /* 공개 서명 — 로그인 없이 서버 함수로 */
  publicState: (token) => api('state', { token }),
  async publicOpen(token, email) { const d = await api('open', { token, email }); return { ...d, pdf: await bytesOf(d.pdfUrl) }; },
  async publicSubmit(token, email, placements) { const d = await api('submit', { token, email, placements }); return d.finalUrl ? { ...d, final: await bytesOf(d.finalUrl) } : d; },
};
