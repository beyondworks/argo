// 맡기기 항목 글자 뽑기(17차 A-5) — 거래·거래처·일정·견적/계약·회사 정보. 이름표는 그 화면 사전 키라 가짜 t(키를 그대로 돌려줌)로 모양만 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fieldLines, customerText, CUSTOMER_FIELDS, dealText, spanText, eventText, quoteText, companyText, companyWithheld } from '../src/core/crew-items.js';

const t = (k) => k;
const money = (n) => `${n}원`;

test('이름표 줄: 빈 값·공백만인 값은 빼고 앞뒤 공백을 정리한다', () => {
  assert.equal(fieldLines([['이름', ' 루나 '], ['빈칸', ''], ['없음', null], ['공백', '  '], ['숫자', 0]]), '이름: 루나\n숫자: 0');
});

// 이유(유건 10/4 지시): 거래처는 이름·분류·메모·담당 연락처처럼 업무에 필요한 칸만 — 계좌·사업자번호는 사용자가 고른 항목이라도 싣지 않는다
test('거래처: 계좌·사업자번호는 값도 이름표도 들어가지 않는다, 담당 연락처·메모·관련 거래는 들어간다', () => {
  const c = { id: 'c1', name: '한빛', category: 'supplier', status: 'active', manager: '박지현', phone: '010-1111-2222', email: 'p@x.kr', notes: '금요일 회신 선호', account: '국민 123-456-789', biz_no: '123-45-67890', ceo: '김대표', address: '서울' };
  const data = { orders: [{ id: 'o1', customer_id: 'c1', title: '10월 납품', status: 'draft' }, { id: 'o2', customer_id: 'c1', title: '취소 건', status: 'cancelled' }, { id: 'o3', customer_id: 'c2', title: '남의 거래' }] };
  const text = customerText(c, data, t);
  for (const secret of ['123-456-789', '123-45-67890', 'bizui.account', 'bizui.biz_no']) assert.ok(!text.includes(secret), `${secret}가 들어가면 안 된다`);
  assert.ok(!CUSTOMER_FIELDS.includes('account') && !CUSTOMER_FIELDS.includes('biz_no'));
  assert.match(text, /bizui\.manager: 박지현\nbizui\.phone: 010-1111-2222\nbizui\.email: p@x\.kr/);
  assert.match(text, /bizui\.category: bizui\.category\.supplier/);
  assert.match(text, /bizui\.notes:\n금요일 회신 선호/);
  assert.match(text, /bizui\.card\.deals:\n- 10월 납품$/, '취소한 거래·남의 거래는 빠진다');
  assert.equal(customerText({ id: 'c9', name: '빈' }, {}, t), 'bizui.category: bizui.category.customer\nbizui.customerStatus: bizui.status.active', '칸이 비면 분류·상태만(기본값)');
});

test('거래: 거래처·단계·입금 예정일·금액, 이 거래의 품목·메모만(다른 거래·메모 아닌 자료는 빠진다)', () => {
  const data = {
    customers: [{ id: 'c1', name: '한빛' }],
    lines: [{ order_id: 'o1', name: '유지보수', quantity: 2, unit_price: 100 }, { order_id: 'o2', name: '남의 품목', quantity: 1, unit_price: 1 }],
    links: [{ order_id: 'o1', kind: 'note', body: ' 금요일까지 ' }, { order_id: 'o1', kind: 'page', ref: 'p1' }, { order_id: 'o2', kind: 'note', body: '남의 메모' }],
  };
  const amounts = { supply: 200, vat: 20, total: 220, paid: 0, receivable: 220 };
  const text = dealText({ id: 'o1', customer_id: 'c1', title: '10월', due_on: '2026-10-31' }, data, { t, money, amounts, stage: 'contract' });
  assert.match(text, /^bizui\.customer: 한빛\nbizui\.status: bizui\.stage\.contract\nbizui\.dueOn: 2026-10-31\nbizui\.supply: 200원/);
  assert.match(text, /bizui\.receivable: 220원/);
  assert.match(text, /bizui\.line:\n- 유지보수 × 2 \(100원\)$/m);
  assert.match(text, /bizui\.notes:\n- 금요일까지$/);
  assert.ok(!text.includes('남의'));
  assert.match(dealText({ id: 'o1', customer_id: 'c1' }, data, { t, money, amounts, stage: 'cancelled' }), /bizui\.status: bizui\.cancelled/);
});

test('일정 시작·끝 글자: 종일 하루는 끝을 비우고, 여러 날·시간 일정은 끝을 적는다(같은 날이면 시각만)', () => {
  const f = { day: (d) => `D${d}`, time: (ms) => `T${ms}`, allDay: '종일' };
  assert.deepEqual(spanText({ allDay: true, day: '2026-10-05', last: '2026-10-05' }, f), { start: 'D2026-10-05 (종일)', end: '' });
  assert.deepEqual(spanText({ allDay: true, day: '2026-10-05', last: '2026-10-07' }, f), { start: 'D2026-10-05 (종일)', end: 'D2026-10-07' });
  assert.deepEqual(spanText({ allDay: false, day: '2026-10-05', last: '2026-10-05', start: 1, end: 2 }, f), { start: 'D2026-10-05 T1', end: 'T2' });
  assert.deepEqual(spanText({ allDay: false, day: '2026-10-05', last: '2026-10-06', start: 1, end: 2 }, f), { start: 'D2026-10-05 T1', end: 'D2026-10-06 T2' });
});

test('일정: 시작·끝·장소·분류·거래처, 메모는 다음 줄 — 빈 칸은 빠진다', () => {
  const text = eventText({ location: '3층', category: '', customer_name: '한빛', note: '자료 준비' }, { t, start: 'S', end: '' });
  assert.equal(text, 'cal.f.start: S\ncal.f.location: 3층\ncal.f.customer: 한빛\n\ncal.f.note:\n자료 준비');
});

test('견적·계약: 종류·거래처·거래·합계·만든 날, 없는 칸은 빠진다', () => {
  assert.equal(quoteText({ kind: 'quote', customer_name: '한빛', total: 1000, created_at: '2026-10-01T00:00:00Z' }, { t, money, deal: '', day: () => '10/1' }),
    'docs.col.kind: docs.kind.quote\ndocs.col.customer: 한빛\ndocs.col.total: 1000원\ndocs.col.created: 10/1');
});

// 이유: 회사 정보도 거래처와 같은 기준 — 계좌(은행 분류)·사업자번호는 값을 싣지 않고, 도장·로고 그림(data 주소)은 글자가 아니라 뺀다
test('회사 정보: 계좌·사업자번호·그림은 이름과 안내만, 나머지는 "이름: 값"과 메모', () => {
  const items = [
    { label: '대표 전화', value: '02-123-4567', category: 'contact', notes: '평일 9~6시' },
    { label: '주거래 계좌', value: '신한 110-000-000000', category: 'bank' },
    { label: '사업자등록번호', value: '123-45-67890', category: 'basic', key: 'biz_no' },
    { label: '도장', value: 'data:image/png;base64,AAAA', category: 'basic', key: 'seal' },
  ];
  assert.deepEqual(items.map(companyWithheld), [false, true, true, true]);
  const text = companyText(items, t);
  assert.equal(text, '대표 전화: 02-123-4567\n  평일 9~6시\n주거래 계좌: company.crewWithheld\n사업자등록번호: company.crewWithheld\n도장: company.crewWithheld');
  for (const secret of ['110-000-000000', '123-45-67890', 'base64']) assert.ok(!text.includes(secret));
});

// 이유: key가 없는 항목(이관에서 같은 칸이 두 번 나오면 뒤엣것의 key를 비운다)·https 도장·계좌 메모·'기타'의 입금 계좌로 값이 새어 나갔다(17차 A 검수 MEDIUM-2)
test('회사 정보: key가 없어도 이름표로 판정하고, 빼는 항목은 메모도 뺀다 — 웹사이트 주소는 그대로', () => {
  const items = [
    { label: '사업자등록번호', value: '123-45-67890', category: 'basic' },
    { label: '도장', value: 'https://example.com/seal.png', category: 'basic', key: 'seal' },
    { label: '주거래 계좌', value: '국민 999-888', category: 'bank', notes: '예금주 홍길동 / 국민 999-888' },
    { label: '입금 계좌', value: '우리 1002-000', category: 'other' },
    { label: '법인등록번호', value: '110111-0000000', category: 'basic', key: 'corp_no' },
    { label: '홈페이지', value: 'https://beyondworks.example', category: 'contact', key: 'website' },
  ];
  assert.deepEqual(items.map(companyWithheld), [true, true, true, true, true, false]);
  const text = companyText(items, t);
  for (const secret of ['123-45-67890', 'seal.png', '999-888', '홍길동', '1002-000', '110111-0000000']) assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('홈페이지: https://beyondworks.example'));
});

// 이유: 일정은 지금 보는 공간이 아니라 그 일정의 조직으로 맡긴다 — 내 공간·홈에서 A 조직 일정이 B 조직 크루에게 갈 수 있었다(17차 A 검수 MEDIUM-1)
test('일정 맡기기 공간: 일정의 조직 공간, 개인 일정은 내 공간, 조직이 섞이거나 모르는 조직이면 맡기지 않는다', async () => {
  const { assignSpace } = await import('../src/core/crew-items.js');
  const spaceOf = (id) => ({ 'org-a': { key: 'a' }, 'org-b': { key: 'b' } })[id];
  assert.equal(assignSpace(['org-a'], spaceOf), 'a');
  assert.equal(assignSpace([null], spaceOf), 'me');
  assert.equal(assignSpace(['org-a', 'org-a'], spaceOf), 'a');
  assert.equal(assignSpace(['org-a', 'org-b'], spaceOf), null);
  assert.equal(assignSpace(['org-a', null], spaceOf), null);
  assert.equal(assignSpace(['org-x'], spaceOf), null);
  assert.equal(assignSpace([], spaceOf), null);
  const board = readFileSync(new URL('../src/views/Board.jsx', import.meta.url), 'utf8');
  assert.ok(!/assign: \{ space, items: \[eventAssign/.test(board) && !/assign: \{ space, items: events\.map/.test(board), '일정 맡기기가 지금 보는 공간(space)을 쓰지 않는다');
});
