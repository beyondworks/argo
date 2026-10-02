// 공개 서명 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — 로그인 없는 서명자(/sign/<토큰>)를 위한 길 하나.
// 인트라넷 app/api/esign/sign/[token]/route.ts와 같은 규칙: 링크 확인 → 본인 이메일 확인 → 계약서 공개 → 서명 제출 → 전원 완료 시 서명본 합성·보관·완료 메일.
// 서명자는 로그인하지 않으므로 서비스 키(OFFICE_SUPABASE_SERVICE_KEY, 서버에만)로 office_esign_public_* 함수(service_role 전용)와 Storage(office-docs)를 쓴다.
// 서비스 키로 하는 일은 이 파일의 네 동작뿐이고, 무엇을 읽고 쓸지는 토큰 해시를 받은 DB 함수가 정한다(토큰 원문은 DB에 없다).
// 서명본은 크롬 없이 pdf-lib로 합성한다(src/docs/pdf/compose.js — 예시 모드 브라우저 합성과 같은 함수).
// 완료 메일은 서명 요청을 보낸 메일 계정(Gmail)으로 — 봉인된 토큰을 OFFICE_MAIL_KEY로 연다. 못 보내면 화면이 '완료 알림 보내기'를 보인다.
// env: VITE_SUPABASE_URL · OFFICE_SUPABASE_SERVICE_KEY · OFFICE_MAIL_KEY · OFFICE_GOOGLE_CLIENT_ID · OFFICE_GOOGLE_CLIENT_SECRET · OFFICE_ORIGIN
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mailKey, unseal } from '../../server/seal.js';
import { buildRaw } from '../../server/gmail.js';
import { normalizePlacements, tokenOk, signedFilename } from '../../src/docs/esign-model.js';
import { signCompletedMail } from '../../src/docs/esign-mail.js';
import { composeSignedPdf } from '../../src/docs/pdf/compose.js';

const env = process.env;
const BUCKET = 'office-docs';
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ipOf = (req) => (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
const uaOf = (req) => (req.headers.get('user-agent') || 'unknown').slice(0, 300);

function service() {
  if (!env.VITE_SUPABASE_URL || !env.OFFICE_SUPABASE_SERVICE_KEY) throw fail(503, 'not_configured');
  return { url: env.VITE_SUPABASE_URL, key: env.OFFICE_SUPABASE_SERVICE_KEY };
}
const headers = (extra = {}) => { const { key } = service(); return { apikey: key, authorization: `Bearer ${key}`, ...extra }; };

/** DB 함수 — docs_* 오류는 화면 코드로(invalid·email·completed·cancelled·already·input) */
async function rpc(fn, args) {
  const r = await fetch(`${service().url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify(args) });
  const t = await r.text();
  if (!r.ok) {
    const m = /docs_([a-z_]+)/.exec(t);
    const code = m?.[1] ?? 'db';
    throw fail({ invalid: 404, email: 403, completed: 403, cancelled: 403, already: 409, input: 400, state: 409 }[code] ?? 502, code);
  }
  return t ? JSON.parse(t) : null;
}
async function put(path, bytes, type) {
  const r = await fetch(`${service().url}/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: headers({ 'content-type': type, 'x-upsert': 'false' }), body: bytes });
  if (!r.ok) throw fail(502, 'storage');
}
async function get(path) {
  const r = await fetch(`${service().url}/storage/v1/object/${BUCKET}/${path}`, { headers: headers() });
  if (!r.ok) throw fail(502, 'storage');
  return new Uint8Array(await r.arrayBuffer());
}
/** 10분짜리 서명 주소 — 서명자 브라우저가 PDF를 직접 받는다(이 함수를 거치지 않아 4.5MB 응답 한도와 무관) */
async function signed(path, seconds = 600) {
  const r = await fetch(`${service().url}/storage/v1/object/sign/${BUCKET}/${path}`, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: JSON.stringify({ expiresIn: seconds }) });
  if (!r.ok) throw fail(502, 'storage');
  const { signedURL } = await r.json();
  return `${service().url}/storage/v1${signedURL}`;
}

async function fonts() {
  const read = (name) => readFile(new URL(`../../public/fonts/${name}`, import.meta.url)).catch(async () => {
    const r = await fetch(new URL(`/fonts/${name}`, env.OFFICE_ORIGIN || 'http://localhost:5190')); // 함수 묶음에 글꼴이 안 실린 경우 같은 배포의 정적 파일
    if (!r.ok) throw fail(502, 'font');
    return new Uint8Array(await r.arrayBuffer());
  });
  const [font, bold] = await Promise.all([read('Pretendard-Regular.ttf'), read('Pretendard-Bold.ttf')]);
  return { font, bold };
}

/** 보낸 사람 메일 계정으로 완료 메일 — 서비스 키로 봉인된 갱신 토큰을 읽고(OFFICE_MAIL_KEY로 연다) 접근 토큰을 받아 Gmail로. 토큰은 다시 저장하지 않는다(쓰기 0) */
async function sendCompletionMails(bundle, finalPdf) {
  if (!bundle.mail_account || !env.OFFICE_MAIL_KEY || !env.OFFICE_GOOGLE_CLIENT_ID || !env.OFFICE_GOOGLE_CLIENT_SECRET) return false;
  const q = (path) => fetch(`${service().url}/rest/v1/${path}`, { headers: headers() }).then((r) => (r.ok ? r.json() : []));
  const [acc] = await q(`office_mail_accounts?id=eq.${bundle.mail_account}&select=id,user_id,provider,address,status`);
  const [sec] = await q(`office_mail_secrets?account_id=eq.${bundle.mail_account}&select=sealed`);
  if (!acc || !sec || acc.status !== 'ok') return false;
  const refresh = unseal(mailKey(), sec.sealed, `${acc.user_id}:${acc.provider}:${acc.address}`);
  if (!refresh) return false;
  const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.OFFICE_GOOGLE_CLIENT_ID, client_secret: env.OFFICE_GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refresh }) });
  if (!tr.ok) return false;
  const { access_token: token } = await tr.json();
  const mail = signCompletedMail({ title: bundle.title, signers: bundle.signers });
  const attachments = [{ name: signedFilename(bundle.title), type: 'application/pdf', data: Buffer.from(finalPdf).toString('base64') }];
  let ok = true;
  for (const s of bundle.signers) {
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: buildRaw({ to: s.email, subject: mail.subject, text: mail.text, html: mail.html, attachments }) }) });
    if (!r.ok) ok = false;
  }
  return ok;
}

const b64bytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));

const OPS = {
  async state(_req, { token }) {
    if (!tokenOk(token)) throw fail(404, 'invalid');
    return rpc('office_esign_public_state', { p_hash: sha(token) });
  },
  async open(req, { token, email }) {
    if (!tokenOk(token)) throw fail(404, 'invalid');
    const d = await rpc('office_esign_public_open', { p_hash: sha(token), p_email: String(email ?? '').slice(0, 320), p_ip: ipOf(req), p_ua: uaOf(req) });
    const { orig_path: path, ...rest } = d;
    return { ...rest, pdfUrl: await signed(path) };
  },
  async submit(req, { token, email, placements }) {
    if (!tokenOk(token)) throw fail(404, 'invalid');
    const hash = sha(token);
    const who = await rpc('office_esign_public_who', { p_hash: hash });
    if (who.status !== 'sent') throw fail(403, who.status === 'completed' ? 'completed' : who.status === 'cancelled' ? 'cancelled' : 'invalid');
    if (who.signer_status === 'signed') throw fail(409, 'already');
    const clean = normalizePlacements(placements, who.pages ?? Infinity);
    if (!clean.length) throw fail(400, 'empty');
    // 그림은 저장소에, DB에는 경로만(서명 기록 표가 커지지 않게) — 같은 서명자가 다시 내면 DB 함수가 'already'로 막는다
    const stored = [];
    for (let i = 0; i < clean.length; i++) {
      const p = clean[i];
      if (p.kind !== 'signature') { stored.push(p); continue; }
      const path = `${who.seg}/esign/${who.esign_id}/s-${who.signer_id}-${i}.${p.img.type}`;
      await put(path, b64bytes(p.img.data), p.img.type === 'png' ? 'image/png' : 'image/jpeg');
      const { img, ...rest } = p;
      stored.push({ ...rest, img_path: path });
    }
    const r = await rpc('office_esign_public_submit', { p_hash: hash, p_email: String(email ?? '').slice(0, 320), p_placements: stored, p_ip: ipOf(req), p_ua: uaOf(req) });
    if (!r.done) return { done: false };
    // 전원 서명 — 서명본 합성(크롬 없이 pdf-lib), 보관, 완료(거래 '계약' 넘기기는 DB 함수가), 완료 메일
    const bundle = await rpc('office_esign_public_bundle', { p_esign: r.esign_id });
    const completedAt = new Date().toISOString();
    const signers = await Promise.all(bundle.signers.map(async (s) => ({ ...s, placements: await Promise.all((s.placements ?? []).map(async (p) => (p.img_path ? { ...p, img: { type: p.img_path.endsWith('.jpg') ? 'jpg' : 'png', bytes: await get(p.img_path) } } : p))) })));
    const final = await composeSignedPdf({ origPdf: await get(bundle.orig_path), signers, docHash: bundle.doc_hash, title: bundle.title, completedAt, ...(await fonts()) });
    const finalPath = `${bundle.seg}/esign/${bundle.id}/final.pdf`;
    await put(finalPath, final, 'application/pdf');
    await rpc('office_esign_public_finalize', { p_esign: bundle.id, p_final_path: finalPath, p_final_hash: sha(final) });
    try { if (await sendCompletionMails(bundle, final)) await rpc('office_esign_public_notified', { p_esign: bundle.id }); } catch (e) { console.error('[office esign] 완료 메일', e?.message); }
    return { done: true, title: bundle.title, finalUrl: await signed(finalPath) };
  },
};

async function handle(req, op, args) {
  try {
    if (!Object.hasOwn(OPS, op)) throw fail(404, 'op');
    return json(await OPS[op](req, args));
  } catch (e) {
    if (!e.status) console.error('[office esign]', op, e);
    return json({ error: e.code ?? 'server' }, e.status ?? 500); // DB·저장소 원문은 서명자 화면에 보내지 않는다
  }
}
const opOf = (req) => new URL(req.url).pathname.split('/').pop();
export async function GET(req) { const op = opOf(req); return op === 'state' ? handle(req, op, Object.fromEntries(new URL(req.url).searchParams)) : json({ error: 'method' }, 405); }
export async function POST(req) {
  const op = opOf(req);
  if (!['open', 'submit'].includes(op)) return json({ error: 'method' }, 405);
  const body = await req.json().catch(() => ({}));
  return handle(req, op, body);
}
