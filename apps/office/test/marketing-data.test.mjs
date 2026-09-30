import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { validateFilters } from '../src/business/dashboard-model.js';

function load(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
  const module = { exports: {} };
  const injected = { module, exports: module.exports, ...dependencies };
  new Function(...Object.keys(injected), transformSync(source, { loader: 'js', format: 'cjs' }).code)(...Object.values(injected));
  return module.exports;
}
const shared = load('../src/business/data.js', { validateFilters });
const { createMarketingClient, marketingReportArgs, marketingError } = load('../src/business/marketing-data.js', { ...shared, validateFilters });
const campaign = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
function fixture() {
  const values = new Map(), calls = [];
  let scope = { uid: 'alice', org: null }, auth = 'alice', count = 0;
  let respond = async () => ({ data: { campaigns: [] }, error: null });
  const journal = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const client = async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: auth }, access_token: 'fixture-token' } } }) }, rpc(fn, args) { return { setHeader(name, value) { calls.push({ fn, args, name, value }); return respond(fn, args); } }; } });
  const options = { client, journal, scope: () => scope, key: () => `request-${++count}` };
  return { values, calls, marketing: () => createMarketingClient(options), business: () => shared.createBusinessClient(options), reply: fn => { respond = fn; }, scope: value => { scope = value; }, auth: value => { auth = value; } };
}

test('marketing validates real calendar dates and optional campaign UUID before dispatch', async () => {
  assert.deepEqual(marketingReportArgs({ from: '2026-09-01', to: '2026-09-30', campaign }), { p_from: '2026-09-01', p_to: '2026-09-30', p_campaign: campaign });
  assert.equal(marketingReportArgs({ from: '2026-09-01', to: '2026-09-30' }).p_campaign, null);
  const f = fixture(), client = f.marketing();
  for (const filters of [{ from: '2026-02-30', to: '2026-03-01' }, { from: '2026-09-30', to: '2026-09-01' }, { from: '2026-09-01', to: '2026-09-30', campaign: 'invalid' }, { from: '2026-09-01', to: '2026-09-30', campaign: 12 }]) await assert.rejects(client.report(filters));
  assert.equal(f.calls.length, 0);
  await client.report({ from: '2026-09-01', to: '2026-09-30', campaign });
  assert.equal(f.calls[0].fn, 'office_marketing_report');
  assert.deepEqual(f.calls[0].args, { p_org: null, p_from: '2026-09-01', p_to: '2026-09-30', p_campaign: campaign });
  assert.equal(f.calls[0].value, 'Bearer fixture-token');
});

test('marketing and business pending receipts are isolated and reload retries the original campaign mutation', async () => {
  const f = fixture();
  f.reply(async () => { throw new Error('response lost'); });
  await assert.rejects(f.business().mutate('order.create', { title: 'Order' }));
  await assert.rejects(f.marketing().mutate('campaign.save', { name: 'Campaign' }));
  assert.equal(f.values.size, 2);
  assert.ok(f.values.has('argo-office-business-pending:alice:me'));
  assert.ok(f.values.has('argo-office-marketing-pending:alice:me'));
  const reloaded = f.marketing();
  f.reply(async () => ({ data: { campaigns: [] }, error: null }));
  await reloaded.refresh();
  assert.equal(reloaded.getSnapshot().uncertain, true);
  await assert.rejects(reloaded.mutate('campaign.save', { name: 'Other' }), /pending/);
  assert.equal(f.calls.filter(call => call.fn === 'office_marketing_write').length, 1);
  await reloaded.retryPending();
  const writes = f.calls.filter(call => call.fn === 'office_marketing_write');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].args, writes[1].args);
  assert.equal(f.values.size, 1);
  assert.ok(f.values.has('argo-office-business-pending:alice:me'));
});

test('marketing scopes both report responses and authenticated dispatch to the current user', async () => {
  const f = fixture(), client = f.marketing();
  f.auth('bob');
  await assert.rejects(client.refresh(), /signIn/);
  assert.equal(f.calls.length, 0);
  f.auth('alice');
  let finish;
  f.reply(() => new Promise(resolve => { finish = resolve; }));
  const request = client.report({ from: '2026-09-01', to: '2026-09-30' });
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  f.scope({ uid: 'alice', org: campaign });
  finish({ data: { metrics: { spend: 100 } }, error: null });
  await assert.rejects(request, /scope/);
});

test('marketing version rejection clears its receipt and refreshes the current row versions', async () => {
  const f = fixture(), client = f.marketing();
  f.reply(async fn => fn.endsWith('_write') ? { error: { message: 'marketing_version_conflict', code: 'P0001' }, status: 400 } : { data: { campaigns: [{ id: campaign, version: 4 }] }, error: null });
  await assert.rejects(client.mutate('campaign.save', { id: campaign, version: 2 }), /version_conflict/);
  assert.equal(f.values.size, 0);
  assert.equal(client.getSnapshot().data.campaigns[0].version, 4);
  assert.equal(marketingError({ message: 'marketing_version_conflict' }), 'biz.error.version');
  assert.equal(marketingError({ message: 'marketing_aggregate_limit' }), 'biz.error.aggregate');
  assert.equal(marketingError({ code: '42501' }), 'biz.error.permission');
});
