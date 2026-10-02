// 전자서명 규칙 — 순수 함수(브라우저·서버 함수·노드 테스트 공용). 인트라넷 app/api/esign/*·lib/esign/*의 정규화·검증을 옮겼다.
import { DOC, SAFE_NAME_RE } from './doc-text.js';

export const STATUSES = ['draft', 'sent', 'completed', 'cancelled'];
export const FIELD_KINDS = ['signature', 'text', 'date'];
export const PARTY = DOC.party;
export const TOKEN_DAYS = 30; // 서명 링크 유효 기간(인트라넷 token.ts:13)
export const DEFAULT_SIZE = { signature: { wr: 0.15, hr: 0.06 }, text: { wr: 0.2, hr: 0.032 }, date: { wr: 0.14, hr: 0.032 } };

/** 갑/을/병… 서명자 순번 라벨(인트라넷 sign route:23) */
export const partyLabel = (ord) => PARTY[ord] || DOC.partyN(ord + 1);

/** 이메일 가리기 — ab**@x.com(인트라넷 sign route:16-21) */
export function maskEmail(e) {
  const [local, domain] = String(e || '').split('@');
  if (!domain) return '***';
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}${'*'.repeat(Math.max(2, local.length - head.length))}@${domain}`;
}
export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim());
/** 서명 완료 메일 받는 사람 — 서명자 전원 + 우리 회사(도장으로 대신해 서명자에서 빠졌어도 서명본을 받는다, 유건 10/2). 같은 주소는 한 번만 */
export function completionRecipients(signers = [], ownEmail = '') {
  const seen = new Set(), out = [];
  for (const e of [...signers.map((s) => s.email), ownEmail]) { const n = normEmail(e); if (isEmail(e) && !seen.has(n)) { seen.add(n); out.push(String(e).trim()); } }
  return out;
}

const c01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** 소유자가 배치한 필드 정규화(인트라넷 contracts route:44-56) — 종류·쪽 확인, 좌표 0~1, 크기 하한 */
export function normalizeFields(raw, pageCount = Infinity) {
  return (Array.isArray(raw) ? raw : []).filter((f) => FIELD_KINDS.includes(f?.kind) && Number.isInteger(f?.page) && f.page >= 0 && f.page < pageCount).slice(0, 200).map((f, i) => ({
    id: `fd${i}`, signer_ord: Math.max(0, Math.min(9, f.signer_ord | 0)), page: f.page | 0,
    xr: c01(f.xr), yr: c01(f.yr), wr: Math.min(1, Math.max(0.02, +f.wr || 0.15)), hr: Math.min(1, Math.max(0.01, +f.hr || 0.03)),
    kind: f.kind, required: f.required !== false,
  }));
}

/** 서명자 정리 — 이름·이메일 둘 다 있는 사람만, 최대 5명, 이메일 중복 제거 */
export function cleanSigners(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map((s) => ({ name: String(s?.name ?? '').trim().slice(0, 100), email: String(s?.email ?? '').trim().slice(0, 320) }))
    .filter((s) => s.name && isEmail(s.email) && !seen.has(normEmail(s.email)) && seen.add(normEmail(s.email))).slice(0, 5);
}

/** 견적·계약 화면에서 서명 초안을 만들 때의 서명자(인트라넷 esign/send route:33-40): 갑(회사+이메일 둘 다 있을 때만) → 을(우리 회사).
 *  갑이 없으면 을 단독이 갑으로 오인되므로 비운다. sealed: 을은 회사 도장을 찍어 두었으므로 서명자에서 뺀다(오피스 추가) */
export function draftSigners({ clientCompany, clientEmail, company, sealed = false }) {
  const a = String(clientCompany || '').trim(), e = String(clientEmail || '').trim();
  if (!a || !isEmail(e)) return [];
  const list = [{ name: a, email: e }];
  if (!sealed && company?.email && isEmail(company.email)) list.push({ name: company.name || company.legalName || DOC.supplierFallback, email: company.email });
  return list;
}

/** 발송 검사(인트라넷 new/page.tsx:147-153, send route:16-21) → 오류 사전 키 또는 null, 쓸 필드(서명자 범위 밖 제외) */
export function checkSend({ hasPdf, signers, fields, status = 'draft' }) {
  if (status === 'completed') return { error: 'esign.err.completed' };
  if (status === 'sent') return { error: 'esign.err.sent' };
  if (status === 'cancelled') return { error: 'esign.err.cancelled' };
  if (!hasPdf) return { error: 'esign.err.pdf' };
  const valid = cleanSigners(signers);
  if (!valid.length) return { error: 'esign.err.signers' };
  const usable = (fields ?? []).filter((f) => f.signer_ord < valid.length);
  if (!usable.length) return { error: 'esign.err.fields' };
  // 서명란이 없는 서명자도 서명 화면에서 직접 서명을 놓을 수 있어 막지는 않고 알리기만 한다
  const warn = valid.some((_, i) => !usable.some((f) => f.signer_ord === i && f.kind === 'signature')) ? 'esign.warn.signerField' : null;
  return { error: null, warn, signers: valid, fields: usable };
}

/** 서명 제출 정규화(인트라넷 sign route:89-106) — 텍스트 1000자·글자 크기 범위, 이미지는 png/jpg data URL만. 반환: [{ page, kind, xr, yr, wr, text?, sizeR?, img? }] */
/** 계약일자 글자 — 서식의 빈칸 안내 자리를 채우는 모양(문서 서식 문구 DOC.signDate) */
export const koDate = (d = new Date()) => DOC.signDate(d.getFullYear(), d.getMonth() + 1, d.getDate());

export function normalizePlacements(raw, pageCount = Infinity) {
  const out = [];
  for (const p of Array.isArray(raw) ? raw.slice(0, 100) : []) {
    if (!Number.isInteger(p?.page) || p.page < 0 || p.page >= pageCount) continue;
    const base = { page: p.page, xr: c01(p.xr), yr: c01(p.yr), wr: Math.min(1, Math.max(0.02, +p.wr || 0.15)) };
    if (p.kind === 'text') {
      const text = String(p.text || '').slice(0, 1000).replace(/\r/g, '');
      if (!text.trim()) continue;
      out.push({ ...base, kind: 'text', text, sizeR: Math.min(0.1, Math.max(0.008, +p.sizeR || 0.02)), ...(p.cover === true ? { cover: true } : {}) }); // cover: 인쇄된 빈칸 안내(계약일자 "2026년 월 일")를 흰 바탕으로 덮고 그 자리에 쓴다
    } else {
      const m = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/=]+)$/.exec(String(p.imgDataUrl || ''));
      if (!m || m[2].length > 2_800_000) continue; // 그림 하나 2MB 상한
      out.push({ ...base, kind: 'signature', img: { type: m[1] === 'png' ? 'png' : 'jpg', data: m[2] } });
    }
  }
  return out;
}

/** 서명 링크 토큰 — 32바이트 무작위(base64url). DB에는 SHA-256 해시만 둔다(링크 원문은 메일에만 — 인트라넷의 기본 비밀값 HMAC보다 안전) */
export function newToken() {
  const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
export const tokenOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{40,64}$/.test(t);
export const expiresAt = (now = Date.now(), days = TOKEN_DAYS) => new Date(now + days * 864e5).toISOString();

/** 서명 링크 주소 */
export const signLink = (origin, token) => `${String(origin).replace(/\/$/, '')}/sign/${token}`;

/** 목록 표의 서명자 요약 — 서명 n/N */
export const signedCount = (signers = []) => ({ done: signers.filter((s) => s.status === 'signed').length, total: signers.length });

/** 파일 이름 "<제목>_서명본.pdf"(인트라넷 sign route:125,133 — 40자) */
export const signedFilename = (title) => `${String(title || '').replace(SAFE_NAME_RE, '_').slice(0, 40) || 'contract'}${DOC.signedSuffix}`;
