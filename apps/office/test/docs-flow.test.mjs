import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { createSampleDocs } from '../src/docs/backend-sample.js';
import { composeSignedPdf } from '../src/docs/pdf/compose.js';
import { sha256Hex } from '../src/docs/esign-model.js';
import { seedBusiness, applyBusiness, reportBusiness, createSampleBusinessClient } from '../src/business/sample-business.js';
import { dealStage, dealAmounts } from '../src/business/deal-model.js';

// 이유(spec8 규칙 3): 예시 데이터 모드에서 견적·계약 → 서명 요청 → 링크 서명 → 서명본 → 거래 '계약'까지 서버 없이 같은 흐름이 돌아야 한다.
// 실제 경로(Supabase·api/esign)와 같은 규칙(인트라넷 sign route)을 이 저장소가 지키는지 흐름 전체로 잠근다.

const memKv = () => { const m = new Map(); return { m, get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); }, del: async (k) => { m.delete(k); } }; };
const blankPdf = async (pages = 3) => { const d = await PDFDocument.create(); for (let i = 0; i < pages; i++) d.addPage([595.28, 841.89]); return d.save(); };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const tokenOf = (link) => link.split('/sign/')[1];

const FONTS = { font: readFileSync(new URL('../public/fonts/Pretendard-Regular.ttf', import.meta.url)), bold: readFileSync(new URL('../public/fonts/Pretendard-Bold.ttf', import.meta.url)) };
function setup(now = '2026-10-02T03:00:00.000Z') {
  const kv = memKv();
  const confirmed = [];
  let clock = Date.parse(now);
  const ctl = { composeFails: 0 };
  const be = createSampleDocs({ kv, origin: () => 'http://localhost:5411', now: () => new Date(clock += 1000).toISOString(),
    compose: async (b) => { if (ctl.composeFails > 0) { ctl.composeFails--; throw new Error('compose timeout'); } return composeSignedPdf({ ...b, ...FONTS }); },
    confirmOrder: async (space, orderId, at) => { confirmed.push({ space, orderId, at }); return 'confirmed'; } });
  return { kv, be, confirmed, ctl, tick: (ms) => { clock += ms; } };
}
const hashOf = (b) => sha256Hex(b);

test('문서 보관: 만들면 목록에, PDF를 다시 받을 수 있고, 지우면 파일도 지워진다', async () => {
  const { be, kv } = setup();
  const pdf = await blankPdf(1);
  const row = await be.saveDoc('beyondworks', { kind: 'quote', title: '견적서 — 자동화', customer_name: '한빛', pdf, filename: '한빛_견적서.pdf', total: 1100 });
  assert.equal((await be.load('beyondworks')).docs.length, 1);
  assert.equal((await be.load('lean-studio')).docs.length, 0, '공간마다 따로');
  assert.deepEqual(await be.docPdf('beyondworks', row), pdf);
  await be.deleteDoc('beyondworks', row.id);
  assert.equal((await be.load('beyondworks')).docs.length, 0);
  assert.ok(![...kv.m.keys()].some((k) => k.includes(row.id)), '파일까지 지운다');
});

test('서명 흐름 전체: 초안 → 발송(토큰 해시만 저장) → 링크 확인(가린 이메일) → 다른 이메일 거절 → 열람 → 제출 → 전원 완료 시 서명본·완료 메일·거래 계약', async () => {
  const { be, kv, confirmed } = setup();
  const pdf = await blankPdf(3);
  const e = await be.createEsign('beyondworks', { title: '용역 계약서', orderId: 'order-1', pdf, docHash: await hashOf(pdf), signers: [{ name: '한빛', email: 'p@h.example' }], pages: 3 });
  assert.equal(e.status, 'draft'); assert.equal(e.signers.length, 1); assert.equal(e.signers[0].token_hash, undefined, '내부 값은 밖으로 안 나간다');
  const fields = [{ kind: 'signature', page: 2, xr: 0.3, yr: 0.6, wr: 0.15, hr: 0.05, signer_ord: 0 }, { kind: 'date', page: 2, xr: 0.3, yr: 0.7, wr: 0.15, hr: 0.03, signer_ord: 0 }, { kind: 'signature', page: 2, xr: 0.7, yr: 0.6, wr: 0.15, hr: 0.05, signer_ord: 1 }];
  const { esign, links } = await be.sendEsign('beyondworks', e.id, { signers: [{ name: '한빛', email: 'p@h.example' }, { name: '비욘드', email: 'me@b.example' }], fields });
  assert.equal(esign.status, 'sent'); assert.equal(links.length, 2);
  const raw = JSON.stringify(kv.m.get('argo-office-docs:sample'));
  for (const l of links) assert.ok(!raw.includes(tokenOf(l.link)), '링크 토큰 원문은 저장하지 않는다');
  await assert.rejects(be.sendEsign('beyondworks', e.id, { signers: [{ name: 'x', email: 'x@x.x' }], fields }), { code: 'sent' });

  const [a, b] = links.map((l) => tokenOf(l.link));
  assert.deepEqual(await be.publicState(a), { status: 'pending', maskedEmail: 'p**@h.example' });
  await assert.rejects(be.publicState('A'.repeat(43)), { code: 'invalid' });
  await assert.rejects(be.publicOpen(a, 'other@h.example'), { code: 'email' });
  const opened = await be.publicOpen(a, ' P@H.example ');
  assert.equal(opened.fields.length, 2, '자기 칸만'); assert.equal(opened.signer.ord, 0); assert.ok(opened.pdf.byteLength > 0);
  await be.publicOpen(a, 'p@h.example');
  assert.equal((await be.events('beyondworks', e.id)).filter((x) => x.action === 'opened').length, 1, '열람 기록은 10분에 한 번');

  await assert.rejects(be.publicSubmit(a, 'p@h.example', [{ page: 2, kind: 'text', text: '  ' }]), { code: 'empty' });
  const r1 = await be.publicSubmit(a, 'p@h.example', [{ page: 2, kind: 'signature', imgDataUrl: PNG, xr: 0.3, yr: 0.6, wr: 0.15 }, { page: 2, kind: 'text', text: '2026-10-02', xr: 0.3, yr: 0.7, wr: 0.15, sizeR: 0.015 }]);
  assert.deepEqual(r1, { done: false });
  await assert.rejects(be.publicSubmit(a, 'p@h.example', [{ page: 2, kind: 'text', text: 'again' }]), { code: 'already' });
  assert.equal(confirmed.length, 0, '한 명만 냈을 때는 완료 아님');

  const r2 = await be.publicSubmit(b, 'me@b.example', [{ page: 2, kind: 'signature', imgDataUrl: PNG, xr: 0.7, yr: 0.6, wr: 0.15 }]);
  assert.equal(r2.done, true);
  const final = await PDFDocument.load(r2.final);
  assert.equal(final.getPageCount(), 4, '원본 3쪽 + 감사 증명 1쪽');
  const after = (await be.load('beyondworks')).esign[0];
  assert.equal(after.status, 'completed'); assert.match(after.final_hash, /^[0-9a-f]{64}$/); assert.equal(after.order_sync, 'confirmed');
  assert.deepEqual(confirmed.map((c) => c.orderId), ['order-1']);
  const mails = await be.mails('beyondworks', e.id);
  assert.deepEqual(mails.filter((m) => m.kind === 'completed').map((m) => m.to).sort(), ['me@b.example', 'p@h.example']);
  assert.ok(mails.every((m) => m.subject === '[서명 완료] 용역 계약서' && m.attachment === '용역_계약서_서명본.pdf'));
  // 완료 뒤 링크 잠금(인트라넷: 완료 계약 접근 차단)
  assert.deepEqual(await be.publicState(a), { status: 'completed' });
  await assert.rejects(be.publicOpen(a, 'p@h.example'), { code: 'completed' });
  await assert.rejects(be.cancelEsign('beyondworks', e.id), { code: 'completed' });
  assert.deepEqual((await be.events('beyondworks', e.id)).map((x) => x.action), ['created', 'sent', 'opened', 'signed', 'signed', 'completed']);
});

test('취소·새 링크·삭제: 취소하면 링크로 서명 못 하고, 새 링크를 보내면 옛 링크가 끊기고, 지우면 파일·기록이 모두 지워진다', async () => {
  const { be, kv } = setup();
  const pdf = await blankPdf(1);
  const e = await be.createEsign('beyondworks', { title: '계약', pdf, docHash: await hashOf(pdf), pages: 1 });
  const { links } = await be.sendEsign('beyondworks', e.id, { signers: [{ name: 'A', email: 'a@x.example' }], fields: [{ kind: 'signature', page: 0, signer_ord: 0 }] });
  const old = tokenOf(links[0].link);
  const signer = (await be.load('beyondworks')).esign[0].signers[0];
  const fresh = await be.resend('beyondworks', e.id, signer.id);
  await assert.rejects(be.publicState(old), { code: 'invalid' }, '옛 링크는 끊긴다');
  assert.equal((await be.publicState(tokenOf(fresh.link))).status, 'pending');
  await be.cancelEsign('beyondworks', e.id);
  assert.deepEqual(await be.publicState(tokenOf(fresh.link)), { status: 'cancelled' });
  await assert.rejects(be.publicSubmit(tokenOf(fresh.link), 'a@x.example', [{ page: 0, kind: 'text', text: 'x' }]), { code: 'cancelled' });
  await be.deleteEsign('beyondworks', e.id);
  assert.equal((await be.load('beyondworks')).esign.length, 0);
  assert.ok(![...kv.m.keys()].some((k) => k.includes(e.id)), '원본 PDF도 지운다');
});

// 이유(분리 검수 HIGH·MEDIUM, 10/2): 서명 뒤 원본을 바꿔 끼우면 서명자가 본 것과 다른 문서에 서명이 얹힌다. 마지막 서명 뒤 마무리가 끊기면 영원히 '보냄'에 갇힌다.
test('원본 대조·마무리 재시도: 원본이 만들 때 해시와 다르면 서명본을 만들지 않고, 마무리가 끊기면 서명자 재제출·소유자 완료 다시 시도로 끝나며 그동안 취소는 막힌다', async () => {
  const { be, kv, ctl, confirmed } = setup();
  const pdf = await blankPdf(1);
  const e = await be.createEsign('beyondworks', { title: '계약', orderId: 'order-9', pdf, docHash: await hashOf(pdf), pages: 1 });
  const { links } = await be.sendEsign('beyondworks', e.id, { signers: [{ name: 'A', email: 'a@x.example' }], fields: [] });
  const tok = tokenOf(links[0].link);
  ctl.composeFails = 1;
  await assert.rejects(be.publicSubmit(tok, 'a@x.example', [{ page: 0, kind: 'signature', imgDataUrl: PNG, xr: 0.1, yr: 0.1, wr: 0.2 }]), /compose timeout/);
  const stuck = (await be.load('beyondworks')).esign[0];
  assert.equal(stuck.status, 'sent'); assert.equal(stuck.signers[0].status, 'signed');
  await assert.rejects(be.cancelEsign('beyondworks', e.id), { code: 'signed' }, '전원 서명 건은 취소하지 않는다');
  const again = await be.publicSubmit(tok, 'a@x.example', []);
  assert.equal(again.done, true, '서명자가 다시 내면 마무리만 이어서 한다');
  assert.equal((await be.load('beyondworks')).esign[0].status, 'completed');
  assert.deepEqual(confirmed.map((c) => c.orderId), ['order-9']);

  // 소유자 완료 다시 시도 + 원본 바꿔치기 거부
  const pdf2 = await blankPdf(2);
  const e2 = await be.createEsign('beyondworks', { title: '계약2', pdf: pdf2, docHash: await hashOf(pdf2), pages: 2 });
  const s2 = await be.sendEsign('beyondworks', e2.id, { signers: [{ name: 'B', email: 'b@x.example' }], fields: [] });
  await assert.rejects(be.finishEsign('beyondworks', e2.id), { code: 'state' }, '아직 서명 전이면 다시 시도할 것이 없다');
  ctl.composeFails = 1;
  await assert.rejects(be.publicSubmit(tokenOf(s2.links[0].link), 'b@x.example', [{ page: 0, kind: 'text', text: 'B' }]));
  await kv.set(`argo-office-docs-blob:beyondworks/esign/${e2.id}/orig.pdf`, await blankPdf(5)); // 바꿔 끼운 원본
  await assert.rejects(be.finishEsign('beyondworks', e2.id), { code: 'tampered' });
  assert.equal((await be.load('beyondworks')).esign.find((x) => x.id === e2.id).status, 'sent', '서명본을 만들지 않는다');
  await kv.set(`argo-office-docs-blob:beyondworks/esign/${e2.id}/orig.pdf`, pdf2);
  const fin = await be.finishEsign('beyondworks', e2.id);
  assert.equal((await PDFDocument.load(fin.final)).getPageCount(), 3, '원본 2쪽 + 감사 증명');
  assert.equal((await be.finishEsign('beyondworks', e2.id).catch((x) => x.code)), 'state', '완료 뒤에는 다시 할 것이 없다');
});

// 이유(분리 검수 MEDIUM, DB 전송량): 목록은 동작마다 다시 읽으므로 큰 칸(문서 입력값·칸 배치)은 열 때만 한 건씩 읽는다.
test('목록에는 입력값·칸 배치를 싣지 않고, getDoc·getEsign이 한 건 전체를 준다', async () => {
  const { be } = setup();
  const pdf = await blankPdf(1);
  const row = await be.saveDoc('beyondworks', { kind: 'quote', title: '견적', pdf, input: { party: { email: 'p@h.example' }, items: [{ name: 'x' }] } });
  const e = await be.createEsign('beyondworks', { title: '계약', pdf, docHash: await hashOf(pdf), fields: [{ kind: 'signature', page: 0, xr: 0.1, yr: 0.1, wr: 0.1, hr: 0.05, signer_ord: 0 }], pages: 1 });
  const list = await be.load('beyondworks');
  assert.equal(list.docs[0].input, undefined); assert.equal(list.esign[0].fields, undefined);
  assert.equal((await be.getDoc('beyondworks', row.id)).input.party.email, 'p@h.example');
  assert.equal((await be.getEsign('beyondworks', e.id)).fields.length, 1);
  await assert.rejects(be.getDoc('lean-studio', row.id), { code: 'not_found' }, '다른 공간 문서는 못 연다');
});

test('링크 기간: 30일이 지나면 열 수 없다', async () => {
  const { be, tick } = setup();
  const pdf = await blankPdf(1);
  const e = await be.createEsign('me', { title: '계약', pdf, docHash: await hashOf(pdf) });
  const { links } = await be.sendEsign('me', e.id, { signers: [{ name: 'A', email: 'a@x.example' }], fields: [] });
  tick(31 * 864e5);
  await assert.rejects(be.publicState(tokenOf(links[0].link)), { code: 'invalid' });
});

test('서명본 합성(크롬 없이 pdf-lib): 한글 글자가 빠지지 않는다 — 감사 페이지 글자를 다시 읽어 확인, 쓴 글자만 넣어 작다', async () => {
  const font = readFileSync(new URL('../public/fonts/Pretendard-Regular.ttf', import.meta.url));
  const bold = readFileSync(new URL('../public/fonts/Pretendard-Bold.ttf', import.meta.url));
  const out = await composeSignedPdf({ origPdf: await blankPdf(1), docHash: 'd'.repeat(64), title: '뷁 똠방각하 용역 계약서', font, bold, completedAt: '2026-10-02T03:00:00Z',
    signers: [{ ord: 0, name: '한빛코퍼레이션', email: 'p@h.example', signed_at: '2026-10-02T02:59:00Z', ip: '1.2.3.4', placements: [{ page: 0, kind: 'text', xr: 0.1, yr: 0.1, wr: 0.3, text: '2026-10-02 홍길동', sizeR: 0.02 }] }] });
  assert.ok(out.byteLength < 120_000, `subset로 작아야 한다(${out.byteLength}B) — 인트라넷은 2.5MB 글꼴을 통째로 넣었다`);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(out), isEvalSupported: false, useSystemFonts: false }).promise;
  const text = async (n) => (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str).join(' ');
  const audit = await text(2);
  for (const s of ['전자서명 완료 증명', '뷁 똠방각하 용역 계약서', '갑', '한빛코퍼레이션', '1.2.3.4', 'd'.repeat(64), '사설 전자서명']) assert.ok(audit.includes(s), `감사 페이지에 "${s}"`);
  assert.ok((await text(1)).includes('2026-10-02 홍길동'), '서명자가 넣은 글자');
  await doc.loadingTask.destroy();
});

test('예시 업무 원장: 견적 → 계약(서명 완료가 부르는 order.confirm) → 청구·입금, 거래 자료 붙이기, 보고 모양', async () => {
  const st = seedBusiness('beyondworks', Date.parse('2026-10-02T03:00:00Z'));
  const draft = st.orders.find((o) => o.status === 'draft');
  const amounts = () => dealAmounts(draft, st.lines, st.entries);
  assert.equal(dealStage(draft, amounts()), 'quote');
  applyBusiness(st, 'order.confirm', { id: draft.id, at: '2026-10-02T03:06:00Z' }, Date.parse('2026-10-02T03:07:00Z'));
  assert.equal(dealStage(draft, amounts()), 'contract');
  assert.throws(() => applyBusiness(st, 'order.confirm', { id: draft.id }), { message: 'business_order_state' });
  applyBusiness(st, 'link.add', { order_id: draft.id, kind: 'file', ref: 'office-doc:d1', title: '계약서 — 한빛' });
  assert.equal(st.links.at(-1).ref, 'office-doc:d1');
  applyBusiness(st, 'entry.create', { order_id: draft.id, kind: 'invoice', amount: amounts().total });
  assert.equal(dealStage(draft, amounts()), 'invoice');
  assert.throws(() => applyBusiness(st, 'entry.create', { order_id: draft.id, kind: 'payment', amount: amounts().total + 1 }), { message: 'business_amount_exceeds_balance' });
  applyBusiness(st, 'entry.create', { order_id: draft.id, kind: 'payment', amount: amounts().total });
  assert.equal(dealStage(draft, amounts()), 'paid');
  const rep = reportBusiness(st, { from: '2026-09-01', to: '2026-10-31' });
  assert.ok(rep.metrics.sales > 0 && Array.isArray(rep.daily) && Array.isArray(rep.orders) && Array.isArray(rep.mix) && Array.isArray(rep.sources));
  const c = applyBusiness(st, 'customer.save', { name: '새고객', biz_no: '000-00-00003' });
  const i = applyBusiness(st, 'item.save', { name: '새 서비스', kind: 'service', price: 10 });
  const o = applyBusiness(st, 'order.create', { title: '새 거래', customer_id: c.id, lines: [{ item_id: i.id, quantity: 2, unit_price: 10, tax_type: 'taxable' }] });
  assert.equal(st.lines.find((l) => l.order_id === o.id).vat, 2);
});

test('예시 업무 클라이언트: 화면이 쓰는 모양(subscribe·refresh·mutate·report), 저장소에 남아 다른 화면이 다시 읽는다', async () => {
  const store = new Map(); const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  globalThis.dispatchEvent ??= () => true;
  const c = createSampleBusinessClient({ storage, space: 'beyondworks' });
  let calls = 0; c.subscribe(() => { calls++; });
  const data = await c.refresh();
  assert.ok(data.can_write && data.customers.length === 3 && data.orders.length === 4);
  const draft = data.orders.find((o) => o.status === 'draft');
  await c.mutate('order.confirm', { id: draft.id });
  const again = createSampleBusinessClient({ storage, space: 'beyondworks' });
  assert.equal((await again.refresh()).orders.find((o) => o.id === draft.id).status, 'confirmed');
  await assert.rejects(c.mutate('nope', {}), { message: 'business_action' });
  assert.ok(calls >= 2);
  assert.deepEqual(await c.call('office_org_people'), []);
});
