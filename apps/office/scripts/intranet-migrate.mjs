// 인트라넷 → 오피스 업무 이관 실행기(유건 9/29). 인트라넷 캐시(board.db)는 읽기만 하고, 노션에는 요청하지 않는다.
// 쓰기는 모두 오피스 업무 기능(office_business_write)으로 — 앱과 같은 검사를 거친다. 요청 번호는 (거래·단계)로 고정이라 다시 돌려도 두 번 들어가지 않는다.
//
//   node scripts/intranet-migrate.mjs --dry-run            계획과 대조 합계만(네트워크 없음)
//   node scripts/intranet-migrate.mjs                      이관 실행 + 대조
// 환경 변수(값은 출력하지 않는다): OFFICE_MIGRATE_URL, OFFICE_MIGRATE_ANON_KEY, OFFICE_MIGRATE_EMAIL, OFFICE_MIGRATE_PASSWORD,
//   OFFICE_MIGRATE_ORG(없으면 그 계정의 내 공간), OFFICE_MIGRATE_SIGNUP=1(계정이 없으면 만든다 — 로컬 검증 전용), INTRANET_DB(기본 AI-Native/data/board.db)
// DB 방식(비밀번호 없는 계정): OFFICE_MIGRATE_DB_UID(계정 id) + OFFICE_MIGRATE_PG(psql 접속 문자열, 비밀번호는 PGPASSWORD) — 로그인 대신 그 계정 id로 같은 함수를 부른다
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { planMigration, expectedTotals } from './intranet-plan.mjs';

const DB = process.env.INTRANET_DB || join(homedir(), 'lean-projects/AI-Native/data/board.db');
const dry = process.argv.includes('--dry-run');
const q = (sql) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', DB, sql], { encoding: 'utf8' }) || '[]');

const customers = q('select id, company, manager, phone, email, category, status, notes, address, account from notion_customers');
const deals = q(`select id, title, customer_id as customerId, status, supply, vat, total, quote_date as quoteDate, contract_date as contractDate,
  invoice_date as invoiceDate, paid_date as paidDate, notes, created from notion_deals order by coalesce(quote_date, contract_date, invoice_date, paid_date, created), id`);
const plan = planMigration({ customers, deals });
const expected = expectedTotals(plan);
const allDates = plan.deals.flatMap((d) => Object.values(d.dates)).filter(Boolean).sort();
console.log(`계획: 거래처 ${expected.customers}곳(원본 ${customers.length}), 거래 ${expected.deals}건(취소 ${expected.cancelled}), 기간 ${allDates[0]} ~ ${allDates.at(-1)}, 원본 합계 불일치 ${plan.deals.filter((d) => d.totalMismatch).length}건`);
if (dry) { console.log('예상 합계', expected); process.exit(0); }

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} 가 없습니다`); process.exit(2); } return v; };
const org = process.env.OFFICE_MIGRATE_ORG || null;
let rpc;
if (process.env.OFFICE_MIGRATE_DB_UID) {
  // DB 방식(9/30 운영 이관): Google·GitHub로만 로그인하는 계정은 비밀번호가 없다 → DB에 접속해 앱이 부르는 같은 함수를
  // 그 계정 id(auth.uid())로 부른다. 권한·저장 규칙은 앱과 같다. 접속 정보는 OFFICE_MIGRATE_PG(비밀번호는 PGPASSWORD)로만 받는다.
  const uid = need('OFFICE_MIGRATE_DB_UID'), conn = need('OFFICE_MIGRATE_PG');
  const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);
  const arg = (v) => (v !== null && typeof v === 'object' ? `${lit(JSON.stringify(v))}::jsonb` : lit(v));
  const claims = lit(JSON.stringify({ sub: uid, role: 'authenticated' }));
  rpc = async (fn, args) => {
    const call = `select public.${fn}(${Object.entries(args).map(([k, v]) => `${k} => ${arg(v)}`).join(', ')})::text;`;
    const sql = `begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', ${claims}, true);\n${call}\ncommit;\n`;
    try {
      const out = execFileSync('psql', [conn, '-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
      return JSON.parse(out.trim().split('\n').filter(Boolean).at(-1));
    } catch (e) { throw new Error(`${fn}: ${String(e.stderr || e.message).split('\n')[0]}`); }
  };
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(need('OFFICE_MIGRATE_URL'), need('OFFICE_MIGRATE_ANON_KEY'), { auth: { persistSession: false } });
  const email = need('OFFICE_MIGRATE_EMAIL'), password = need('OFFICE_MIGRATE_PASSWORD');
  let { error: signInError } = await sb.auth.signInWithPassword({ email, password });
  if (signInError && process.env.OFFICE_MIGRATE_SIGNUP === '1') {
    const { error } = await sb.auth.signUp({ email, password });
    if (error) { console.error('계정을 만들지 못했습니다:', error.message); process.exit(1); }
    ({ error: signInError } = await sb.auth.signInWithPassword({ email, password }));
  }
  if (signInError) { console.error('로그인 실패:', signInError.message); process.exit(1); }
  rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code }); return data; };
}
const keyOf = (...parts) => { const h = createHash('sha256').update(['intranet-migrate', org ?? 'me', ...parts].join(':')).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const write = async (key, action, data) => (await rpc('office_business_write', { p_org: org, p_key: key, p_action: action, p_data: data })).id;

const before = await rpc('office_business_read', { p_org: org });
const resuming = before.customers.length > 0;
if (resuming && !process.argv.includes('--resume')) { console.error(`이 공간에 거래처가 이미 ${before.customers.length}곳 있습니다. 같은 이관을 이어서 하려면 --resume`); process.exit(1); }

const item = await write(keyOf('item'), 'item.save', { name: '용역', kind: 'service', sku: '', price: 0 });
const customerId = new Map();
for (const c of plan.customers) {
  const { key, ...data } = c;
  customerId.set(key, await write(keyOf('customer', key), 'customer.save', data));
}
let steps = 0;
for (const d of plan.deals) {
  const orderId = await write(keyOf('deal', d.sourceId, 'create'), 'order.create', {
    customer_id: customerId.get(d.customerKey), title: d.title, at: d.dates.quote,
    lines: [{ item_id: item, quantity: 1, unit_price: d.supply, tax_type: d.taxType, vat: d.vat }],
  });
  const gross = d.supply + d.vat;
  if (d.stages.includes('contract')) await write(keyOf('deal', d.sourceId, 'contract'), 'order.confirm', { id: orderId, at: d.dates.contract });
  if (d.stages.includes('invoice') && gross > 0) await write(keyOf('deal', d.sourceId, 'invoice'), 'entry.create', { order_id: orderId, kind: 'invoice', amount: gross, vat: d.vat, note: '', at: d.dates.invoice });
  if (d.stages.includes('paid') && gross > 0) await write(keyOf('deal', d.sourceId, 'paid'), 'entry.create', { order_id: orderId, kind: 'payment', amount: gross, note: '', at: d.dates.paid });
  if (d.cancelled) await write(keyOf('deal', d.sourceId, 'cancel'), 'order.cancel', { id: orderId, at: d.dates.cancel });
  if (d.memo.length) await write(keyOf('deal', d.sourceId, 'memo'), 'link.add', { order_id: orderId, kind: 'note', body: d.memo.join('\n\n') });
  steps += 1;
}

// 대조: 인트라넷에서 계산한 합계 ↔ 오피스 집계(같은 기간)
const after = await rpc('office_business_read', { p_org: org });
const report = await rpc('office_business_report', { p_org: org, p_from: allDates[0], p_to: allDates.at(-1), p_customer: null });
const got = {
  customers: after.customers.length, deals: after.orders.length, cancelled: after.orders.filter((o) => o.status === 'cancelled').length,
  sales: report.metrics.sales, invoiced: report.metrics.invoiced, paid: report.metrics.paid, vat: report.metrics.vat,
};
const rows = Object.keys(expected).map((k) => [k, expected[k], got[k], expected[k] === got[k] ? '같음' : '다름']);
console.log(`거래 ${steps}건 처리${resuming ? '(이어서)' : ''}`);
console.table(rows.map(([항목, 인트라넷, 오피스, 결과]) => ({ 항목, 인트라넷, 오피스, 결과 })));
process.exit(rows.every((r) => r[3] === '같음') ? 0 : 3);
