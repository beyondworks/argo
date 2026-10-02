import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { GET, POST } from '../api/esign/[op].js';

// 이유(spec8 트랙 A): 로그인 없는 서명자 길(api/esign)이 인트라넷 sign route와 같은 규칙으로 DB 함수·저장소를 부르는지 — 가짜 Supabase로 잠근다.
// (실제 DB 함수의 권한·잠금은 supabase 마이그레이션 + pg 드릴 몫. 여기서는 서버 함수가 넘기는 값과 순서·오류 모양)

const sha = (s) => createHash('sha256').update(s).digest('hex');
const TOKEN = 'T'.repeat(43);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function fakeSupabase(over = {}) {
  const orig = await (async () => { const d = await PDFDocument.create(); d.addPage([595.28, 841.89]); return d.save(); })();
  const calls = [], uploads = new Map();
  const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method ?? 'GET';
    calls.push({ path: u.pathname, method, body: init.body, auth: init.headers?.authorization });
    const rpc = /\/rest\/v1\/rpc\/(\w+)/.exec(u.pathname)?.[1];
    if (rpc) {
      const args = JSON.parse(init.body);
      if (over[rpc]) return over[rpc](args, reply);
      if (rpc === 'office_esign_public_state') return reply({ status: 'pending', maskedEmail: 'p**@h.example' });
      if (rpc === 'office_esign_public_open') return reply({ alreadySigned: false, signer: { name: '한빛', ord: 0 }, contract: { title: '계약' }, fields: [], orig_path: 'o-org/esign/e1/orig.pdf', pages: 1 });
      if (rpc === 'office_esign_public_who') return reply({ esign_id: 'e1', signer_id: 's1', seg: 'o-org', pages: 1, status: 'sent', signer_status: 'pending' });
      if (rpc === 'office_esign_public_submit') return reply({ done: true, esign_id: 'e1', signer_id: 's1' });
      if (rpc === 'office_esign_public_bundle') return reply({ id: 'e1', title: '용역 계약서', doc_hash: 'a'.repeat(64), orig_path: 'o-org/esign/e1/orig.pdf', seg: 'o-org', status: 'sent', mail_account: null, signers: [{ id: 's1', ord: 0, name: '한빛', email: 'p@h.example', signed_at: '2026-10-02T03:00:00Z', ip: '9.9.9.9', placements: JSON.parse(calls.find((c) => c.path.endsWith('office_esign_public_submit')).body).p_placements }] });
      if (rpc === 'office_esign_public_finalize') return reply({ order_sync: 'confirmed' });
      return reply('{"message":"unknown"}', 404);
    }
    if (u.pathname.includes('/storage/v1/object/sign/')) return reply({ signedURL: `/object/sign/office-docs/${u.pathname.split('/office-docs/')[1]}?token=x` });
    if (u.pathname.startsWith('/storage/v1/object/office-docs/')) {
      const path = u.pathname.slice('/storage/v1/object/office-docs/'.length);
      if (method === 'POST') { uploads.set(path, new Uint8Array(init.body)); return reply({ Key: path }); }
      if (path.endsWith('orig.pdf')) return new Response(orig);
      if (uploads.has(path)) return new Response(uploads.get(path));
      return reply({}, 404);
    }
    if (u.pathname.startsWith('/fonts/')) return reply({}, 404);
    return reply({}, 404);
  };
  process.env.VITE_SUPABASE_URL = 'https://sb.test';
  process.env.OFFICE_SUPABASE_SERVICE_KEY = 'service-test';
  return { calls, uploads };
}
const req = (op, body, headers = {}) => new Request(`http://localhost/api/esign/${op}`, body ? { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) } : { headers });

test('설정이 없으면 503, 모양이 틀린 토큰은 DB를 부르지 않고 404', async () => {
  delete process.env.OFFICE_SUPABASE_SERVICE_KEY;
  let called = 0; globalThis.fetch = async () => { called++; return new Response('{}'); };
  assert.equal((await GET(req(`state?token=${TOKEN}`))).status, 503);
  process.env.OFFICE_SUPABASE_SERVICE_KEY = 'k';
  const r = await GET(req('state?token=short'));
  assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'invalid' }); assert.equal(called, 0);
  assert.equal((await POST(req('state', {}))).status, 405, '바꾸는 동작만 POST');
});

test('링크 확인·열기: DB에는 토큰 해시만, 서명자 IP·브라우저를 넘기고, 원본 경로 대신 10분 서명 주소를 돌려준다', async () => {
  const { calls } = await fakeSupabase();
  const s = await (await GET(req(`state?token=${TOKEN}`))).json();
  assert.deepEqual(s, { status: 'pending', maskedEmail: 'p**@h.example' });
  assert.equal(JSON.parse(calls[0].body).p_hash, sha(TOKEN));
  assert.ok(!calls.some((c) => String(c.body).includes(TOKEN)), '토큰 원문은 DB로 가지 않는다');
  const o = await (await POST(req('open', { token: TOKEN, email: 'p@h.example' }, { 'x-forwarded-for': '1.2.3.4, 10.0.0.1', 'user-agent': 'UA' }))).json();
  const openArgs = JSON.parse(calls.find((c) => c.path.endsWith('office_esign_public_open')).body);
  assert.deepEqual({ ip: openArgs.p_ip, ua: openArgs.p_ua }, { ip: '1.2.3.4', ua: 'UA' });
  assert.equal(o.orig_path, undefined);
  assert.match(o.pdfUrl, /^https:\/\/sb\.test\/storage\/v1\/object\/sign\/office-docs\/o-org\/esign\/e1\/orig\.pdf\?token=x$/);
  assert.equal(JSON.parse(calls.find((c) => c.path.includes('/object/sign/')).body).expiresIn, 600);
});

test('DB 함수 오류는 화면 코드로(이메일 불일치 403·완료 403·이미 제출 409), 원문은 내보내지 않는다', async () => {
  await fakeSupabase({ office_esign_public_open: (_a, reply) => reply('{"code":"P0001","message":"docs_email"}', 400) });
  const r = await POST(req('open', { token: TOKEN, email: 'x@x.x' }));
  assert.equal(r.status, 403); assert.deepEqual(await r.json(), { error: 'email' });
  await fakeSupabase({ office_esign_public_who: (_a, reply) => reply({ esign_id: 'e1', signer_id: 's1', seg: 'o-org', status: 'sent', signer_status: 'signed' }) });
  assert.equal((await POST(req('submit', { token: TOKEN, email: 'p@h.example', placements: [{ page: 0, kind: 'text', text: 'x' }] }))).status, 409);
  await fakeSupabase({ office_esign_public_who: (_a, reply) => reply({ status: 'completed' }) });
  assert.deepEqual(await (await POST(req('submit', { token: TOKEN, email: 'p@h.example', placements: [] }))).json(), { error: 'completed' });
});

test('제출 → 전원 완료: 서명 그림은 저장소(s-<서명자>-n.png)로 DB에는 경로만, 서명본을 크롬 없이 합성·보관하고 해시와 함께 완료', async () => {
  const { calls, uploads } = await fakeSupabase();
  const r = await (await POST(req('submit', { token: TOKEN, email: 'p@h.example', placements: [
    { page: 0, kind: 'signature', imgDataUrl: `data:image/png;base64,${PNG}`, xr: 0.5, yr: 0.5, wr: 0.2 },
    { page: 0, kind: 'text', text: '2026-10-02', xr: 0.1, yr: 0.1, wr: 0.2, sizeR: 0.02 },
    { page: 5, kind: 'text', text: '없는 쪽' },
  ] }))).json();
  assert.equal(r.done, true); assert.match(r.finalUrl, /final\.pdf\?token=x$/);
  assert.ok(uploads.has('o-org/esign/e1/s-s1-0.png'), '그림 경로는 서명 한 건·서명자 아래');
  const sub = JSON.parse(calls.find((c) => c.path.endsWith('office_esign_public_submit')).body);
  assert.equal(sub.p_placements.length, 2, '없는 쪽 칸은 버린다');
  assert.equal(sub.p_placements[0].img_path, 'o-org/esign/e1/s-s1-0.png'); assert.equal(sub.p_placements[0].img, undefined, 'DB에는 그림 자체를 넣지 않는다');
  const final = uploads.get('o-org/esign/e1/final.pdf');
  assert.equal((await PDFDocument.load(final)).getPageCount(), 2, '원본 + 감사 증명');
  const fin = JSON.parse(calls.find((c) => c.path.endsWith('office_esign_public_finalize')).body);
  assert.deepEqual(fin, { p_esign: 'e1', p_final_path: 'o-org/esign/e1/final.pdf', p_final_hash: sha(final) });
  assert.ok(calls.filter((c) => c.path.includes('/rest/v1/')).every((c) => c.auth === 'Bearer service-test'));
  assert.ok(!calls.some((c) => c.path.endsWith('office_esign_public_notified')), '보낸 메일 계정이 없으면 완료 알림은 화면이 보낸다');
});
