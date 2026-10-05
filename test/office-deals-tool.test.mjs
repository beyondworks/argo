// 에이전트 거래처·거래 도구(office_deals) — 오피스 17차 B-7(PARITY-customers T1~T3·T5~T7): 인트라넷 customers_*·deals_*를 오피스로.
// DB 함수는 가짜 세션 클라이언트로 대신한다(라이브 DB 호출 0). 권한·범위는 회사·문서함 도구와 같다 — 메신저 조직 채널의 그 조직, 주인의 기기 세션, 손님 턴 거절.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from './helpers/tmp.mjs';

process.env.ARGO_ROOT = join(await mkdtemp(join(tmpdir(), 'argo-deals-tool-')), 'workspaces'); await mkdir(process.env.ARGO_ROOT, { recursive: true });
process.env.ARGO_MODEL_CATALOG = 'off';

const { makeCrewServer } = await import('../src/chat.mjs');
const { crewToolSpecs, ensureRequired } = await import('../src/engine/native-query.mjs');
const { dealsTool, dealsDeps, dealsDescription, similar, dealAmounts, dealStage } = await import('../src/gateway/office-deals.mjs');
const { createCompany } = await import('../src/workspace.mjs');

const ME = 'owner-uid', ORG = '11111111-1111-4111-8111-111111111111';
const real = { ...dealsDeps };
after(() => Object.assign(dealsDeps, real));
const msgrCtx = (extra = {}) => ({ kind: 'msgr', chatType: 'group', channelKind: 'public', orgId: ORG, channelId: 'ch-1', crewId: 'crew-1', uid: ME, wsId: 'w', origin: ME, ...extra });
const DM = () => msgrCtx({ channelKind: 'dm', channelId: 'dm-1' });
const PRIV = (extra = {}) => msgrCtx({ channelKind: 'private', channelId: 'pv-1', ...extra });
const C1 = 'c1111111-1111-4111-8111-111111111111', C2 = 'c2222222-2222-4222-8222-222222222222', C3 = 'c3333333-3333-4333-8333-333333333333', C4 = 'c4444444-4444-4444-8444-444444444444';
const at = (d) => `${d}T03:00:00Z`;
const data = () => ({
  customers: [
    { id: C1, name: '한빛상사', category: 'customer', status: 'active', manager: '김민수', phone: '010-1234-5678', email: 'kim@hanbit.kr', ceo: '이대표', biz_no: '123-45-67890', address: '서울', account: '국민 111-222', notes: '첫 거래', redacted: ['phone'], version: 3, archived_at: null },
    { id: C2, name: '넥스트필드', category: 'partner', status: 'active', manager: '', phone: '', email: '', ceo: '', biz_no: '', address: '', account: '', notes: '', redacted: [], version: 1, archived_at: null },
    { id: C3, name: '옛거래처', category: 'customer', status: 'closed', manager: '', phone: '', email: '', ceo: '', biz_no: '', address: '', account: '', notes: '', redacted: [], version: 1, archived_at: at('2026-09-01') },
    { id: C4, name: '(거래처 미지정)', category: 'other', status: 'active', manager: '', phone: '', email: '', ceo: '', biz_no: '', address: '', account: '', notes: '', redacted: [], version: 1, archived_at: null },
  ],
  items: [{ id: 'i1', name: '웹사이트 제작', kind: 'service', price: 3000000 }],
  orders: [
    { id: 'o1', customer_id: C1, title: '웹사이트 리뉴얼', status: 'draft', created_at: at('2026-09-20'), confirmed_at: null, due_on: null, redacted: [] },
    { id: 'o2', customer_id: C1, title: '유지보수 10월', status: 'confirmed', created_at: at('2026-09-10'), confirmed_at: at('2026-09-11'), due_on: '2026-09-30', redacted: [] },
    { id: 'o3', customer_id: C2, title: '제품 촬영', status: 'confirmed', created_at: at('2026-09-12'), confirmed_at: at('2026-09-13'), due_on: null, redacted: ['amount'] },
    { id: 'o4', customer_id: C2, title: '납품 완료 건', status: 'confirmed', created_at: at('2026-08-01'), confirmed_at: at('2026-08-02'), due_on: '2026-08-31', redacted: [] },
    { id: 'o5', customer_id: C4, title: '랜딩 페이지 제작', status: 'draft', created_at: at('2026-07-01'), confirmed_at: null, due_on: null, redacted: [] },
    { id: 'o6', customer_id: C1, title: '취소된 건', status: 'cancelled', created_at: at('2026-06-01'), confirmed_at: null, due_on: null, redacted: [] },
  ],
  lines: [
    { id: 'l1', order_id: 'o1', item_id: 'i1', quantity: 1, returned: 0, unit_price: 3000000, vat: 300000 },
    { id: 'l2', order_id: 'o2', item_id: 'i1', quantity: 1, returned: 0, unit_price: 1000000, vat: 100000 },
    { id: 'l3', order_id: 'o3', item_id: 'i1', quantity: 1, returned: 0, unit_price: 1000000, vat: 100000 },
    { id: 'l4', order_id: 'o4', item_id: 'i1', quantity: 1, returned: 0, unit_price: 1000000, vat: 100000 },
    { id: 'l5', order_id: 'o5', item_id: 'i1', quantity: 2, returned: 0, unit_price: 500000, vat: 100000 },
  ],
  entries: [
    { order_id: 'o3', kind: 'invoice', amount: 550000 },
    { order_id: 'o4', kind: 'invoice', amount: 1100000 }, { order_id: 'o4', kind: 'payment', amount: 1100000 },
  ],
});
function table(rows) {
  const q = { f: [], select() { return q; }, eq(k, v) { q.f.push((r) => r[k] === v); return q; }, in(k, vs) { q.f.push((r) => vs.includes(r[k])); return q; },
    then(ok, no) { return Promise.resolve({ data: rows.filter((r) => q.f.every((x) => x(r))), error: null }).then(ok, no); } };
  return q;
}
function fake({ members = { 'dm-1': [ME], 'pv-1': [ME, 'g1'] }, roles = { [ME]: 'owner', g1: 'guest' }, error = null } = {}) {
  const calls = []; let n = 0;
  const client = {
    from: (t) => {
      if (t === 'msgr_channel_members') return table(Object.entries(members).flatMap(([ch, ids]) => ids.map((id) => ({ channel_id: ch, member_kind: 'user', member_id: id }))));
      if (t === 'msgr_org_members') return table(Object.entries(roles).map(([id, role]) => ({ org_id: ORG, user_id: id, role, removed_at: null })));
      return table([]);
    },
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === 'office_business_read') return { data: data(), error: null };
      if (name === 'office_business_write') {
        if (error) return { data: null, error: { message: error } };
        const id = args.p_data.id ?? { 'customer.save': 'new-customer', 'item.save': 'new-item', 'order.create': 'new-order' }[args.p_action] ?? args.p_data.order_id;
        return { data: { id }, error: null };
      }
      return { data: null, error: { message: 'unknown' } };
    },
  };
  Object.assign(dealsDeps, { session: async () => ({ client, uid: ME }), now: () => Date.parse('2026-10-04T03:00:00Z'), newId: () => `key-${++n}` });
  return calls;
}
const run = (args, opts = {}) => dealsTool(args, { ctx: msgrCtx(), lang: 'ko', ownerId: ME, ...opts });
const writes = (calls) => calls.filter((c) => c.name === 'office_business_write');

test('D1. 메신저 조직 채널이 아니거나·위임 턴·주인 아닌 로그인·손님이 있는 방이면 거절(오피스 호출 없음)', async () => {
  const calls = fake();
  assert.match(await run({ action: 'customers' }, { ctx: null }), /조직 채널/);
  assert.match(await run({ action: 'customers' }, { ctx: { kind: 'msgr-rules' } }), /위임 턴/);
  assert.match(await run({ action: 'customers' }, { ownerId: 'someone' }), /주인의 계정이 아니라/);
  assert.match(await run({ action: 'customers' }, { ctx: PRIV() }), /손님/);
  assert.equal(calls.length, 0);
});

test('D2(T1). customers: 보관함 빼고 검색(이름·담당·메일·전화·사업자번호), 여럿이 보는 방에서는 계좌·가림 칸을 싣지 않는다, id를 주면 자세히(거래 포함)', async () => {
  const calls = fake();
  const out = await run({ action: 'customers' });
  assert.equal(calls[0].args.p_org, ORG);
  assert.match(out, /한빛상사 · 고객 · 활성 · 담당 김민수 · 전화 \(가림 — 주인과의 1:1 대화에서만\) · 메일 kim@hanbit\.kr · 사업자번호 \(가림 — 주인과의 1:1 대화에서만\) · 거래 2건 · id=c111/);
  assert.doesNotMatch(out, /옛거래처|010-1234|67890/);
  assert.match(await run({ action: 'customers', archived: true }), /옛거래처 · 고객 · 종료 · 거래 0건 · 보관함/);
  assert.match(await run({ action: 'customers', q: 'hanbit' }), /한빛상사/);
  assert.match(await run({ action: 'customers', q: '없는곳' }), /없다/);
  const detail = await run({ action: 'customers', id: C1 });
  assert.match(detail, /계좌 \(가림/); assert.doesNotMatch(detail, /국민 111/);
  assert.match(detail, /메모: 첫 거래/); assert.match(detail, /받은 돈 0원 · 진행 중 4,400,000원/);
  assert.match(detail, /\[견적\] 웹사이트 리뉴얼[\s\S]*\[계약\] 유지보수 10월[\s\S]*\[취소\] 취소된 건/, '최근 견적순');
  const dm = await run({ action: 'customers', id: C1 }, { ctx: DM() });
  assert.match(dm, /계좌 국민 111-222/); assert.match(dm, /전화 010-1234-5678/); assert.match(dm, /사업자번호 123-45-67890/);
});

test('D2b(2차 LOW-3). 여럿이 보는 방에서는 가린 칸(계좌·사업자번호·가림 표시한 칸)을 검색 대상에서도 뺀다 — 1:1에서는 찾는다', async () => {
  fake();
  for (const q of ['5678', '010-1234', '67890', '123-45', '국민']) {
    assert.match(await run({ action: 'customers', q }), /없다/, `여럿이 보는 방: ${q}로 가린 값을 떠보지 못한다`);
    if (q !== '국민') assert.match(await run({ action: 'customers', q }, { ctx: DM() }), /한빛상사/, `1:1: ${q}`);
  }
  assert.match(await run({ action: 'customers', q: '김민수' }), /한빛상사/, '가리지 않은 칸은 그대로 찾는다');
});

test('D3(T2). customer_add: 새 거래처는 id 없이(서버가 정함), 비슷한 이름은 만들지 않고 알려 주며, 계좌는 1:1에서만', async () => {
  let calls = fake();
  assert.match(await run({ action: 'customer_add', name: ' 한빛 상사 ', phone: '02-1' }), /비슷한 거래처가 이미 있다[\s\S]*한빛상사/);
  assert.match(await run({ action: 'customer_add', name: '새회사', biz_no: '9998887776' }, { ctx: DM() }), /추가했다/); // 사업자번호가 다른 곳과 겹치지 않으면 만든다
  calls = fake();
  assert.match(await run({ action: 'customer_add', name: '다른이름', biz_no: '123-45-67890' }, { ctx: DM() }), /비슷한 거래처/, '사업자번호가 같으면 같은 곳일 수 있다');
  assert.match(await run({ action: 'customer_add', name: '새회사', account: '신한 1' }), /계좌은\(는\) 주인과의 1:1/);
  assert.match(await run({ action: 'customer_add', name: '새회사', biz_no: '111-22-33333' }), /사업자번호은\(는\) 주인과의 1:1/, '새 거래처에서 가려지는 칸은 1:1에서만 넣는다(가린 값으로 중복을 떠보지도 못한다)');
  assert.match(await run({ action: 'customer_add', name: '새회사', biz_no: 'abc' }), /숫자와 하이픈/);
  assert.match(await run({ action: 'customer_add' }), /name/);
  assert.equal(writes(calls).length, 0, '거절은 쓰지 않는다');
  const out = await run({ action: 'customer_add', name: '한빛상사', manager: '박과장', category: 'supplier', notes: '명함(2026-10-04)', confirm_duplicate: true });
  const w = writes(calls)[0].args;
  assert.equal(w.p_action, 'customer.save'); assert.equal(w.p_org, ORG); assert.equal(w.p_key, 'key-1');
  assert.ok(!('id' in w.p_data), 'id를 주면 서버가 고치기로 읽는다');
  assert.deepEqual([w.p_data.name, w.p_data.manager, w.p_data.category, w.p_data.status, w.p_data.notes, w.p_data.phone], ['한빛상사', '박과장', 'supplier', 'active', '명함(2026-10-04)', '']);
  assert.deepEqual(w.p_data.redacted, ['account', 'biz_no'], '2차 MEDIUM-1: 새 거래처는 계좌·사업자번호를 가린 채로(오피스 화면·이관과 같은 기본 가림)');
  assert.match(out, /추가했다: 한빛상사 · 공급사 \(id=new-customer\)/);
});

test('D4(T3). customer_set: 읽고 합쳐 쓴다 — 준 칸만 바꾸고 빈 값은 무시(빈 칸으로 덮지 않는다), 메모는 덧붙이고, 버전을 함께 보낸다', async () => {
  const calls = fake();
  const out = await run({ action: 'customer_set', id: C1, email: 'new@hanbit.kr', manager: '', ceo: '   ', notes: '출처: 계약서' });
  const w = writes(calls)[0].args.p_data;
  assert.deepEqual(w, { id: C1, version: 3, name: '한빛상사', manager: '김민수', phone: '010-1234-5678', email: 'new@hanbit.kr', ceo: '이대표', biz_no: '123-45-67890', address: '서울', account: '국민 111-222', category: 'customer', status: 'active', notes: '첫 거래\n출처: 계약서' });
  assert.match(out, /고쳤다\(메일·메모 · id=[^)]+\):\n--- 바깥 글 시작[^\n]*\n한빛상사\n--- 바깥 글 끝 /, '거래처 이름은 읽어 온 남의 글 — 확인 문장에서는 경계 블록 안에(검수 M2)');
  assert.match(await run({ action: 'customer_set', id: C1, email: 'kim@hanbit.kr', manager: '' }), /바꿀 것이 없다/);
  assert.match(await run({ action: 'customer_set', id: C1, phone: '010-0000-0000' }), /전화은\(는\) 주인과의 1:1/, '가림 표시한 칸은 1:1에서만 고친다');
  assert.match(await run({ action: 'customer_set', id: C1, account: '신한 9' }), /계좌/);
  assert.match(await run({ action: 'customer_set', id: C1, category: 'weird' }), /category/);
  assert.match(await run({ action: 'customer_set', id: 'nope' }), /없다/);
  assert.equal(writes(calls).length, 1, '그 뒤의 거절·같은 값은 쓰지 않는다');
  await run({ action: 'customer_set', id: C1, phone: '010-0000-0000' }, { ctx: DM() });
  assert.equal(writes(calls).at(-1).args.p_data.phone, '010-0000-0000');
});

test('D5(T5). deals: 단계는 장부에서 계산, 기본은 취소 빼고 최근 견적순, 입금 지연 일수, 가림 표시한 금액은 여럿이 보는 방에 싣지 않는다', async () => {
  fake();
  const out = await run({ action: 'deals' });
  assert.match(out, /\[견적\] 웹사이트 리뉴얼 · 한빛상사 · 합계 3,300,000원\(공급 3,000,000원·부가세 300,000원\) · 청구 0원 · 입금 0원 · 견적일 2026-09-20 · id=o1/);
  assert.match(out, /\[계약\] 유지보수 10월 · .* · 입금 예정 2026-09-30\(입금 지연 4일\)/);
  assert.match(out, /\[계산서 발행\] 제품 촬영 · 넥스트필드 · 금액 \(가림/); assert.doesNotMatch(out, /550,000/);
  assert.match(out, /\[입금 완료\] 납품 완료 건 .* 입금 예정 2026-08-31 · /, '입금 완료는 지연으로 세지 않는다');
  assert.doesNotMatch(out, /취소된 건/);
  assert.ok(out.indexOf('id=o1') < out.indexOf('id=o2'), '최근 견적순');
  assert.match(await run({ action: 'deals' }, { ctx: DM() }), /제품 촬영 .* 청구 550,000원/);
  assert.match(await run({ action: 'deals', overdue: true }), /^(?![\s\S]*id=o1)[\s\S]*id=o2/);
  assert.match(await run({ action: 'deals', stage: 'open', customer_id: C2 }), /^(?![\s\S]*id=o4)[\s\S]*id=o3/);
  assert.match(await run({ action: 'deals', stage: 'cancelled' }), /취소된 건/);
});

test('D6(T6). deal_add: 같은 거래처(또는 거래처 미지정)에 비슷한 건명이 있으면 쓰지 않고 후보를 보여 준다, 확인하면 품목을 찾아 쓰고 없으면 만든다', async () => {
  let calls = fake();
  const dup = await run({ action: 'deal_add', title: '웹사이트 리뉴얼 2차', customer_id: C1, lines: [{ item: '웹사이트 제작', unit_price: 1000000 }] });
  assert.match(dup, /비슷한 건명의 거래가 이미 있어 등록하지 않았다[\s\S]*웹사이트 리뉴얼 · 한빛상사/);
  assert.match(await run({ action: 'deal_add', title: '랜딩페이지 제작', customer_id: C2, lines: [{ item: 'x', unit_price: 1 }] }), /랜딩 페이지 제작 · \(거래처 미지정\)/, '이관의 거래처 미지정 거래도 함께 본다');
  assert.match(await run({ action: 'deal_add', title: '새 건', customer_id: C3, lines: [{ item: 'x', unit_price: 1 }] }), /보관한 거래처/);
  assert.match(await run({ action: 'deal_add', title: '새 건', customer_id: C1, lines: [{ item: 'x', unit_price: 10.5 }] }), /정수/);
  assert.match(await run({ action: 'deal_add', title: '새 건', customer_id: C1, lines: [] }), /lines/);
  assert.match(await run({ action: 'deal_add', title: '새 건', customer_id: C1, lines: [{ item: 'x', unit_price: 1 }], due_on: '2026-13-01' }), /YYYY-MM-DD/);
  assert.equal(writes(calls).length, 0, '거절·중복 안내는 쓰지 않는다');
  const out = await run({ action: 'deal_add', title: '웹사이트 리뉴얼 2차', customer_id: C1, due_on: '2026-11-10', date: '2026-10-03', confirm_duplicate: true,
    lines: [{ item: ' 웹사이트  제작 ', unit_price: 1000000 }, { item: '사진 촬영', unit_price: 200000, quantity: 3, tax_type: 'exempt' }] });
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['item.save', 'order.create'], '없는 품목만 새로 만든다');
  assert.deepEqual(writes(calls)[0].args.p_data, { name: '사진 촬영', kind: 'service', sku: '', price: 200000 });
  assert.deepEqual(writes(calls)[1].args.p_data, { title: '웹사이트 리뉴얼 2차', customer_id: C1, due_on: '2026-11-10', at: '2026-10-03',
    lines: [{ item_id: 'i1', quantity: 1, unit_price: 1000000, tax_type: 'taxable' }, { item_id: 'new-item', quantity: 3, unit_price: 200000, tax_type: 'exempt' }] });
  assert.match(out, /견적 단계로 등록했다 — 합계 1,700,000원\(부가세 포함\) · 입금 예정 2026-11-10 \(id=new-order\) · 건명 · 거래처:\n--- 바깥 글 시작[^\n]*\n웹사이트 리뉴얼 2차 · 한빛상사\n--- 바깥 글 끝 [^\n]*\n새 품목을 만들었다: 사진 촬영/);
  calls = fake();
  assert.match(await run({ action: 'deal_add', title: '전혀 다른 일', customer_id: C1, lines: [{ item: 'i1', unit_price: 5 }] }), /등록했다/);
  assert.deepEqual(writes(calls).map((c) => c.args.p_action), ['order.create']);
});

test('D7(T7). deal_next: 오피스 단추처럼 한 단계 = 장부 기록 하나, 단계가 맞지 않으면 쓰지 않는다', async () => {
  const calls = fake();
  assert.match(await run({ action: 'deal_next', id: 'o1', to: 'contract', date: '2026-10-02' }), /계약으로 넘겼다/);
  assert.deepEqual(writes(calls).at(-1).args, { p_org: ORG, p_key: 'key-1', p_action: 'order.confirm', p_data: { id: 'o1', at: '2026-10-02', note: '' } });
  assert.match(await run({ action: 'deal_next', id: 'o1', to: 'invoice' }), /먼저 to=contract/);
  assert.match(await run({ action: 'deal_next', id: 'o2', to: 'paid' }), /먼저 to=invoice/);
  assert.match(await run({ action: 'deal_next', id: 'o2', to: 'invoice' }), /계산서 발행을 기록했다\(1,100,000원\)/);
  assert.deepEqual(writes(calls).at(-1).args.p_data, { order_id: 'o2', kind: 'invoice', amount: 1100000, note: '' });
  assert.match(await run({ action: 'deal_next', id: 'o2', to: 'invoice', amount: 2000000 }), /남은 금액보다 크다/);
  assert.match(await run({ action: 'deal_next', id: 'o3', to: 'paid' }), /입금을 기록했다\(\(가림/, '가림 표시한 금액은 결과에도 싣지 않는다');
  assert.equal(writes(calls).at(-1).args.p_data.amount, 550000, '받을 돈 = 청구 - 입금');
  assert.match(await run({ action: 'deal_next', id: 'o3', to: 'invoice', amount: 100000 }), /계산서 발행을 기록했다/, '남은 청구가 있으면 더 청구할 수 있다');
  assert.match(await run({ action: 'deal_next', id: 'o4', to: 'cancel' }), /입금 전/);
  assert.match(await run({ action: 'deal_next', id: 'o4', to: 'paid' }), /넘길 수 없다/);
  assert.match(await run({ action: 'deal_next', id: 'o2', to: 'cancel', note: '고객 사정' }), /취소했다/);
  assert.deepEqual(writes(calls).at(-1).args.p_data, { id: 'o2', note: '고객 사정' });
  const n = writes(calls).length;
  assert.match(await run({ action: 'deal_next', id: 'o1' }), /to\(/);
  assert.match(await run({ action: 'deal_next', id: 'o1', to: 'contract', date: '2026/10/02' }), /YYYY-MM-DD/);
  assert.match(await run({ action: 'deal_next', id: 'nope', to: 'contract' }), /거래 id/);
  assert.equal(writes(calls).length, n);
});

test('D8. deal_due: 입금 예정일 정하기(order.update), 같은 날짜면 쓰지 않고 none은 지우기, 서버 거절은 원인을 한 줄로', async () => {
  let calls = fake();
  assert.match(await run({ action: 'deal_due', id: 'o1', due_on: '2026-10-31' }), /2026-10-31로 정했다\. 거래 건명:\n--- 바깥 글 시작[^\n]*\n웹사이트 리뉴얼[^\n]*\n--- 바깥 글 끝 /);
  assert.deepEqual(writes(calls).at(-1).args.p_data, { id: 'o1', due_on: '2026-10-31' });
  assert.match(await run({ action: 'deal_due', id: 'o2', due_on: '2026-09-30' }), /이미 그/);
  assert.match(await run({ action: 'deal_due', id: 'o2', due_on: 'none' }), /지웠다/);
  assert.deepEqual(writes(calls).at(-1).args.p_data, { id: 'o2', due_on: null });
  assert.match(await run({ action: 'deal_due', id: 'o2', due_on: '' }), /YYYY-MM-DD/, '빈 값으로 지우지 않는다');
  calls = fake({ error: 'business_forbidden' });
  assert.match(await run({ action: 'deal_due', id: 'o1', due_on: '2026-10-31' }), /오피스 서버 거절: 권한이 없다\(거래처·거래 쓰기는 조직 관리자만/);
});

test('D7b(2차 LOW-4). 계약 확정 뒤에는 견적으로 되돌려도 금액을 고칠 수 없다는 것을 설명문과 결과에 적는다', async () => {
  assert.match(dealsDescription('ko'), /한 번 계약하면 견적으로 되돌려도 금액을 고칠 수 없으니 금액을 확인한 뒤에 하라/);
  assert.match(dealsDescription('en'), /amounts can never be edited, even if the deal goes back to a quote/);
  fake();
  assert.match(await run({ action: 'deal_next', id: 'o1', to: 'contract' }), /견적으로 되돌려도 금액은 고칠 수 없다/);
});

test('D7c(2차 LOW-2). 금액 잠금 안내(오피스 사전 두 곳): 계약 합계를 넘는 청구는 서버가 거절하므로 줄어든 금액은 청구 취소, 늘어난 금액은 취소 뒤 새 거래로 안내한다', async () => {
  const { BUSINESS_DICT } = await import('../apps/office/src/business/i18n.js');
  const { BUSINESS_UI_DICT } = await import('../apps/office/src/business/ui-i18n.js');
  const a = BUSINESS_DICT['biz.error.amountLocked'], b = BUSINESS_UI_DICT['bizui.amountLocked'];
  assert.deepEqual(a, b, '두 사전이 같은 안내');
  assert.match(a[0], /^한 번이라도 계약한 거래는 금액을 고칠 수 없습니다\./, '총괄 화면 검사(check-business.mjs)가 찾는 앞 문장');
  assert.match(a[0], /줄어든 금액은 청구 취소로 기록하고, 늘어난 금액은 이 거래를 취소한 뒤 새 거래로/);
  assert.doesNotMatch(a[0], /청구·청구 취소로 기록/, '증액을 청구로 기록할 수 있다는 옛 안내');
  assert.match(a[1], /decrease as an invoice cancellation; for an increase, cancel this deal and create a new one/);
});

test('D9. 금액·단계·비슷한 건명(순수) — 오피스 deal-model.js와 같은 계산', () => {
  const d = data();
  const m = dealAmounts(d.orders[2], d.lines, d.entries);
  assert.deepEqual(m, { supply: 1000000, vat: 100000, total: 1100000, invoiced: 550000, paid: 0 });
  assert.equal(dealStage(d.orders[2], m), 'invoice');
  assert.equal(dealStage(d.orders[3], dealAmounts(d.orders[3], d.lines, d.entries)), 'paid');
  assert.ok(similar('(주)웹사이트 리뉴얼', '웹사이트리뉴얼 2차')); assert.ok(!similar('촬영', '촬영 추가'), '4자 미만은 같을 때만'); assert.ok(similar('촬영', ' 촬 영 '));
});

const WS = 'deals-wire';
await createCompany(WS, '거래도구사', 'owner', ME);
test('D10. office_deals 도구는 메신저 조직 턴에만 보이고(네이티브 sink 포함), 손님 턴은 세션을 부르지 않으며, 품목 줄까지 벤더 스키마에 required가 있다', async () => {
  const none = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], null, 'ko', [], '', none);
  assert.ok(!none.some((d) => d.name === 'office_deals'));
  let called = 0; Object.assign(dealsDeps, { session: async () => { called++; return null; } });
  const guest = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx({ origin: 'guest-uid' }), 'ko', [], '', guest);
  assert.match((await guest.find((d) => d.name === 'office_deals').handler({ action: 'customers' })).content[0].text, /주인이 아닌 사람/);
  assert.equal(called, 0);
  fake();
  const owner = []; makeCrewServer(WS, 'alpha', 'Alpha', [], 0, [], msgrCtx(), 'en', [], '', owner);
  const def = owner.find((d) => d.name === 'office_deals');
  assert.match(def.description, /Argo Office customers and deals/);
  const schema = ensureRequired(crewToolSpecs([def])[0].input_schema);
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.lines.items.required, ['item', 'unit_price']);
  assert.match((await def.handler({ action: 'customers' })).content[0].text, /Hanbit|한빛상사/);
});
