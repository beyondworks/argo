import test from 'node:test';
import assert from 'node:assert/strict';
import { docTotals, validateDoc, emptyDoc, quoteInput, contractInput, docTitle, docFilename, fromDeal, quoteToContract, applyBizcert, matchCustomer, dealPlan, won, isoDay, cleanItems } from '../src/docs/model.js';
import { normalizeCompany, fromProfile, SAMPLE_COMPANY } from '../src/docs/company-model.js';

// 이유(spec8 트랙 A): 인트라넷 견적·계약 폼의 규칙(필수 칸·기본값·금액)을 오피스가 그대로 지키는지, 그리고 거래에서 바로 채우는 길이 맞는지.

test('합계: 공급가액 = 단가×수량, 부가세는 줄마다 과세 10% 원 미만 절사(오피스 장부와 같다), 영세·면세는 0', () => {
  const t = docTotals([{ name: 'A', unitPrice: '3000000', qty: '1' }, { name: 'B', unitPrice: '800000', qty: '2' }, { name: '', unitPrice: '999', qty: '9' }]);
  assert.deepEqual(t, { supply: 4_600_000, vat: 460_000, total: 5_060_000, allTaxable: true });
  const mixed = docTotals([{ name: 'A', unitPrice: 15, qty: 1 }, { name: 'B', unitPrice: 1000, qty: 1, taxType: 'exempt' }]);
  assert.equal(mixed.vat, 1, '15원의 10%는 1원(절사)');
  assert.equal(mixed.allTaxable, false);
  assert.equal(won(3000000), '3,000,000');
});

test('검증: 고객사·항목 필수(인트라넷 page.tsx:86-87·159-160), 갑 이메일 형식, 금액 범위', () => {
  const q = emptyDoc('quote', '2026-10-02');
  assert.deepEqual(validateDoc(q), ['docs.err.customer', 'docs.err.items']);
  assert.deepEqual(validateDoc({ ...emptyDoc('contract'), customer: '' }), ['docs.err.customerA', 'docs.err.contractItems']);
  assert.deepEqual(validateDoc({ ...q, customer: '한빛', items: [{ name: 'A', unitPrice: 1, qty: 1 }] }), []);
  const c = { ...emptyDoc('contract'), customer: '한빛', items: [{ name: 'A', unitPrice: 1, qty: 1 }] };
  assert.deepEqual(validateDoc({ ...c, party: { ...c.party, email: 'nope' } }), ['docs.err.email']);
  assert.deepEqual(validateDoc({ ...q, customer: 'x', items: [{ name: 'A', unitPrice: 2e12, qty: 1 }] }), ['docs.err.amount']);
});

test('견적서 값: 빈 제목은 고객사, 유효기간 기본 +14일, 끄면 빈 값(서식에서 문구 생략), 줄바꿈 칸은 목록으로', () => {
  const doc = { ...emptyDoc('quote', '2026-10-02'), customer: '한빛', items: [{ name: 'A', desc: ' 설명 ', unitPrice: '10', qty: '2' }], terms: '첫째\n\n 둘째 ', notes: '' };
  const q = quoteInput(doc);
  assert.equal(q.title, '한빛');
  assert.equal(q.validUntil, '2026-10-16');
  assert.deepEqual(q.terms, ['첫째', '둘째']);
  assert.deepEqual(q.items, [{ name: 'A', desc: '설명', unitPrice: 10, qty: 2, taxType: 'taxable' }]);
  assert.equal(quoteInput({ ...doc, showValid: false }).validUntil, '');
  assert.equal(q.option, null, '이름 없는 옵션 줄만 있으면 옵션 표를 그리지 않는다');
});

test('계약서 기본값(인트라넷 page.tsx:166-175): 제목 "<고객사> 용역 계약서", 용역 요약 "본 용역", 목적은 요약, 갑 상호 = 고객사, 산출물 "산출물", 지급·지재권 기본', () => {
  const c = contractInput({ ...emptyDoc('contract'), customer: '주식회사 한빛', payment: 'weird', ip: 'x' });
  assert.equal(c.title, '주식회사 한빛 용역 계약서');
  assert.equal(c.serviceSummary, '본 용역');
  assert.equal(c.purpose, '본 용역');
  assert.equal(c.party.company, '주식회사 한빛');
  assert.equal(c.deliverable, '산출물');
  assert.equal(c.payment, 'split');
  assert.equal(c.ip, 'service');
});

test('제목·파일명: "견적서 — 제목", "<고객사>_견적서.pdf"(안전 문자만 — 인트라넷 sanitize)', () => {
  assert.equal(docTitle({ kind: 'quote', title: '', customer: '한빛' }), '견적서 — 한빛');
  assert.equal(docTitle({ ...emptyDoc('contract'), customer: '한빛' }), '계약서 — 한빛 용역 계약서');
  assert.equal(docFilename({ kind: 'contract', customer: '(주) 한빛/코리아' }), '_주__한빛_코리아_계약서.pdf');
});

test('거래에서 바로: 거래처 칸(대표자·사업자번호·주소·담당자/연락처·이메일)과 거래 줄(반품 뺀 수량·과세)이 채워지고 거래·거래처가 이어진다', () => {
  const order = { id: 'o1', customer_id: 'c1', title: '한빛 자동화' };
  const customer = { id: 'c1', name: '한빛', ceo: '이한빛', biz_no: '000-00-10001', address: '서울', manager: '박서준', phone: '010', email: 'p@h.x' };
  const lines = [{ order_id: 'o1', name: '구축', unit_price: 3000000, quantity: 2, returned: 1, tax_type: 'zero' }, { order_id: 'o2', name: '남의 줄', unit_price: 1, quantity: 1 }];
  const c = fromDeal('contract', { order, customer, lines }, '2026-10-02');
  assert.equal(c.orderId, 'o1'); assert.equal(c.customerId, 'c1'); assert.equal(c.customer, '한빛');
  assert.deepEqual(c.items, [{ name: '구축', desc: '', unitPrice: '3000000', qty: '1', taxType: 'zero' }]);
  assert.deepEqual(c.party, { company: '한빛', bizNo: '000-00-10001', ceo: '이한빛', address: '서울', contact: '박서준 / 010', email: 'p@h.x' });
  const q = fromDeal('quote', { order, customer, lines });
  assert.equal(q.validUntil.length, 10);
  assert.equal(q.party, undefined);
});

test('견적서 → 계약서 이어 쓰기: 거래처·거래·항목·옵션을 그대로 넘긴다', () => {
  const quote = { ...emptyDoc('quote'), customer: '한빛', customerId: 'c1', orderId: 'o1', title: '자동화', items: [{ name: 'A', unitPrice: '1', qty: '1', taxType: 'taxable' }], option: { title: '옵션', rows: [{ name: '교육', unitPrice: '1', condition: '' }] } };
  const c = quoteToContract(quote);
  assert.equal(c.kind, 'contract'); assert.equal(c.customerId, 'c1'); assert.equal(c.orderId, 'o1'); assert.equal(c.serviceSummary, '자동화');
  assert.deepEqual(c.items, quote.items); assert.notEqual(c.items[0], quote.items[0], '복사본');
  assert.equal(c.party.company, '한빛');
});

test('사업자등록증 값: 읽은 칸만 바꾸고(빈 값은 그대로 — 인트라넷 page.tsx:151), 고객사가 비어 있으면 상호로', () => {
  const doc = { ...emptyDoc('contract'), party: { company: '옛', bizNo: '', ceo: '사람', address: '', contact: '', email: '' } };
  const next = applyBizcert(doc, { company: '새 상호', bizNo: '000-00-00000' });
  assert.equal(next.party.company, '새 상호'); assert.equal(next.party.ceo, '사람'); assert.equal(next.party.bizNo, '000-00-00000'); assert.equal(next.customer, '새 상호');
});

test('거래처 찾기(인트라넷 save.ts:9-19): 정확 일치 우선, 부분 일치는 1건일 때만, 애매하면 연결하지 않는다', () => {
  const list = [{ id: 1, name: '한빛코퍼레이션' }, { id: 2, name: '한빛' }, { id: 3, name: '오름' }, { id: 4, name: '오름테크' }];
  assert.equal(matchCustomer('한빛', list).id, 2);
  assert.equal(matchCustomer('한빛코퍼레이션 ', list).id, 1);
  assert.equal(matchCustomer('오름테', list), null, '오름·오름테크 둘 다 걸리면 애매');
  assert.equal(matchCustomer('코퍼레이션', list).id, 1);
  assert.equal(matchCustomer('름', list), null);
  assert.equal(matchCustomer('', list), null);
});

test('견적서로 거래 등록 계획: 있는 거래처·같은 이름 상품은 잇고, 없으면 새 거래처·새 서비스(단가 그대로)', () => {
  const doc = { ...emptyDoc('quote'), customer: '새고객', title: '', items: [{ name: 'AI 구축', unitPrice: '100', qty: '0' }, { name: '처음 보는 항목', unitPrice: '50', qty: '3', taxType: 'exempt' }] };
  const plan = dealPlan(doc, { customers: [{ id: 'c1', name: '한빛' }], items: [{ id: 'i1', name: 'AI 구축' }] });
  assert.equal(plan.customer_id, null); assert.deepEqual(plan.newCustomer, { name: '새고객' }); assert.equal(plan.title, '새고객 견적');
  assert.deepEqual(plan.lines[0], { name: 'AI 구축', item_id: 'i1', newItem: null, quantity: 1, unit_price: 100, tax_type: 'taxable' });
  assert.deepEqual(plan.lines[1].newItem, { name: '처음 보는 항목', kind: 'service', price: 50 });
  assert.equal(dealPlan({ ...doc, customer: '한빛' }, { customers: [{ id: 'c1', name: '한빛' }], items: [] }).customer_id, 'c1');
  assert.equal(cleanItems([{ name: ' ' }]).length, 0);
});

test('회사 정보: 어떤 원본이 와도 서식 모양(빈 칸은 빈 문자열), 그림 주소는 data:image·https만, 트랙 C 모양도 읽는다', () => {
  const c = normalizeCompany({ name: ' 비욘드 ', logo: 'javascript:alert(1)', seal: 'data:image/png;base64,AA', bank: null }, '공간');
  assert.equal(c.name, '비욘드'); assert.equal(c.legalName, '비욘드'); assert.equal(c.logo, ''); assert.equal(c.seal, 'data:image/png;base64,AA');
  assert.deepEqual(c.bank, { name: '', account: '', holder: '' });
  assert.equal(normalizeCompany(null, '공간 이름').name, '공간 이름');
  const p = fromProfile({ name: '(주)비욘드웍스(예시)', regName: '주식회사 비욘드웍스', bizNo: '1', ceo: '김', accounts: [{ label: '국민', value: '123' }], seal: 'data:image/webp;base64,AA' });
  const n = normalizeCompany(p);
  assert.equal(n.legalName, '주식회사 비욘드웍스'); assert.deepEqual(n.bank, { name: '국민', account: '123', holder: '' }); assert.equal(n.seal, 'data:image/webp;base64,AA');
  assert.ok(SAMPLE_COMPANY.beyondworks.bizNo.startsWith('000-'), '예시 회사 번호는 가상');
  assert.equal(isoDay(1, new Date('2026-12-31T12:00:00')), '2027-01-01');
});
