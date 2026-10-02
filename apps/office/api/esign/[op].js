// 공개 서명 서버 함수(Vercel, 로컬은 vite.config.js가 같은 파일을 연결) — 로그인 없는 서명자(/sign/<토큰>)를 위한 길 하나.
// 인트라넷 app/api/esign/sign/[token]/route.ts와 같은 규칙: 링크 확인 → 본인 이메일 확인 → 계약서 공개 → 서명 제출 → 전원 완료 시 서명본 합성·보관·완료 메일.
// 서명자는 로그인하지 않으므로 서비스 키(OFFICE_SUPABASE_SERVICE_KEY, 서버에만)로 office_esign_public_* 함수(service_role 전용)를 부르고, 파일은 R2(argo-office)에 직접 쓴다.
// 서버가 쓰는 객체(서명 그림·서명본)는 "행 먼저(pending) → R2 PUT → 등록(uploaded·claimed)" 순서로 r2_object_server_put에 남긴다 — 용량에 들어가지만 막지 않는다.
// 서명자에게 주는 원본·서명본 주소는 DB 함수가 돌려준 키로만 만든 10분짜리 R2 서명 주소다.
// 서비스 키로 하는 일은 이 파일의 네 동작뿐이고, 무엇을 읽고 쓸지는 토큰 해시를 받은 DB 함수가 정한다(토큰 원문은 DB에 없다).
// 서명본은 크롬 없이 pdf-lib로 합성한다(src/docs/pdf/compose.js — 예시 모드 브라우저 합성과 같은 함수).
// 완료 메일은 서명 요청을 보낸 메일 계정(Gmail)으로 — 봉인된 토큰을 OFFICE_MAIL_KEY로 연다. 못 보내면 화면이 '완료 알림 보내기'를 보인다.
// env: VITE_SUPABASE_URL · VITE_SUPABASE_ANON_KEY(완료 다시 시도의 권한 확인) · OFFICE_SUPABASE_SERVICE_KEY · OFFICE_MAIL_KEY · OFFICE_GOOGLE_CLIENT_ID · OFFICE_GOOGLE_CLIENT_SECRET · OFFICE_ORIGIN
//      R2_ENDPOINT · R2_OFFICE_BUCKET · R2_OFFICE_ACCESS_KEY_ID · R2_OFFICE_SECRET_ACCESS_KEY
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mailKey, unseal } from '../../server/seal.js';
import { buildRaw } from '../../server/gmail.js';
import { normalizePlacements, tokenOk, signedFilename } from '../../src/docs/esign-model.js';
import { signCompletedMail } from '../../src/docs/esign-mail.js';
import { completionRecipients } from '../../src/docs/esign-model.js';
import { composeSignedPdf } from '../../src/docs/pdf/compose.js';
import { r2FromEnv } from '../../server/r2.js';

const env = process.env;
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ipOf = (req) => req.headers.get('x-vercel-forwarded-for') || req.headers.get('x-real-ip') || (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'; // Vercel이 채우는 헤더 먼저(위조 방지)
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
const r2 = () => r2FromEnv(env);
/** 서버가 쓰는 객체 — 행 먼저(pending, 행 없는 객체가 생기지 않게) → R2 PUT(덮어쓰기 허용 — 끊긴 마무리를 다시 할 수 있게) → 등록 */
async function put(key, seg, bytes, type, state, ref) {
  const row = { p_key: key, p_seg: seg, p_bytes: bytes.length, p_mime: type };
  await rpc('r2_object_server_put', { ...row, p_state: 'pending' });
  let etag;
  try { ({ etag } = await r2().put(key, bytes, { contentType: type })); } catch (e) { throw fail(e.status === 503 ? 503 : 502, e.status === 503 ? e.code : 'storage'); }
  await rpc('r2_object_server_put', { ...row, p_state: state, p_ref_kind: 'esign', p_ref_id: ref, p_etag: etag });
}
/** 실패한 제출의 그림 — R2에서 지우고 등록 전 행을 지운다(못 지우면 정리 크론이 1시간 뒤 다시) */
async function removeFiles(keys) {
  if (!keys.length) return;
  for (const k of keys) await r2().del(k).catch(() => {});
  await rpc('r2_object_fail', { p_keys: keys }).catch(() => {});
}
async function get(key) {
  try { return await r2().get(key); } catch (e) { throw fail(e.status === 503 ? 503 : 502, e.status === 503 ? e.code : 'storage'); }
}
/** 10분짜리 R2 서명 주소 — 서명자 브라우저가 PDF를 R2에서 직접 받는다(이 함수를 거치지 않아 4.5MB 응답 한도와 무관). 키는 DB 함수가 준 값만 */
async function signed(key) { return (await r2().presign({ method: 'GET', key })).url; }

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
  for (const to of completionRecipients(bundle.signers, acc.address)) { // 서명자 + 우리 회사(보낸 계정) — 도장으로 대신해 빠졌어도 사본을 받는다
    const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw: buildRaw({ to, subject: mail.subject, text: mail.text, html: mail.html, attachments }) }) });
    if (!r.ok) ok = false;
  }
  return ok;
}

const b64bytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/** 전원 서명 뒤 마무리 — 서명본 합성(크롬 없이 pdf-lib)·보관·완료(거래 '계약' 넘기기는 DB 함수가)·완료 메일.
 *  다시 불러도 같은 결과: 이미 완료면 서명본 주소만, 서명본 파일은 덮어쓴다(중간에 끊긴 뒤 서명자 재제출·소유자 '완료 다시 시도'가 이어서 끝낸다). */
async function complete(esignId) {
  const bundle = await rpc('office_esign_public_bundle', { p_esign: esignId });
  if (!bundle) throw fail(404, 'invalid');
  if (bundle.status === 'completed') return { done: true, title: bundle.title, finalUrl: await signed(bundle.final_path) };
  const origPdf = await get(bundle.orig_path);
  if (sha(origPdf) !== bundle.doc_hash) throw fail(409, 'tampered'); // 서명자가 본 원본(만들 때의 해시)과 다르면 서명본을 만들지 않는다
  const completedAt = new Date().toISOString();
  const signers = await Promise.all(bundle.signers.map(async (s) => ({ ...s, placements: await Promise.all((s.placements ?? []).map(async (p) => (p.img_path ? { ...p, img: { type: p.img_path.endsWith('.jpg') ? 'jpg' : 'png', bytes: await get(p.img_path) } } : p))) })));
  const final = await composeSignedPdf({ origPdf, signers, docHash: bundle.doc_hash, title: bundle.title, completedAt, ...(await fonts()) });
  const finalPath = `${bundle.seg}/esign/${bundle.id}/final.pdf`;
  await put(finalPath, bundle.seg, final, 'application/pdf', 'claimed', bundle.id); // 서명 폴더 객체 — 서명을 지우면 함께 지워진다
  await rpc('office_esign_public_finalize', { p_esign: bundle.id, p_final_path: finalPath, p_final_hash: sha(final) });
  try { if (await sendCompletionMails(bundle, final)) await rpc('office_esign_public_notified', { p_esign: bundle.id }); } catch (e) { console.error('[office esign] completion mail', e?.message); }
  return { done: true, title: bundle.title, finalUrl: await signed(finalPath) };
}

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
    const hash = sha(token), mail = String(email ?? '').slice(0, 320);
    const who = await rpc('office_esign_public_who', { p_hash: hash, p_email: mail }); // 본인 이메일 확인이 먼저 — 그 전에는 아무것도 올리지 않는다
    if (who.status !== 'sent') throw fail(403, who.status === 'completed' ? 'completed' : who.status === 'cancelled' ? 'cancelled' : 'invalid');
    if (who.signer_status === 'signed') {
      if (who.all_signed) return complete(who.esign_id); // 앞선 제출 뒤 마무리만 끊긴 경우 — 이어서 끝낸다
      throw fail(409, 'already');
    }
    const clean = normalizePlacements(placements, who.pages ?? Infinity);
    if (!clean.length) throw fail(400, 'empty');
    // 그림은 저장소에, DB에는 경로만(서명 기록 표가 커지지 않게). 시도마다 다른 이름 — 실패한 시도가 다음 제출을 막지 않게, 실패하면 지운다
    const attempt = randomBytes(6).toString('hex');
    const stored = [], uploaded = [];
    let submitted = false;
    try {
      for (let i = 0; i < clean.length; i++) {
        const p = clean[i];
        if (p.kind !== 'signature') { stored.push(p); continue; }
        const path = `${who.seg}/esign/${who.esign_id}/s-${who.signer_id}-${i}-${attempt}.${p.img.type}`;
        uploaded.push(path); // 행을 먼저 남기므로 PUT 중간 실패도 정리 대상
        await put(path, who.seg, b64bytes(p.img.data), p.img.type === 'png' ? 'image/png' : 'image/jpeg', 'uploaded', who.esign_id); // 제출이 가져간다(claimed)
        const { img, ...rest } = p;
        stored.push({ ...rest, img_path: path });
      }
      const r = await rpc('office_esign_public_submit', { p_hash: hash, p_email: mail, p_placements: stored, p_ip: ipOf(req), p_ua: uaOf(req) });
      submitted = true;
      if (!r.done) return { done: false };
      return await complete(r.esign_id);
    } finally {
      // 제출이 DB에 남지 않았으면 올린 그림을 치운다(고아 파일 방지). 응답만 끊기고 DB에는 남았을 수 있어 한 번 확인한다 — 남았으면 서명본·삭제가 그 경로를 쓴다
      if (!submitted && uploaded.length) {
        const saved = await rpc('office_esign_public_who', { p_hash: hash, p_email: mail }).then((w) => w.signer_status === 'signed').catch(() => true);
        if (!saved) await removeFiles(uploaded);
      }
    }
  },
  /** 완료 다시 시도(소유자·관리자) — 로그인 토큰으로 DB가 권한·상태(전원 서명, 미완료)를 확인한 뒤 서비스 키로 마무리 */
  async finish(req, { org, id }) {
    const jwt = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!jwt || !env.VITE_SUPABASE_ANON_KEY) throw fail(401, 'signIn');
    const r = await fetch(`${service().url}/rest/v1/rpc/office_docs_write`, { method: 'POST', headers: { apikey: env.VITE_SUPABASE_ANON_KEY, authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify({ p_org: org ?? null, p_action: 'esign.finishable', p_data: { id } }) });
    const t = await r.text();
    if (!r.ok) { const code = /docs_([a-z_]+)/.exec(t)?.[1] ?? 'permission'; throw fail(code === 'state' ? 409 : code === 'not_found' ? 404 : 403, code); }
    return complete(JSON.parse(t).id);
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
export async function GET() { return json({ error: 'method' }, 405); } // 토큰이 주소(접근 기록)에 남지 않게 전부 POST
export async function POST(req) {
  const op = opOf(req);
  if (!Object.hasOwn(OPS, op)) return json({ error: 'op' }, 404);
  const body = await req.json().catch(() => ({}));
  return handle(req, op, body);
}
