import test from 'node:test';
import assert from 'node:assert/strict';
import { sealFileOk, isPngHead } from '../src/core/company-model.js';
import { SAMPLE_COMPANY } from '../src/docs/company-model.js';
import { normalizePlacements, koDate, draftSigners } from '../src/docs/esign-model.js';
import { signRequestMail } from '../src/docs/esign-mail.js';

// 이유(유건 10/2 13차 "도장 기본값은 직접 png 파일로 업로드 해서 사용하도록 하자")
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
test('도장 파일: 종류와 내용(첫 8바이트) 모두 PNG여야 — 확장자만 바꾼 JPG·SVG는 거절', () => {
  assert.equal(sealFileOk({ type: 'image/png', head: Uint8Array.from(PNG) }), true);
  assert.equal(sealFileOk({ type: 'image/jpeg', head: Uint8Array.from(PNG) }), false, 'JPG 종류');
  assert.equal(sealFileOk({ type: 'image/svg+xml', head: new TextEncoder().encode('<svg xml') }), false, 'SVG');
  assert.equal(sealFileOk({ type: 'image/png', head: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]) }), false, '이름·종류만 png인 JPG 내용');
  assert.equal(sealFileOk({ type: 'image/png', head: new Uint8Array(3) }), false, '잘린 파일');
  assert.equal(isPngHead(null), false);
});

test('예시 회사도 기본은 도장 없음 — 도장이 없으면 을(우리 회사)도 서명자로 들어간다', () => {
  for (const sp of Object.values(SAMPLE_COMPANY)) assert.equal(sp.seal, '');
  const company = { name: '(주)비욘드웍스', email: 'contact@beyondworks.example' };
  assert.equal(draftSigners({ clientCompany: '한빛', clientEmail: 'client@example.com', company, sealed: false }).length, 2);
  assert.equal(draftSigners({ clientCompany: '한빛', clientEmail: 'client@example.com', company, sealed: true }).length, 1, '도장을 찍으면 갑만');
});

test('계약일자: 인쇄된 빈칸을 덮는 표시(cover)가 서명 기록에 남고, 글자는 "2026년 10월 2일" 모양', () => {
  assert.equal(koDate(new Date(2026, 9, 2)), '2026년 10월 2일');
  const [p] = normalizePlacements([{ page: 0, kind: 'text', xr: 0.2, yr: 0.6, wr: 0.2, text: '2026년 10월 2일', sizeR: 0.012, cover: true }]);
  assert.equal(p.cover, true);
  const [q] = normalizePlacements([{ page: 0, kind: 'text', xr: 0.2, yr: 0.6, wr: 0.2, text: '메모', cover: 'yes' }]);
  assert.equal(q.cover, undefined, '참·거짓만 받는다');
});

test('서명 요청 메일: 받는 사람이 우리 회사면 내부용 첫 줄(이름 겹침 없음), 거래처면 기존 문구', () => {
  const base = { name: '(주)비욘드웍스', title: '한빛 용역 계약서', link: 'https://o.example/sign/x', company: '(주)비욘드웍스' };
  const ext = signRequestMail(base), inn = signRequestMail({ ...base, internal: true }), en = signRequestMail({ ...base, internal: true, lang: 'en' });
  assert.match(ext.text.split('\n')[0], /^\(주\)비욘드웍스님, \(주\)비욘드웍스에서/);
  assert.equal(inn.text.split('\n')[0], '우리 회사 서명 차례입니다 — "한빛 용역 계약서" 계약서에 서명해 주세요.');
  assert.ok(!/님,/.test(inn.text) && inn.text.includes(base.link) && inn.subject === '[서명 요청] 한빛 용역 계약서');
  assert.match(en.text, /^Our company's turn to sign/); assert.ok(en.html.includes(base.link));
});

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { composeSignedPdf } from '../src/docs/pdf/compose.js';
test('서명본 합성: 계약일자(cover)는 흰 바탕으로 빈칸 안내를 덮고 그 위에 날짜 — cover가 없으면 덮지 않는다', async () => {
  const blank = await PDFDocument.create(); blank.addPage([595.28, 841.89]); const orig = await blank.save({ useObjectStreams: false });
  const font = readFileSync(new URL('../public/fonts/Pretendard-Regular.ttf', import.meta.url));
  const run = async (cover) => {
    const out = await composeSignedPdf({ origPdf: orig, docHash: 'a'.repeat(64), title: '계약', font, completedAt: '2026-10-02T03:00:00Z',
      signers: [{ ord: 0, name: '갑', email: 'a@x.example', signed_at: '2026-10-02T02:00:00Z', ip: 'local', placements: [{ page: 0, kind: 'text', xr: 0.2, yr: 0.6, wr: 0.2, text: '2026년 10월 2일', sizeR: 0.012, cover }] }] });
    const doc = await PDFDocument.load(out);
    const page = doc.getPages()[0];
    const c = page.node.Contents();
    return (c.asArray ? c.asArray() : [c]).map((r) => { const s = doc.context.lookup(r); const raw = Buffer.from(s.contents); try { return inflateSync(raw).toString('latin1'); } catch { return raw.toString('latin1'); } }).join('\n');
  };
  assert.match(await run(true), /1 1 1 rg[\s\S]*re[\s\S]*f/, '흰 사각형을 먼저 칠한다');
  assert.doesNotMatch(await run(false), /1 1 1 rg/);
});
