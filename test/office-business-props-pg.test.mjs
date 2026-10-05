// 거래·거래처 보강(오피스 14차 트랙 B) — 입금 예정일·거래 고치기(청구 뒤 금액 거절)·거래처 옮기기·보관·분류·권한·같은 값 쓰기 0·기록 상한.
// 명세: _worktrees/office-r5-spec/spec14.md "트랙 B". 마이그레이션: 20261004110000_office_business_props.sql
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { psqlSpawn } from './helpers/pg.mjs';

const DB = process.env.ARGO_PG_TEST_URL;
const skip = !DB && 'Run scripts/billing-pg-drill.sh test/office-business-props-pg.test.mjs';
const U = Object.fromEntries(['owner', 'admin', 'member', 'guest', 'outsider'].map((k) => [k, randomUUID()]));
let ORG; const OLD = {};
const raw = (q) => psqlSpawn(DB, ['-A', '-t', '-c', q]);
const sql = (q) => { const r = raw(q); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;
const org = (o) => (o ? quote(o) : 'null');
const userSql = (u, q) => `set role authenticated; select set_config('argo.uid',${quote(u)},false); ${q}`;
const last = (s) => s.split('\n').filter(Boolean).at(-1);
const read = (u = U.owner, o = null) => JSON.parse(last(sql(userSql(u, `select office_business_read(${org(o)})`))));
const query = (u, o, a, d, key = randomUUID()) => userSql(u, `select office_business_write(${org(o)},${quote(key)},${quote(a)},${quote(JSON.stringify(d))}::jsonb)`);
const write = (a, d, { u = U.owner, o = null, key = randomUUID() } = {}) => JSON.parse(last(sql(query(u, o, a, d, key)))).id;
const fail = (a, d, opts = {}) => { const r = raw(query(opts.u || U.owner, opts.o || null, a, d, opts.key)); assert.notEqual(r.status, 0, `${a} 가 거절돼야 한다`); return r.stderr; };
const customer = (name = 'Customer', extra = {}, opts = {}) => write('customer.save', { name, email: '', notes: '', ...extra }, opts);
const item = (kind = 'service', price = 1000, opts = {}) => write('item.save', { name: kind, kind, sku: '', price }, opts);
const deal = (c, lines, extra = {}, opts = {}) => write('order.create', { customer_id: c, title: 'Deal', lines, ...extra }, opts);
const line = (id, quantity = 1, unit_price = 1000, extra = {}) => ({ item_id: id, quantity, unit_price, ...extra });
const order = (id, u = U.owner, o = null) => read(u, o).orders.find((x) => x.id === id);
const linesOf = (id) => read().lines.filter((l) => l.order_id === id).sort((a, b) => a.unit_price - b.unit_price);
const acts = (id) => read().activity.filter((a) => a.order_id === id);
const xmin = (table, id) => sql(`select xmin::text from public.${table} where id=${quote(id)}`);
const xmins = (table, col, id) => sql(`select string_agg(xmin::text, ',' order by id) from public.${table} where ${col}=${quote(id)}`);
const count = (table, col, id) => Number(sql(`select count(*) from public.${table} where ${col}=${quote(id)}`));
const stock = (id) => JSON.parse(sql(`select jsonb_build_object('stock',stock,'reserved',reserved) from public.office_business_items where id=${quote(id)}`));

before(() => {
  if (!DB) return;
  sql(`do $$begin
  if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select from pg_roles where rolname='service_role') then create role service_role nologin; end if;
  end$$;
  grant usage on schema public to anon,authenticated,service_role;
  create schema auth; grant usage on schema auth to anon,authenticated,service_role;
  create table auth.users(id uuid primary key,created_at timestamptz default now(),email text);
  create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('argo.uid',true),'')::uuid$$;
  create schema storage;
  create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid);
  create table storage.buckets(id text primary key,name text,public boolean default false);
  create function storage.foldername(name text) returns text[] language sql immutable as $$select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1]$$;
  alter table storage.objects enable row level security;
  grant usage on schema storage to authenticated; grant select,insert,delete on storage.objects to authenticated;
  create schema realtime;
  create table realtime.messages(id bigint generated always as identity primary key,topic text,extension text,payload jsonb);
  create function realtime.topic() returns text language sql stable as $$select current_setting('realtime.topic',true)$$;
  create function realtime.send(payload jsonb,event text,topic text,private boolean default true) returns void language sql as $$select null::void$$;
  alter table realtime.messages enable row level security; grant select,insert on realtime.messages to authenticated; grant usage on schema realtime to authenticated;`);
  const apply = (f) => { const r = psqlSpawn(DB, ['-f', fileURLToPath(new URL(`../supabase/migrations/${f}`, import.meta.url))]); if (r.status !== 0) throw new Error(`${f}: ${r.stderr}`); };
  for (const f of ['20260714150000_entitlements.sql', '20260724000100_trial_14d.sql', '20260728100000_entitlements_ls.sql', '20260728113000_billing_hardening.sql', '20260728150000_ls_reconcile_cooldown.sql', '20260730050000_is_pro_ends_at.sql', '20260903120000_msgr.sql', '20260909002000_msgr_profiles_friends.sql', '20260909003000_msgr_message_meta.sql', '20260927144230_office_business.sql', '20260927170000_office_pages.sql', '20260927171000_office_mail.sql', '20260928010000_office_marketing.sql', '20260929140000_office_deal_flow.sql', '20260929180000_office_tasks_owners.sql', '20260929190000_office_perf.sql', '20260930150000_office_perf_tie_order.sql']) apply(f);
  for (const [k, id] of Object.entries(U)) sql(`insert into auth.users(id,email)values(${quote(id)},${quote(k + '@example.test')})`);
  ORG = last(sql(userSql(U.owner, `insert into msgr_orgs(name,slug,owner_user_id)values('Props','props',${quote(U.owner)}) returning id`)));
  sql(`insert into msgr_org_entitlements(org_id,plan,seats)values(${quote(ORG)},'team',20)on conflict(org_id)do update set plan='team',seats=20`);
  for (const k of ['admin', 'member', 'guest']) sql(`insert into msgr_org_members(org_id,user_id,role)values(${quote(ORG)},${quote(U[k])},${quote(k)})`);
  // 마이그레이션 전에 만든 거래처·거래(이관된 운영 데이터 모양) — 새 칸은 비어 있고 분류·기록은 그대로여야 한다
  OLD.c = customer('Before', { category: 'partner', status: 'hold' }); OLD.i = item('service', 1000);
  OLD.o = deal(OLD.c, [line(OLD.i, 1, 1000)]);
  write('order.confirm', { id: OLD.o }); write('entry.create', { order_id: OLD.o, kind: 'invoice', amount: 1100, note: '' });
  apply('20261004110000_office_business_props.sql');
});

test('기존 데이터: 새 칸(입금 예정일·보관 시각)은 비어 있고, 분류·거래 기록은 그대로', { skip }, () => {
  const d = read();
  const c = d.customers.find((x) => x.id === OLD.c), o = d.orders.find((x) => x.id === OLD.o);
  assert.equal(c.archived_at, null); assert.equal(c.category, 'partner'); assert.equal(c.status, 'hold');
  assert.equal(o.due_on, null); assert.ok('due_on' in o && 'archived_at' in c, '읽기 함수가 새 칸을 돌려준다');
  assert.deepEqual(acts(OLD.o).map((a) => a.kind), ['quote', 'contract', 'invoice']);
});

test('입금 예정일: 만들 때 넣고, 고치고, 비운다 — 처음 정할 때는 기록 없이, 바꾸거나 비우면 이전 날짜를 기록', { skip }, () => {
  const c = customer(), i = item();
  const o = deal(c, [line(i)], { due_on: '2026-10-30' });
  assert.equal(order(o).due_on, '2026-10-30');
  write('order.update', { id: o, due_on: '2026-11-05' });
  assert.equal(order(o).due_on, '2026-11-05');
  write('order.update', { id: o, due_on: null });
  assert.equal(order(o).due_on, null);
  assert.deepEqual(acts(o).filter((a) => a.kind === 'due').map((a) => a.note), ['2026-10-30', '2026-11-05']);
  const p = deal(c, [line(i)]);
  write('order.update', { id: p, due_on: '2026-12-01' });
  assert.equal(order(p).due_on, '2026-12-01');
  assert.equal(acts(p).some((a) => a.kind === 'due'), false, '처음 정하는 날짜는 기록하지 않는다');
  for (const bad of ['2026-13-01', '1999-12-31', '2101-01-01', '', '2026/10/30', 20261030]) {
    assert.match(fail('order.update', { id: p, due_on: bad }), /business_due/, `잘못된 날짜 ${bad}`);
    assert.match(fail('order.create', { customer_id: c, title: 'x', due_on: bad, lines: [line(i)] }), /business_due/);
  }
  assert.equal(order(p).due_on, '2026-12-01');
});

test('같은 값 쓰기 0: 바뀐 것이 없으면 거래·줄·기록을 다시 쓰지 않고, 이미 보관한 거래처도 다시 쓰지 않는다', { skip }, () => {
  const c = customer(), i = item();
  const o = deal(c, [line(i, 2, 1000), line(i, 1, 500, { tax_type: 'exempt' })], { due_on: '2026-10-30' });
  const ls = linesOf(o);
  const before = { o: xmin('office_business_orders', o), l: xmins('office_business_lines', 'order_id', o), a: count('office_business_activity', 'order_id', o) };
  write('order.update', { id: o, title: 'Deal', customer_id: c, due_on: '2026-10-30', lines: ls.map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type })) });
  write('order.update', { id: o, title: '  Deal  ' }); // 앞뒤 빈칸만 다른 건명도 같은 값
  assert.deepEqual({ o: xmin('office_business_orders', o), l: xmins('office_business_lines', 'order_id', o), a: count('office_business_activity', 'order_id', o) }, before);
  write('customer.archive', { ids: [c], on: true });
  const x = xmin('office_business_customers', c);
  write('customer.archive', { ids: [c], on: true });
  assert.equal(xmin('office_business_customers', c), x, '이미 보관한 거래처는 다시 쓰지 않는다');
  write('customer.archive', { ids: [c], on: false });
  const y = xmin('office_business_customers', c);
  write('customer.archive', { ids: [c], on: false });
  assert.equal(xmin('office_business_customers', c), y);
});

test('건명: 입금 완료·취소한 거래도 고칠 수 있고, 이전 건명이 기록에 남는다', { skip }, () => {
  const c = customer(), i = item();
  const paid = deal(c, [line(i, 1, 1000)]);
  write('order.confirm', { id: paid }); write('entry.create', { order_id: paid, kind: 'invoice', amount: 1100, note: '' }); write('entry.create', { order_id: paid, kind: 'payment', amount: 1100, note: '' });
  write('order.update', { id: paid, title: '새 건명' });
  assert.equal(order(paid).title, '새 건명');
  assert.deepEqual(acts(paid).filter((a) => a.kind === 'retitle').map((a) => a.note), ['Deal']);
  const gone = deal(c, [line(i)]); write('order.cancel', { id: gone });
  write('order.update', { id: gone, title: '취소한 거래', due_on: '2026-10-01' });
  assert.deepEqual([order(gone).title, order(gone).due_on, order(gone).status], ['취소한 거래', '2026-10-01', 'cancelled']);
  assert.match(fail('order.update', { id: paid, title: '   ' }), /business_input/);
  assert.match(fail('order.update', { id: paid, title: 'x'.repeat(201) }), /business_input/);
  assert.match(fail('order.update', { id: paid, title: 7 }), /business_input/);
  assert.match(fail('order.update', { id: randomUUID(), title: 'x' }), /business_not_found/);
});

test('금액: 견적 단계에서는 줄을 고치고·더하고·빼며 기록에 이전·새 합계가 남는다 — 계약하면 청구 전이라도 거절', { skip }, () => {
  const c = customer(), i = item(), j = item('service', 500);
  const o = deal(c, [line(i, 1, 1000)]);
  const [a] = linesOf(o);
  write('order.update', { id: o, lines: [{ id: a.id, item_id: i, quantity: 2, unit_price: 1500 }, line(j, 1, 500, { tax_type: 'exempt' })] });
  const ls = linesOf(o);
  assert.deepEqual(ls.map((l) => [l.quantity, l.unit_price, l.tax_type, l.vat]), [[1, 500, 'exempt', 0], [2, 1500, 'taxable', 300]]);
  assert.equal(ls.find((l) => l.unit_price === 1500).id, a.id, '고친 줄은 같은 줄(id 유지)');
  const rp = acts(o).filter((x) => x.kind === 'reprice');
  assert.deepEqual(rp.map((x) => [x.amount, x.note]), [[3800, '1100']], '새 합계 3,800원(부가세 포함), 이전 1,100원');
  // 계약하면 금액은 잠긴다 — 청구 전이라도(계약 금액이 성과 기록에 들어간다). 건명·입금 예정일은 계속 고칠 수 있다
  write('order.confirm', { id: o });
  const before = xmins('office_business_lines', 'order_id', o);
  const locked = { id: o, lines: [{ id: a.id, item_id: i, quantity: 3, unit_price: 1500 }] };
  assert.match(fail('order.update', locked), /business_amount_locked/);
  assert.match(fail('order.update', { id: o, lines: [{ id: a.id, item_id: i, quantity: 2, unit_price: 1500 }] }), /business_amount_locked/, '줄 빼기도 거절');
  assert.match(fail('order.update', { ...locked, title: '같이 보내도' }), /business_amount_locked/, '한 번의 쓰기 안에서 금액이 거절되면 건명도 바뀌지 않는다');
  assert.equal(order(o).title, 'Deal');
  assert.equal(xmins('office_business_lines', 'order_id', o), before, '줄은 그대로');
  write('order.update', { id: o, title: '계약 뒤 건명', due_on: '2026-11-30' });
  // 그대로 보낸 줄은 바뀐 것이 없으니 계약 거래에서도 막지 않는다(건명과 같이 보내는 수정 창)
  write('order.update', { id: o, title: '계약 뒤 건명 2', lines: linesOf(o).map((l) => ({ id: l.id, item_id: l.item_id, quantity: l.quantity, unit_price: l.unit_price, tax_type: l.tax_type, vat: l.vat })) });
  assert.equal(order(o).title, '계약 뒤 건명 2');
  // 청구·청구 취소 뒤에도 잠긴 채다
  write('entry.create', { order_id: o, kind: 'invoice', amount: 1000, note: '' });
  assert.match(fail('order.update', locked), /business_amount_locked/);
  write('entry.create', { order_id: o, kind: 'credit', amount: 1000, note: '' });
  assert.match(fail('order.update', locked), /business_amount_locked/);
  assert.deepEqual(linesOf(o).map((l) => [l.quantity, l.unit_price]), [[1, 500], [2, 1500]]);
  // 취소한 거래도 잠긴다
  const gone = deal(c, [line(i)]); write('order.cancel', { id: gone });
  const [g] = linesOf(gone);
  assert.match(fail('order.update', { id: gone, lines: [{ id: g.id, item_id: i, quantity: 5, unit_price: 1000 }] }), /business_amount_locked/);
});

test('성과 기록 불변: 계약한 거래의 금액을 고치려 해도 성과의 계약 금액은 그대로다 — 견적 단계 고치기는 계약 전이라 성과에 없다', { skip }, () => {
  const opts = { u: U.admin, o: ORG };
  const c = customer('성과 거래처', {}, opts), i = item('service', 1000, opts);
  const o = deal(c, [line(i, 2, 1000)], {}, opts); // 조직 거래의 담당자 = 견적을 남긴 사람(관리자)
  const day = sql(`select (now() at time zone 'Asia/Seoul')::date::text`), from = `${day.slice(0, 7)}-01`;
  const first = () => read(U.admin, ORG).lines.find((l) => l.order_id === o);
  const deals = () => JSON.parse(last(sql(userSql(U.admin, `select office_perf_report(${quote(ORG)},${quote(from)}::date,${quote(day)}::date)`)))).deals.filter((d) => d.order_id === o);
  write('order.update', { id: o, lines: [{ id: first().id, item_id: i, quantity: 3, unit_price: 1000 }] }, opts); // 견적: 고친다
  assert.deepEqual(deals(), [], '견적은 성과에 없다');
  write('order.confirm', { id: o }, opts);
  const counted = deals();
  assert.deepEqual(counted.map((d) => [d.kind, d.amount]), [['contract', 3000]], '계약 금액 = 공급가액 합계');
  assert.match(fail('order.update', { id: o, lines: [{ id: first().id, item_id: i, quantity: 9, unit_price: 1000 }] }, opts), /business_amount_locked/);
  assert.equal(first().quantity, 3);
  assert.match(fail('order.update', { id: o, lines: [line(i, 1, 1)] }, opts), /business_amount_locked/);
  write('order.update', { id: o, title: '건명은 고친다' }, opts);
  assert.deepEqual(deals().map((d) => [d.kind, d.amount]), [['contract', 3000]], '성과의 계약 금액은 그대로');
  // 견적으로 되돌려도 금액은 잠긴 채다 — 되돌려 고친 뒤 다시 계약하면 잠근 달의 계약 금액이 바뀌기 때문(10/4 분리 검수)
  write('order.reopen', { id: o }, opts);
  assert.match(fail('order.update', { id: o, lines: [{ id: first().id, item_id: i, quantity: 9, unit_price: 1000 }] }, opts), /business_amount_locked/, '되돌린 거래도 금액 잠금');
  assert.equal(first().quantity, 3);
  write('order.confirm', { id: o }, opts);
  assert.ok(deals().every((d) => d.kind !== 'contract' || d.amount === 3000), '다시 계약해도 계약 금액 3,000원');
});

test('금액 줄 검사: 다른 거래의 줄·같은 줄 두 번·빈 줄 목록·면세에 세액·총액 상한은 거절, 직접 준 세액은 지킨다', { skip }, () => {
  const c = customer(), i = item();
  const o = deal(c, [line(i, 1, 10000000, { vat: 999999 })]), p = deal(c, [line(i)]);
  const [a] = linesOf(o), [b] = linesOf(p);
  assert.match(fail('order.update', { id: o, lines: [{ id: b.id, item_id: i, quantity: 1, unit_price: 1 }] }), /business_not_found/);
  assert.match(fail('order.update', { id: o, lines: [{ id: a.id, item_id: i, quantity: 1, unit_price: 1 }, { id: a.id, item_id: i, quantity: 1, unit_price: 2 }] }), /business_input/);
  assert.match(fail('order.update', { id: o, lines: [] }), /business_input/);
  assert.match(fail('order.update', { id: o, lines: [line(i, 1, 5000, { tax_type: 'exempt', vat: 500 })] }), /business_input/);
  assert.match(fail('order.update', { id: o, lines: [line(i, 1000000, 1000000)] }), /business_total_limit/);
  assert.match(fail('order.update', { id: o, lines: [line(randomUUID())] }), /business_not_found/);
  const x = xmins('office_business_lines', 'order_id', o);
  write('order.update', { id: o, lines: [{ id: a.id, item_id: i, quantity: 1, unit_price: 10000000, tax_type: 'taxable', vat: 999999 }] });
  assert.equal(xmins('office_business_lines', 'order_id', o), x, '원본 세액(이관 값)을 그대로 보내면 바뀐 것이 없다');
  assert.equal(linesOf(o)[0].vat, 999999);
});

test('상품 줄: 계약 거래의 줄은 고치지 않아 재고 잡음이 그대로다 — 견적으로 되돌린 거래도 줄을 고칠 수 없고, 다시 계약하면 원래 수량을 잡는다', { skip }, () => {
  const c = customer(), box = item('product', 100), other = item('product', 100), svc = item();
  write('stock.receive', { item_id: box, quantity: 10, note: '' }); write('stock.receive', { item_id: other, quantity: 10, note: '' });
  const o = deal(c, [line(box, 3, 100)]);
  const [a] = linesOf(o);
  write('order.update', { id: o, lines: [{ id: a.id, item_id: box, quantity: 4, unit_price: 100 }] }); // 견적 줄은 재고를 잡지 않는다
  assert.deepEqual(stock(box), { stock: 10, reserved: 0 });
  write('order.confirm', { id: o });
  assert.deepEqual(stock(box), { stock: 10, reserved: 4 });
  assert.match(fail('order.update', { id: o, lines: [{ id: a.id, item_id: box, quantity: 5, unit_price: 100 }] }), /business_amount_locked/);
  assert.deepEqual(stock(box), { stock: 10, reserved: 4 }, '거절된 고치기는 재고를 건드리지 않는다');
  write('order.reopen', { id: o }); // 계약 → 견적: 잡음을 풀고 기록이 줄을 가리킨다
  assert.deepEqual(stock(box), { stock: 10, reserved: 0 });
  const mv = JSON.parse(sql(`select jsonb_agg(jsonb_build_array(kind,quantity) order by at,id) from office_business_movements where order_id=${quote(o)}`));
  assert.deepEqual(mv, [['reserve', 4], ['release', 4]]);
  // 한 번 계약한 거래는 견적으로 되돌려도 줄을 고치지 않는다(다시 계약하면 잠근 달의 성과 계약 금액이 바뀐다, 10/4 분리 검수)
  assert.match(fail('order.update', { id: o, lines: [line(other, 2, 100)] }), /business_amount_locked/, '줄 빼고 더하기 거절');
  assert.match(fail('order.update', { id: o, lines: [{ id: a.id, item_id: svc, quantity: 1, unit_price: 100 }] }), /business_amount_locked/, '다른 상품으로 바꾸기 거절');
  assert.match(fail('order.update', { id: o, lines: [{ id: a.id, item_id: box, quantity: 2, unit_price: 90 }] }), /business_amount_locked/, '같은 상품 수량·단가 고치기도 거절');
  write('order.update', { id: o, title: '되돌린 거래 건명' }); // 건명은 고친다
  assert.equal(count('office_business_movements', 'order_id', o), 2, '재고 기록은 더 생기지 않는다');
  write('order.confirm', { id: o });
  assert.deepEqual([stock(box), stock(other)], [{ stock: 10, reserved: 4 }, { stock: 10, reserved: 0 }], '다시 계약하면 원래 수량을 잡는다');
});

test('거래처 옮기기: 다른 거래처로(입금 완료 거래도), 이전 거래처 이름을 기록 — 빈 거래처·보관한 거래처·남의 거래처는 거절', { skip }, () => {
  const a = customer('가나상사'), b = customer('(거래처 미지정)'), z = customer('보관한 곳'), i = item();
  const o = deal(a, [line(i)]);
  write('order.confirm', { id: o }); write('entry.create', { order_id: o, kind: 'invoice', amount: 1100, note: '' }); write('entry.create', { order_id: o, kind: 'payment', amount: 1100, note: '' });
  write('order.update', { id: o, customer_id: b });
  assert.equal(order(o).customer_id, b);
  assert.deepEqual(acts(o).filter((x) => x.kind === 'move').map((x) => x.note), ['가나상사']);
  assert.equal(read().entries.filter((e) => e.order_id === o).length, 2, '장부는 그대로 따라간다');
  write('customer.archive', { ids: [z], on: true });
  assert.match(fail('order.update', { id: o, customer_id: z }), /business_customer_archived/);
  assert.match(fail('order.update', { id: o, customer_id: null }), /business_input/);
  const theirs = customer('남의 거래처', {}, { u: U.outsider });
  assert.match(fail('order.update', { id: o, customer_id: theirs }), /business_not_found/);
  // 보관한 거래처에 이미 있는 거래는 그 거래처를 그대로 두고 건명만 고칠 수 있다
  const k = deal(a, [line(i)]); write('order.update', { id: k, customer_id: b }); write('order.update', { id: k, customer_id: a });
  write('customer.archive', { ids: [a], on: true });
  write('order.update', { id: k, customer_id: a, title: '보관한 곳의 거래' });
  assert.deepEqual([order(k).customer_id, order(k).title], [a, '보관한 곳의 거래']);
});

test('분류: 공급사·기타를 저장하고, 모르는 분류는 거절', { skip }, () => {
  const s = customer('공급처', { category: 'supplier' }), e = customer('기타처', { category: 'other' });
  const byId = Object.fromEntries(read().customers.map((x) => [x.id, x.category]));
  assert.deepEqual([byId[s], byId[e]], ['supplier', 'other']);
  assert.match(fail('customer.save', { name: 'x', email: '', notes: '', category: 'vendor' }), /business_input/);
  assert.match(fail('customer.save', { id: s, version: 1, name: 'x', email: '', notes: '', category: 'unknown' }), /business_input/);
  assert.notEqual(raw(`insert into office_business_customers(scope,name,category) values('u:${U.owner}','direct','vendor')`).status, 0, '표 제약도 막는다');
});

test('보관·되살리기: 여러 곳을 한 번에, 거래는 그대로, 보관한 거래처로는 새 거래를 만들지 못한다 — 하나라도 틀리면 하나도 바꾸지 않는다', { skip }, () => {
  const a = customer('하나'), b = customer('둘'), i = item();
  const o = deal(a, [line(i)]);
  write('customer.archive', { ids: [a, b, a], on: true });
  let d = read();
  assert.ok(d.customers.find((x) => x.id === a).archived_at && d.customers.find((x) => x.id === b).archived_at, '보관한 거래처도 읽기에 남는다(보관함)');
  assert.equal(d.orders.find((x) => x.id === o).customer_id, a, '연결된 거래는 그대로');
  assert.match(fail('order.create', { customer_id: a, title: 'x', lines: [line(i)] }), /business_customer_archived/);
  write('order.update', { id: o, title: '보관 뒤에도 거래는 고친다' });
  write('customer.save', { id: a, version: 1, name: '하나(고침)', email: '', notes: '' }); // 보관한 거래처도 정보는 고칠 수 있다
  assert.match(fail('customer.archive', { ids: [b, randomUUID()], on: false }), /business_not_found/);
  assert.ok(read().customers.find((x) => x.id === b).archived_at, '틀린 id가 섞이면 앞의 거래처도 그대로');
  write('customer.archive', { ids: [a, b], on: false });
  d = read(); assert.equal(d.customers.find((x) => x.id === a).archived_at, null);
  deal(a, [line(i)]);
  assert.match(fail('customer.archive', { ids: [], on: true }), /business_input/);
  assert.match(fail('customer.archive', { ids: Array.from({ length: 501 }, () => a), on: true }), /business_input/);
  assert.match(fail('customer.archive', { ids: [a], on: 'yes' }), /business_input/);
  assert.match(fail('customer.archive', { ids: [a] }), /business_input/);
});

test('권한: 조직 공간은 관리자만 고치고 보관한다 — 멤버·손님은 거절, 남의 공간은 찾을 수 없다', { skip }, () => {
  const c = customer('조직 거래처', {}, { u: U.admin, o: ORG }), i = item('service', 1000, { u: U.admin, o: ORG });
  const o = deal(c, [line(i)], {}, { u: U.admin, o: ORG });
  for (const u of [U.member, U.guest]) {
    assert.match(fail('order.update', { id: o, title: 'x' }, { u, o: ORG }), /business_forbidden/);
    assert.match(fail('customer.archive', { ids: [c], on: true }, { u, o: ORG }), /business_forbidden/);
  }
  write('order.update', { id: o, title: '관리자가 고침', due_on: '2026-10-31' }, { u: U.admin, o: ORG });
  write('customer.archive', { ids: [c], on: true }, { u: U.owner, o: ORG });
  const d = read(U.member, ORG);
  assert.equal(d.orders.find((x) => x.id === o).title, '관리자가 고침', '멤버는 읽기만');
  assert.ok(d.customers.find((x) => x.id === c).archived_at);
  assert.match(fail('order.update', { id: o, title: 'x' }, { u: U.outsider }), /business_not_found/);
  assert.match(fail('customer.archive', { ids: [c], on: false }, { u: U.outsider }), /business_not_found/);
});

test('기록 상한: 고친 기록은 거래마다 200번까지 — 넘으면 거절, 처음 정하는 입금 예정일은 막지 않는다', { skip }, () => {
  const c = customer(), i = item(), o = deal(c, [line(i)]);
  sql(`insert into office_business_activity(scope,order_id,kind,at,note) select 'u:${U.owner}',${quote(o)},'retitle',now(),'old' from generate_series(1,199)`);
  write('order.update', { id: o, title: '200번째' });
  assert.match(fail('order.update', { id: o, title: '201번째' }), /business_edit_limit/);
  assert.equal(order(o).title, '200번째');
  write('order.update', { id: o, due_on: '2026-10-10' }); // 처음 정하는 날짜는 기록하지 않으므로 막지 않는다
  assert.match(fail('order.update', { id: o, due_on: '2026-10-11' }), /business_edit_limit/);
  assert.equal(count('office_business_activity', 'order_id', o), 1 + 200, '견적 1 + 고친 기록 200');
});

test('요청 번호: 같은 번호·같은 내용은 한 번만 반영, 내용이 다르면 거절', { skip }, () => {
  const c = customer(), i = item(), o = deal(c, [line(i)]), key = randomUUID();
  write('order.update', { id: o, title: '한 번' }, { key });
  write('order.update', { id: o, title: '한 번' }, { key });
  assert.equal(acts(o).filter((a) => a.kind === 'retitle').length, 1);
  assert.match(fail('order.update', { id: o, title: '두 번' }, { key }), /business_idempotency_conflict/);
  const k2 = randomUUID();
  write('customer.archive', { ids: [c], on: true }, { key: k2 });
  write('customer.archive', { ids: [c], on: true }, { key: k2 });
  assert.match(fail('customer.archive', { ids: [c], on: false }, { key: k2 }), /business_idempotency_conflict/);
});
