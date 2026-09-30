import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as model from '../src/business/dashboard-model.js';
import * as period from '../src/business/dashboard-period.js';
import { createContext, createElement, useContext, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { timeSeriesGeometry, horizontalBarGeometry } from '../src/business/chart-geometry.js';
import { CHART_MODULES } from '../src/core/module-registry.js';
import { renderToStaticMarkup } from 'react-dom/server';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../src/business/data.js', import.meta.url), 'utf8');
const compiled = transformSync(source.replace(/^import .*;$/gm, ''), { loader: 'js', format: 'cjs' }).code;
const module = { exports: {} };
new Function('exports', 'module', 'validateFilters', compiled)(module.exports, module, model.validateFilters);
const { createBusinessClient, businessError } = module.exports;
function fixture() {
  let current = { uid: 'alice', org: null }, auth = 'alice';
  const values = new Map(), calls = [];
  let reply = async () => ({ data: { settings: { version: 1 } }, error: null });
  const journal = { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const client = async () => ({ auth: { getSession: async () => ({ data: { session: { user: { id: auth }, access_token: 'test-token' } } }) }, rpc(fn,args) { return { setHeader(name,value) { calls.push({fn,args,name,value}); return reply(fn,args); } }; } });
  const make = () => createBusinessClient({ client, scope: () => current, journal, key: () => 'request-key' });
  return { make, calls, values, setScope: v => { current = v; }, setAuth: v => { auth = v; }, reply: fn => { reply = fn; } };
}
test('widget instances remain distinct and reorder without mutating input', () => {
  let i = 0; const key = () => `id-${++i}`;
  const dashboard = model.defaultDashboard('Sales', new Date(2026, 8, 27), key);
  dashboard.widgets.push(model.newWidget('kpi','sales',key));
  const [normalized] = model.normalizeDashboards([dashboard]);
  assert.equal(normalized.widgets.length,6);
  assert.deepEqual(dashboard.widgets.slice(0, 3).map(w => [w.type, w.metric, w.size]), [['kpi', 'sales', 's'], ['kpi', 'paid', 's'], ['kpi', 'receivable', 's']]);
  assert.equal(dashboard.widgets[3].size, 'full');
  const moved = model.moveWidget(normalized.widgets, normalized.widgets[4].id,-1);
  assert.equal(moved[3].id,normalized.widgets[4].id);
  assert.notDeepEqual(moved,normalized.widgets);
  assert.deepEqual(dashboard.filters,{preset:'all',from:'2026-09-01',to:'2026-09-27',customer:null}); // 새 대시보드는 전체 기간(유건 9/30), 날짜는 서버 검사용
});
test('date filters reject overflow, reverse ranges and unsupported chart combinations', () => {
  for (const filters of [{from:'2026-02-30',to:'2026-03-01'},{from:'2026-09-30',to:'2026-09-01'},{from:'2000-01-01',to:'2026-09-01'}]) assert.throws(() => model.validateFilters(filters));
  assert.throws(() => model.newWidget('line','receivable'));
  assert.throws(() => model.newWidget('donut','paid'));
  assert.deepEqual(model.chartSeries([{date:'2026-09-02',sales:-4},{date:'2026-09-01',sales:8}],'sales').map(x => x.value),[8,-4]);
});
test('dashboard reload preserves shared module widths, hidden instances, and custom configuration', () => {
  const widgets = ['s', 'm', 'l', 'full'].map((size, index) => ({ ...model.newWidget('kpi', 'sales', () => `instance-${index}`), size, hidden: index === 1, cfg: { note: `value-${index}` } }));
  const saved = { id: 'dashboard', name: 'Sales', widgets };
  const [restored] = model.normalizeDashboards(JSON.parse(JSON.stringify([saved])));
  assert.deepEqual(restored.widgets, widgets);
  const hidden = restored.widgets.find((item) => item.hidden);
  const unhidden = restored.widgets.map((item) => item.id === hidden.id ? { ...item, hidden: false } : item);
  const [reloaded] = model.normalizeDashboards([{ ...restored, widgets: unhidden }]);
  assert.equal(reloaded.widgets.length, 4);
  assert.deepEqual(reloaded.widgets[1], { ...widgets[1], hidden: false });
  assert.equal(saved.widgets[1].hidden, true);
});
test('a full dashboard can change a widget metric without deleting its instance or layout', () => {
  const widgets = Array.from({ length: 30 }, (_, index) => ({ ...model.newWidget('kpi', 'sales', () => `widget-${index}`), size: 'l', hidden: index === 29, cfg: { label: index } }));
  const result = model.configureWidget(widgets, 'widget-29', 'line', 'paid');
  assert.equal(result.length, 30);
  assert.deepEqual(result[29], { ...widgets[29], type: 'line', metric: 'paid' });
  assert.equal(result[0], widgets[0]);
  assert.equal(widgets[29].metric, 'sales');
  assert.throws(() => model.configureWidget(widgets, 'missing', 'kpi', 'paid'));
  assert.throws(() => model.configureWidget(widgets, 'widget-29', 'line', 'receivable'));
});
test('uncertain write survives reload and requires explicit same-key same-payload retry', async () => {
  const f=fixture(), first=f.make();
  f.reply(async () => { throw new Error('network lost'); });
  await assert.rejects(first.mutate('payment.record',{amount:50}));
  assert.equal(f.values.size,1); assert.equal(first.getSnapshot().uncertain,true);
  const next=f.make();
  f.reply(async fn => ({data: fn.endsWith('write') ? {id:'record'} : {settings:{version:1}},error:null}));
  await next.refresh();
  assert.equal(f.calls.filter(c=>c.fn.endsWith('write')).length,1);
  await assert.rejects(next.mutate('payment.record',{amount:99}),/pending/);
  await next.retryPending();
  const writes=f.calls.filter(c=>c.fn.endsWith('write'));
  assert.deepEqual(writes[0].args,writes[1].args);
  assert.equal(writes[1].value,'Bearer test-token'); assert.equal(f.values.size,0);
});
test('authenticated UID mismatch reads no receipt and dispatches no RPC', async () => {
  const f=fixture(); f.setAuth('bob');
  await assert.rejects(f.make().mutate('payment.record',{amount:50}),/signIn/);
  assert.equal(f.calls.length,0); assert.equal(f.values.size,0);
});
test('scope switch rejects old RPC response without leaking data and preserves receipt', async () => {
  const f=fixture(), c=f.make(); let resolve;
  f.reply(() => new Promise(r => { resolve=r; }));
  const pending=c.mutate('payment.record',{amount:50});
  while (!resolve) await new Promise(r=>setImmediate(r));
  f.setScope({uid:'bob',org:null}); f.setAuth('bob'); c.invalidate();
  resolve({data:{id:'secret'},error:null});
  await assert.rejects(pending,/scope/);
  assert.equal(c.getSnapshot().data,null); assert.equal(f.values.size,1);
});
test('definite version rejection clears receipt and refreshes latest settings', async () => {
  const f=fixture(),c=f.make();
  f.reply(async fn => fn.endsWith('write') ? {error:{message:'business_version_conflict',code:'P0001'},status:400} : {data:{settings:{version:7}},error:null});
  await assert.rejects(c.mutate('settings.save',{version:1}),/version_conflict/);
  assert.equal(f.values.size,0); assert.equal(c.getSnapshot().data.settings.version,7);
  assert.equal(businessError({message:'business_insufficient_stock',code:'P0001'}),'biz.error.stock');
});
test('committed write does not reject if subsequent refresh fails', async () => {
  const f=fixture(),c=f.make();
  f.reply(async fn => {if(fn.endsWith('write'))return {data:{id:'ok'},error:null};throw new Error('read failed');});
  assert.deepEqual(await c.mutate('payment.record',{amount:50}),{id:'ok'});
  assert.equal(f.values.size,0); assert.equal(c.getSnapshot().error,'biz.error.request');
});
const chartSource=readFileSync(new URL('../src/business/Dashboard.jsx',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
const chartCompiled=transformSync(chartSource,{loader:'jsx',jsx:'automatic',format:'cjs'}).code;
const chartModule={exports:{}};
const responsiveModule={exports:{}};
const responsiveSource=readFileSync(new URL('../src/business/ResponsiveChart.jsx',import.meta.url),'utf8').replace(/^import .*;$/gm,'');
new Function('require','module','exports','useLayoutEffect','useRef','useState','horizontalBarGeometry',transformSync(responsiveSource,{loader:'jsx',jsx:'automatic',format:'cjs'}).code)(require,responsiveModule,responsiveModule.exports,useLayoutEffect,useRef,useState,horizontalBarGeometry);
new Function('require','module','exports','getLang','t','METRICS','chartSeries','createContext','ResponsiveChart','timeSeriesGeometry',chartCompiled)(require,chartModule,chartModule.exports,()=> 'en',k=>k,model.METRICS,model.chartSeries,createContext,responsiveModule.exports.ResponsiveChart,timeSeriesGeometry);
test('actual React chart renders negative bars, data table, and rejects misleading negative donut',()=>{
 const report={metrics:{sales:5},daily:[{date:'2026-09-01',sales:20},{date:'2026-09-02',sales:-15}],mix:[{kind:'product',amount:-15}],orders:[]};
 const render=type=>renderToStaticMarkup(createElement(chartModule.exports.BusinessChart,{widget:{type,metric:'sales'},report,onOpenOrder:()=>{}}));
 const bars=render('bar'); assert.match(bars,/<rect/);assert.match(bars,/2026-09-02/);assert.doesNotMatch(bars,/NaN|Infinity/);assert.match(bars,/<details>/);
 assert.match(render('donut'),/biz.donut.negative/); assert.doesNotMatch(render('donut'),/<circle/);
});

test('daily chart fills absent ledger days with zero within applied range', () => {
 assert.deepEqual(model.chartSeries([{date:'2026-09-01',sales:100},{date:'2026-09-03',sales:100}],'sales',{from:'2026-09-01',to:'2026-09-03'}).map(p=>p.value),[100,0,100]);
});

const dashboardModule = { exports: {} };
const dependencies = { require, module: dashboardModule, exports: dashboardModule.exports,
  getLang: () => 'en', t: key => key, useLang: () => {}, createContext, useContext, useEffect, useId, useMemo, useRef, useState,
  Modal: () => null, ModuleAddButton: () => null, ModuleGrid: () => null, Icon: () => null, InfoTip: () => null, openMenu: () => {}, window: { addEventListener() {}, removeEventListener() {} }, CHART_MODULES, businessError, ...model, ...period };
new Function(...Object.keys(dependencies), chartCompiled)(...Object.values(dependencies));
for (const populated of [false, true]) {
  test(`whole BusinessDashboard first render with ${populated ? 'existing' : 'zero'} dashboards`, () => {
    const dashboards = populated ? [model.defaultDashboard('Live sales')] : [];
    const business = { data: { settings: { dashboards, version: 1 }, customers: [], can_manage: true }, busy: false, uncertain: false,
      report: async () => { throw new Error('SSR must not run effects'); }, mutate: async () => { throw new Error('SSR must not mutate'); } };
    const html = renderToStaticMarkup(createElement(dashboardModule.exports.BusinessDashboard, { business, space: 'me', onOpenOrder: () => {} }));
    assert.match(html, /biz-dashboard/);
    assert.equal(html.includes('biz.dashboard.empty'), !populated);
    assert.equal(html.includes('Live sales'), populated);
    assert.doesNotMatch(html, /NaN|undefined/);
  });
}

function dashboardHarness() {
  const slots = [], effects = []; let cursor = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
  const hooks = {
    useState(initial) { const index = cursor++; slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slots[index].value, (next) => { slots[index].value = typeof next === 'function' ? next(slots[index].value) : next; }]; },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useMemo(factory, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++; if (!same(slots[index]?.deps, deps)) { const previous = slots[index]; slots[index] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = effect(); }); } },
    useId() { return `form-${cursor++}`; },
  };
  const target = { exports: {} }, Grid = () => null;
  const deps = { ...dependencies, ...hooks, module: target, exports: target.exports, ModuleGrid: Grid };
  new Function(...Object.keys(deps), chartCompiled)(...Object.values(deps));
  const find = (node, type) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === type) return node;
    for (const child of [node.props?.children].flat(Infinity)) { const match = find(child, type); if (match) return match; }
    return null;
  };
  return { render(business) { cursor = 0; const tree = target.exports.BusinessDashboard({ business, space: 'me', onOpenOrder() {} }); return { grid: find(tree, Grid), context: find(tree, Grid) ? findProvider(tree) : null }; }, effects() { while (effects.length) effects.shift()(); } };
  function findProvider(node) {
    if (!node || typeof node !== 'object') return null;
    if (node.props?.value?.report) return node.props.value;
    for (const child of [node.props?.children].flat(Infinity)) { const match = findProvider(child); if (match) return match; }
    return null;
  }
}

test('dashboard keeps same-scope report during refresh, clears failed or changed-scope results, and ignores stale responses', async () => {
  const requests = [], harness = dashboardHarness();
  const dashboard = model.defaultDashboard('Sales');
  let business = { scopeKey: 'alice:me', data: { settings: { dashboards: [dashboard], version: 1 }, customers: [], can_manage: true }, busy: false, uncertain: false,
    report: () => new Promise((resolve, reject) => requests.push({ resolve, reject })), mutate: async () => {} };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.render(business).grid, null); harness.effects();
  requests[0].resolve({ metrics: { sales: 100 } }); await settle();
  assert.equal(harness.render(business).context.report.metrics.sales, 100);
  business = { ...business, data: { ...business.data, settings: { ...business.data.settings, version: 2 } } };
  assert.ok(harness.render(business).grid); harness.effects();
  assert.equal(harness.render(business).context.report.metrics.sales, 100);
  requests[1].reject(new Error('network')); await settle();
  assert.equal(harness.render(business).grid, null);
  business = { ...business, data: { ...business.data } }; harness.render(business); harness.effects();
  business = { ...business, scopeKey: 'bob:me', data: { ...business.data } };
  assert.equal(harness.render(business).grid, null); harness.effects();
  requests[2].resolve({ metrics: { sales: 999 } }); await settle();
  assert.equal(harness.render(business).grid, null);
  requests[3].resolve({ metrics: { sales: 200 } }); await settle();
  assert.equal(harness.render(business).context.report.metrics.sales, 200);
  const changed = { ...dashboard, filters: { preset: 'custom', from: '2026-09-01', to: '2026-09-01', customer: null } };
  business = { ...business, data: { ...business.data, settings: { dashboards: [changed] } } };
  assert.equal(harness.render(business).grid, null); harness.effects();
  requests[4].resolve({ metrics: { sales: 300 } }); await settle();
  assert.equal(harness.render(business).context.report.metrics.sales, 300);
  business = { ...business, data: null };
  assert.equal(harness.render(business).grid, null); harness.effects();
});

// 이유(유건 9/30): 분석이 '이번 달'로 저장돼 있어 거래 탭(전체)과 숫자가 달랐다 → 기본은 전체, [이번 달·올해·전체] 버튼, 직접 고른 날짜는 그대로.
test('분석 기간: 이번 달·올해·전체(첫 거래일부터), 첫 거래일이 없으면 이번 달', () => {
  const today = new Date(2026, 8, 30);
  assert.deepEqual(period.presetPeriod('month', today, '2026-07-05'), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(period.presetPeriod('year', today, '2026-07-05'), { from: '2026-01-01', to: '2026-09-30' });
  assert.deepEqual(period.presetPeriod('all', today, '2026-07-05'), { from: '2026-07-05', to: '2026-09-30' });
  assert.deepEqual(period.presetPeriod('all', today, null), { from: '2026-09-01', to: '2026-09-30' });
  assert.deepEqual(period.presetPeriod('all', today, '2010-01-01'), { from: '2016-10-02', to: '2026-09-30' }); // 10년(3650일) 상한
  assert.deepEqual(period.resolveFilters({ preset: 'all', customer: 'c1' }, today, '2026-07-05'), { preset: 'all', customer: 'c1', from: '2026-07-05', to: '2026-09-30' });
  assert.deepEqual(period.resolveFilters({ preset: 'custom', from: '2026-08-01', to: '2026-08-31', customer: null }, today, '2026-07-05'), { preset: 'custom', from: '2026-08-01', to: '2026-08-31', customer: null });
});

test('저장된 옛 기간(프리셋 없음)은 한 번 전체로, 직접 고른 기간(custom)은 그대로', () => {
  const [old] = model.normalizeDashboards([{ id: 'd', name: 'x', widgets: [], filters: { from: '2026-09-01', to: '2026-09-30', customer: 'c1' } }]);
  assert.deepEqual(old.filters, { from: '2026-09-01', to: '2026-09-30', customer: 'c1', preset: 'all' }); // 날짜는 남긴다(서버가 시작·종료일을 요구)
  const [custom] = model.normalizeDashboards([{ id: 'd', name: 'x', widgets: [], filters: { preset: 'custom', from: '2026-08-01', to: '2026-08-31', customer: null } }]);
  assert.deepEqual(custom.filters, { preset: 'custom', from: '2026-08-01', to: '2026-08-31', customer: null });
});

test('첫 거래일 = 활동·청구입금 기록 중 가장 이른 한국 날짜', () => {
  assert.equal(period.firstDay({ activity: [{ at: '2026-07-05T03:00:00+00:00' }, { at: '2026-08-13T03:00:00+00:00' }], entries: [{ at: '2026-07-04T16:30:00+00:00' }] }), '2026-07-05');
  assert.equal(period.firstDay({ activity: [], entries: [] }), null);
});
