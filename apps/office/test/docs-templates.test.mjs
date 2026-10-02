import test from 'node:test';
import assert from 'node:assert/strict';
import { renderQuoteHtml, renderContractHtml, BLANK_TEXT } from '../src/docs/templates.js';
import { quoteInput, contractInput, emptyDoc } from '../src/docs/model.js';
import { normalizeCompany, SAMPLE_COMPANY } from '../src/docs/company-model.js';

// 이유(spec8): 오피스 PDF는 인트라넷 서식(lib/docgen/quote.ts·contract.ts)의 쪽 구성·문구·표를 그대로 따르고, 회사 값만 회사 정보에서 읽는다.
const co = normalizeCompany(SAMPLE_COMPANY.beyondworks);
const items = (n) => Array.from({ length: n }, (_, i) => ({ name: `항목${i + 1}`, desc: i === 0 ? '설명' : '', unitPrice: '1000', qty: '1' }));
const pages = (html) => (html.match(/<div class="page"/g) ?? []).length;
const quote = (n, extra = {}) => renderQuoteHtml(quoteInput({ ...emptyDoc('quote', '2026-10-02'), customer: '한빛', title: '자동화', summary: '요약', items: items(n), ...extra }), co);

test('견적서 쪽 나누기(인트라넷 quote.ts:3-9): 1장 공급자, 내역 7행씩, 합계는 마지막 조각에만, 마지막 장 진행 조건·비고', () => {
  assert.equal(pages(quote(7)), 3);
  const h = quote(8);
  assert.equal(pages(h), 4);
  assert.match(h, /견적 내역 \(1\/2\)/); assert.match(h, /견적 내역 \(2\/2\)/);
  assert.equal((h.match(/공급가액 소계/g) ?? []).length, 1);
  assert.ok(h.indexOf('공급가액 소계') > h.indexOf('견적 내역 (2/2)'), '합계는 마지막 조각 뒤');
  assert.match(h, /한빛 · 4 \/ 4/, '푸터 = 고객사 · n / N');
  assert.match(h, /QUOTATION/);
});

test('견적서 문구: 제목·부제·공급자 7행·담당자 3행은 회사 정보에서, 비고 자동 문구(부가세 별도·유효기간), 유효기간 끄면 생략', () => {
  const h = quote(1);
  assert.match(h, /견적서 — 자동화/); assert.match(h, /작성일 2026-10-02 · 수신: 한빛 \(요약\)/);
  assert.match(h, /<td>상호<\/td><td>비욘드웍스 \(등록명: 주식회사 비욘드웍스\)<\/td>/);
  assert.match(h, /<td>사업자등록번호<\/td><td>000-00-00001<\/td>/);
  for (const k of ['대표자', '사업장 소재지', '개업일 / 사업자등록일', '업태', '종목', '담당자', '연락처', '이메일']) assert.match(h, new RegExp(`<td>${k}</td>`));
  assert.match(h, /상기 금액은 부가가치세\(10%\) 별도 산정 기준입니다/);
  assert.match(h, /유효기간은 발행일로부터 2주\(2026-10-16\)/);
  assert.match(h, /세부 진행 조건은 협의 후 확정합니다/, '진행 조건이 없으면 기본 문구');
  assert.doesNotMatch(quote(1, { showValid: false }), /유효기간은/);
  assert.doesNotMatch(h, /AI 개발단|392-11-02790|고승현/, '인트라넷 회사 값이 남아 있지 않다');
});

test('견적서 표: 원 표기·숫자 줄바꿈 금지, 옵션 표(원/인), 과세가 아닌 줄이 있으면 "부가세"로', () => {
  const h = quote(1, { option: { title: '교육 옵션', rows: [{ name: '추가 인원', unitPrice: '50000', condition: '1인당' }] } });
  assert.match(h, /<td class="num">1,000원<\/td>/);
  assert.match(h, /th\.num, td\.num \{ text-align: right; white-space: nowrap; \}/);
  assert.match(h, /교육 옵션[\s\S]*50,000원\/인[\s\S]*1인당/);
  assert.match(h, /부가세 \(10%\)/);
  const ex = renderQuoteHtml(quoteInput({ ...emptyDoc('quote'), customer: 'x', items: [{ name: 'a', unitPrice: 1, qty: 1, taxType: 'exempt' }] }), co);
  assert.match(ex, /<td colspan="3">부가세<\/td>/);
});

test('이스케이프: 입력 칸의 태그는 글자로', () => {
  const h = quote(1, { customer: '<script>x</script>', title: 'a & "b"' });
  assert.doesNotMatch(h, /<script>x/); assert.match(h, /&lt;script&gt;/); assert.match(h, /a &amp; &quot;b&quot;/);
});

const contract = (extra = {}, opts) => renderContractHtml(contractInput({ ...emptyDoc('contract', '2026-10-02'), customer: '주식회사 한빛', items: items(2), scope: '범위1\n범위2', ...extra }), co, opts);

test('계약서 3쪽 고정(인트라넷 contract.ts): 전문·당사자 표·제1~13조·서명표·비고, 을은 회사 정보', () => {
  const h = contract();
  assert.equal(pages(h), 3);
  for (let n = 1; n <= 13; n++) assert.match(h, new RegExp(`제${n}조 \\(`));
  assert.match(h, /"주식회사 한빛"\(이하 "갑"이라 한다\)과 "비욘드웍스"\(이하 "을"이라 한다\)은 본 용역\(이하 "본 용역"\)/);
  assert.match(h, /<td>담당자 \/ 연락처<\/td><td>[\s\S]*?<\/td><td>김유건 \/ 02-000-0000 \/ yoogeon@beyondworks\.example<\/td>/);
  assert.match(h, /계약금액 합계/); assert.match(h, /CONTRACT/); assert.match(h, /3 \/ 3/);
  assert.match(h, /<li>범위1<\/li>[\s\S]*<li>범위2<\/li>/);
  assert.match(h, /2026년 &nbsp;&nbsp;월 &nbsp;&nbsp;일/);
  assert.match(h, /김유건&nbsp;[\s\S]*\(서명 또는 인\)/);
});

test('계약서 빈 갑 칸은 "계약 체결 시 사업자등록증 확인 후 기입"(회색), 채운 칸은 값', () => {
  const h = contract();
  assert.equal((h.match(new RegExp(BLANK_TEXT, 'g')) ?? []).length, 4, '사업자번호·대표자·주소·담당자');
  const filled = contract({ party: { company: '한빛', bizNo: '000-00-10001', ceo: '이한빛', address: '서울', contact: '박 / 010', email: '' } });
  assert.doesNotMatch(filled, new RegExp(BLANK_TEXT));
  assert.match(filled, /이한빛&nbsp;/);
});

test('계약서 조항 선택: 분할/완납 지급, 착수 기준 자동, 용역형/납품형 지재권, 옵션이 있으면 2쪽 맨 위', () => {
  assert.match(contract(), /분할 지급한다: 착수금 50%\(계약 체결 시\), 잔금 50%/);
  assert.match(contract(), /착수일은 착수금 지급일로/);
  const full = contract({ payment: 'full', ip: 'product' });
  assert.match(full, /일시에 100% 지급한다/); assert.match(full, /착수일은 계약 체결일로/);
  assert.match(full, /제8조 \(지적재산권 및 사용권\)/); assert.match(full, /비독점적 사용권/);
  assert.match(contract({ startBasis: '10월 5일' }), /착수일은 10월 5일로/);
  const opt = contract({ option: { title: '교육 옵션', rows: [{ name: 'x', unitPrice: 1, condition: '' }] } });
  assert.match(opt, /<h2 class="section" style="margin-top:0">교육 옵션<\/h2>[\s\S]*<h2 class="section">제4조/);
  assert.match(contract(), /<h2 class="section" style="margin-top:0">제4조/);
  assert.match(contract({ note: '별첨 기준' }), /· 별첨 기준<br>/);
});

test('회사 도장: 올린 PNG가 있고 고르면 을 대표자 칸에 그 그림, 도장이 없거나 안 고르면 없음 — 예시 회사도 기본은 도장 없음(유건 10/2 13차)', () => {
  assert.equal(co.seal, '', '코드가 그린 예시 도장은 없다');
  assert.doesNotMatch(contract({}, { sealSupplier: true }), /class="seal"/, '도장이 없으면 찍을 것도 없다');
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.match(renderContractHtml(contractInput({ ...emptyDoc('contract'), customer: 'x', items: items(1) }), { ...co, seal: png }, { sealSupplier: true }), /<img class="seal" src="data:image\/png;base64,iVBORw0KGgo="/);
  assert.doesNotMatch(contract(), /class="seal"/);
  assert.doesNotMatch(renderContractHtml(contractInput({ ...emptyDoc('contract'), customer: 'x', items: items(1) }), { ...co, seal: '' }, { sealSupplier: true }), /class="seal"/);
});

test('로고: 회사 로고가 있으면 그림(어두운 배너에서 흰색), 없으면 회사 이름 글자', () => {
  assert.match(quote(1), /<span class="logo-text">비욘드웍스<\/span>/);
  const withLogo = renderQuoteHtml(quoteInput({ ...emptyDoc('quote'), customer: 'x', items: items(1) }), { ...co, logo: 'https://x.test/l.png' });
  assert.match(withLogo, /<img src="https:\/\/x\.test\/l\.png" alt="비욘드웍스" crossorigin="anonymous">/);
  assert.match(withLogo, /filter: brightness\(0\) invert\(1\)/);
});
