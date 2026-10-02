import test from 'node:test';
import assert from 'node:assert/strict';
import { maskEmail, normalizeFields, normalizePlacements, cleanSigners, draftSigners, checkSend, newToken, sha256Hex, tokenOk, partyLabel, signedFilename, signLink } from '../src/docs/esign-model.js';
import { detectFields, autoFields } from '../src/docs/detect.js';
import { parseBizCert } from '../src/docs/bizcert.js';
import { signRequestMail, signCompletedMail } from '../src/docs/esign-mail.js';

// 이유(spec8 트랙 A): 인트라넷 lib/esign·app/api/esign의 검사(이메일 확인·필드·제출 정규화·토큰)와 자동 서명란 감지를 그대로 지키는지.

test('이메일 가리기(인트라넷 sign route:16-21), 갑·을·병 라벨', () => {
  assert.equal(maskEmail('sj.park@hanbit.example'), 'sj*****@hanbit.example');
  assert.equal(maskEmail('a@x.com'), 'a**@x.com');
  assert.equal(maskEmail('nope'), '***');
  assert.deepEqual([0, 1, 2, 5].map(partyLabel), ['갑', '을', '병', '제6자']);
});

test('필드 정규화(인트라넷 contracts route:44-56): 종류·쪽 확인, 좌표 0~1, 크기 하한, 서명자 순번 0 이상', () => {
  const f = normalizeFields([{ kind: 'signature', page: 0, xr: -1, yr: 2, wr: 0.001, hr: 9, signer_ord: -3 }, { kind: 'stamp', page: 0 }, { kind: 'text', page: 1.5 }, { kind: 'date', page: 4 }], 3);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0], { id: 'fd0', signer_ord: 0, page: 0, xr: 0, yr: 1, wr: 0.02, hr: 1, kind: 'signature', required: true });
});

test('제출 정규화(인트라넷 sign route:89-106): 글자 1000자·크기 범위, 그림은 png/jpg data URL만, 빈 글자·없는 쪽은 버린다', () => {
  const p = normalizePlacements([
    { page: 0, kind: 'text', xr: 0.1, yr: 0.1, wr: 0.3, text: 'x'.repeat(1200), sizeR: 1 },
    { page: 0, kind: 'text', text: '   ' },
    { page: 0, kind: 'signature', imgDataUrl: 'data:image/png;base64,AAAA', xr: 0.5, yr: 0.5, wr: 0.2 },
    { page: 0, kind: 'signature', imgDataUrl: 'data:image/svg+xml;base64,AAAA' },
    { page: 9, kind: 'text', text: '쪽 없음' },
  ], 2);
  assert.equal(p.length, 2);
  assert.equal(p[0].text.length, 1000); assert.equal(p[0].sizeR, 0.1);
  assert.deepEqual(p[1].img, { type: 'png', data: 'AAAA' });
});

test('서명자: 이름·이메일 둘 다, 이메일 중복 없음, 5명까지 · 견적·계약 화면 초안(인트라넷 esign/send route:33-40)', () => {
  assert.deepEqual(cleanSigners([{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'A@x.com' }, { name: '', email: 'c@x.com' }, { name: 'D', email: 'bad' }]), [{ name: 'A', email: 'a@x.com' }]);
  const co = { name: '비욘드웍스', email: 'me@b.example' };
  assert.deepEqual(draftSigners({ clientCompany: '한빛', clientEmail: 'p@h.x', company: co }), [{ name: '한빛', email: 'p@h.x' }, { name: '비욘드웍스', email: 'me@b.example' }]);
  assert.deepEqual(draftSigners({ clientCompany: '한빛', clientEmail: '', company: co }), [], '갑 이메일이 없으면 빈 초안 — 을 단독이 갑으로 오인되지 않게');
  assert.deepEqual(draftSigners({ clientCompany: '한빛', clientEmail: 'p@h.x', company: co, sealed: true }), [{ name: '한빛', email: 'p@h.x' }], '을 도장을 찍었으면 갑만');
});

test('발송 검사(인트라넷 new/page.tsx:147-153, send route:16-21): 상태·PDF·서명자·필드, 서명자 밖 필드는 뺀다, 서명란 없는 서명자는 알림만', () => {
  const signers = [{ name: 'A', email: 'a@x.com' }, { name: '', email: '' }];
  const fields = [{ signer_ord: 0, kind: 'signature' }, { signer_ord: 1, kind: 'signature' }];
  assert.equal(checkSend({ hasPdf: true, signers, fields, status: 'sent' }).error, 'esign.err.sent');
  assert.equal(checkSend({ hasPdf: false, signers, fields }).error, 'esign.err.pdf');
  assert.equal(checkSend({ hasPdf: true, signers: [], fields }).error, 'esign.err.signers');
  assert.equal(checkSend({ hasPdf: true, signers, fields: [{ signer_ord: 1, kind: 'text' }] }).error, 'esign.err.fields');
  const ok = checkSend({ hasPdf: true, signers, fields });
  assert.equal(ok.error, null); assert.equal(ok.fields.length, 1); assert.equal(ok.warn, null);
  assert.equal(checkSend({ hasPdf: true, signers, fields: [{ signer_ord: 0, kind: 'date' }] }).warn, 'esign.warn.signerField');
});

test('토큰: 32바이트 무작위(base64url 43자), 해시는 SHA-256 16진 64자 — DB에는 해시만', async () => {
  const a = newToken(), b = newToken();
  assert.notEqual(a, b); assert.ok(tokenOk(a)); assert.equal(a.length, 43);
  assert.match(await sha256Hex(a), /^[0-9a-f]{64}$/);
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.ok(!tokenOk('short')); assert.ok(!tokenOk('a/b'.repeat(20)));
  assert.equal(signLink('https://office.example/', a), `https://office.example/sign/${a}`);
  assert.equal(signedFilename('한빛 계약서/1'), '한빛_계약서_1_서명본.pdf');
});

const item = (page, str, xr, yr, wr = 0.06, hr = 0.012) => ({ page, str, xr, yr, wr, hr });
test('자동 서명란(인트라넷 autofields.ts): "(서명 또는 인)" 왼쪽 열 = 갑·오른쪽 = 을, 본문 긴 문장은 제외, "계약일자" 줄은 인쇄된 빈칸 뒤 날짜 칸', () => {
  const items = [
    item(2, '본 계약은 계약서 2부를 작성하여 갑과 을이 각각 서명 또는 날인 후 1부씩 보관한다.', 0.1, 0.4, 0.8),
    item(2, '이한빛          (서명 또는 인)', 0.2, 0.6, 0.2),
    item(2, '김유건          (서명 또는 인)', 0.6, 0.6, 0.2),
    item(2, '계약일자', 0.09, 0.68, 0.05),
    item(2, '2026년   월   일', 0.2, 0.68, 0.1),
    item(0, '(계약 체결 시 기입)', 0.3, 0.2, 0.12),
    item(1, '서명: ________', 0.1, 0.5, 0.2),
  ];
  const f = autoFields(items);
  const sig = f.filter((x) => x.kind === 'signature' && x.page === 2);
  assert.equal(sig.length, 2, '본문 문장 속 "서명 또는 날인"은 서명란이 아니다');
  assert.deepEqual(sig.map((x) => x.signer_ord).sort(), [0, 1]);
  const date = f.find((x) => x.kind === 'date');
  // 유건 10/2 13차: 인쇄된 "2026년   월   일" 자리를 덮어 날짜로 채운다(옆에 큰 날짜를 따로 찍지 않는다) — 빈칸 글자 전체를 덮고, 높이는 글자 높이 × 1.4
  assert.ok(date.xr <= 0.2 && date.xr + date.wr >= 0.3, '빈칸 글자 자리를 덮는다');
  assert.ok(Math.abs(date.hr - 0.012 * 1.4) < 1e-9, '칸 높이 = 서식 글자 높이 × 1.4');
  assert.equal(date.signer_ord, 0, '날짜 칸 서명자는 라벨 자리(왼쪽) 기준');
  assert.ok(f.some((x) => x.kind === 'text' && x.page === 0), '"(계약 체결 시 기입)"은 기입란');
  assert.ok(f.every((x) => x.xr >= 0 && x.xr <= 1 && x.wr >= 0.02));
  assert.deepEqual(f.map((x) => x.id), f.map((_, i) => `fd${i}`));
  const d = detectFields([item(0, '________', 0.1, 0.1, 0.2), item(0, '(인)', 0.5, 0.1, 0.02)]);
  assert.deepEqual(d.map((x) => x.kind).sort(), ['signature', 'text']);
});

test('사업자등록증 글자 → 갑 칸(인트라넷 bizcert.ts): 번호·상호·대표자·소재지, 한 줄로 이어진 라벨도 잘라 낸다, 길이 제한', () => {
  const ocr = '사업자등록증\n(법인사업자)\n등록번호 : 000-00-10001\n법인명(단체명) : 주식회사 한빛\n상 호 : 주식회사 한빛\n대 표 자 : 이한빛\n사업장 소재지 : 서울특별시 강남구 예시대로 100, 5층\n';
  assert.deepEqual(parseBizCert(ocr), { company: '주식회사 한빛', bizNo: '000-00-10001', ceo: '이한빛', address: '서울특별시 강남구 예시대로 100, 5층' });
  const pdfLine = '등록번호 000 00 10002 상호 오름테크 성명 정오름 생년월일 1980-01-01\n사업장소재지 경기도 성남시 예시로 20 업태 정보통신업';
  const r = parseBizCert(pdfLine);
  assert.equal(r.company, '오름테크'); assert.equal(r.ceo, '정오름'); assert.equal(r.bizNo, '000-00-10002'); assert.equal(r.address, '경기도 성남시 예시로 20');
  assert.equal(parseBizCert('등록번호 : 000-00-20001\n법인명(단체명) : 주식회사 새벽마켓\n대 표 자 : 최새벽').company, '주식회사 새벽마켓', '법인 등록증');
  assert.deepEqual(parseBizCert('상호\n' + '가'.repeat(41)), { company: undefined, bizNo: undefined, ceo: undefined, address: undefined });
});

test('서명 메일 문구(인트라넷 mail.ts): 제목 "[서명 요청] …"·"[서명 완료] …", 글자 본문에도 링크, HTML 이스케이프, 갑/을 표', () => {
  const m = signRequestMail({ name: '박서준', title: '용역 <계약서>', link: 'https://o/sign/T', company: '비욘드웍스' });
  assert.equal(m.subject, '[서명 요청] 용역 <계약서>');
  assert.match(m.text, /https:\/\/o\/sign\/T/); assert.match(m.text, /비욘드웍스에서/);
  assert.match(m.html, /용역 &lt;계약서&gt;/); assert.match(m.html, /서명하러 가기/);
  const c = signCompletedMail({ title: '계약', signers: [{ ord: 0, name: '한빛', email: 'a@x' }, { ord: 1, name: '비욘드', email: 'b@x' }] });
  assert.equal(c.subject, '[서명 완료] 계약');
  assert.match(c.html, /갑<\/td>[\s\S]*한빛 &lt;a@x&gt;[\s\S]*을<\/td>/);
  assert.match(c.text, /갑  한빛 <a@x>\n을  비욘드 <b@x>/);
});
