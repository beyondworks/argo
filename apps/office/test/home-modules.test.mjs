import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import { createContext, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OFFICE_MODULES, BUSINESS_MODULES, CHART_MODULES } from '../src/core/module-registry.js';
import { linkedTotals, effectOf } from '../src/business/marketing-model.js';

test('shared registry preserves legacy modules and exposes all eight business home cards', () => {
  assert.deepEqual(OFFICE_MODULES.filter((m) => !m.businessTab).map((m) => m.id), ['stats','approvals','mail','calendar','todos','pages','work','outputs','journal','decisions']);
  assert.equal(new Set(OFFICE_MODULES.map((m) => m.id)).size, OFFICE_MODULES.length);
  assert.deepEqual(BUSINESS_MODULES.map((m) => m.businessTab), ['customers','catalog','orders','inventory','payments','analytics','marketing','performance']);
  for (const module of BUSINESS_MODULES) {
    assert.equal(module.id, `biz-${module.businessTab}`);
    assert.equal(module.link, `/business/${module.businessTab}`);
    assert.deepEqual(module.spaces, ['me', 'org']);
  }
  for (const module of [...OFFICE_MODULES, ...CHART_MODULES]) assert.ok(module.sizes.includes(module.defaultSize));
});

const source = readFileSync(new URL('../src/business/HomeModules.jsx', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
const compiled = transformSync(source, { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code;
const module = { exports: {} };
let context;
const dependencies = { require: createRequire(import.meta.url), module, exports: module.exports, createContext, useContext: () => context, t: (key) => key, getLang: () => 'en', baseOf: (space) => space === 'me' ? '/me' : `/o/${space}`, Link: ({ to, ...props }) => createElement('a', { href: to, ...props }), InfoTip: ({ text }) => createElement('span', { className: 'info-tip' }, text), linkedTotals, effectOf, Hide: ({ children }) => children }; // Hide = 가림(12차, 그리기 시험에서는 값 그대로). 집계 기준은 (i) 안에 — 문구가 카드에 실제로 실리는지 본다
new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
const card = (tab) => renderToStaticMarkup(createElement(module.exports.BusinessHomeCard, { space: 'me', tab }));
const data = { settings: { enabled: BUSINESS_MODULES.map((m) => m.businessTab) }, customers: [{ id: 'c1', name: 'Actual customer', email: 'test@example.invalid' }], items: [{ id: 'p1', kind: 'product', name: 'Actual product', price: 300, stock: 7, reserved: 2 }], orders: [{ id: 'o1', title: 'Actual order', status: 'confirmed' }] };

test('home cards use actual scoped rows and link to original records', () => {
  context = { business: { data }, summary: null };
  assert.match(card('customers'), /Actual customer/);
  assert.match(card('catalog'), /Actual product/);
  assert.match(card('orders'), /href="\/me\/business\/orders\?open=o1"/);
  assert.match(card('inventory'), /bizui.available: 5/);
});

test('disabled, failed and loading cards never substitute fake financial zeroes', () => {
  context = { business: { data: null, error: 'biz.error.permission' } };
  assert.match(card('analytics'), /role="alert"/);
  assert.doesNotMatch(card('analytics'), /₩|biz.metric.sales/);
  context = { business: { data: null } };
  assert.match(card('analytics'), /biz.loading/);
  context = { business: { data: { ...data, settings: { enabled: [] } } } };
  assert.match(card('customers'), /bizui.disabled/);
  assert.doesNotMatch(card('customers'), /Actual customer/);
  context = { business: { data }, summary: { error: 'biz.error.request' } };
  assert.match(card('payments'), /biz.error.request/);
  assert.doesNotMatch(card('payments'), /₩/);
});

test('financial cards display server report metrics and the cumulative balance boundary', () => {
  context = { business: { data }, summary: { report: { metrics: { sales: 1100000, invoiced: 1100000, paid: 500000, receivable: 600000 } } }, from: '2026-09-01', to: '2026-09-28' };
  const html = card('analytics');
  for (const amount of ['1,100,000', '500,000', '600,000']) assert.ok(html.includes(amount));
  assert.match(html, /2026-09-01/);
  assert.match(html, /biz.home.balanceThrough/);
});

test('marketing card lists actual campaigns and links to the marketing module', () => {
  context = { business: { data }, marketing: { data: { campaigns: Array.from({ length: 5 }, (_, index) => ({ id: `campaign-${index}`, name: `Actual campaign ${index}`, channel: 'Search', status: 'active' })) } } };
  const html = card('marketing');
  assert.match(html, /Actual campaign 0/);
  assert.match(html, /Search · mkt.status.active/);
  assert.match(html, /href="\/me\/business\/marketing"/);
  assert.doesNotMatch(html, /Actual campaign 4/);
});

test('marketing performance distinguishes missing reports, read failures and undefined ROAS from zero', () => {
  context = { business: { data }, marketing: { data: null } };
  assert.match(card('performance'), /biz.loading/);
  assert.doesNotMatch(card('performance'), /₩/);
  context.marketing.error = 'biz.error.permission';
  assert.match(card('performance'), /role="alert"/);
  assert.doesNotMatch(card('performance'), /mkt.metric.spend/);
  context = { business: { data }, marketing: { data: { campaigns: [] } }, performance: { error: 'biz.error.request' } };
  assert.match(card('performance'), /biz.error.request/);
  // 홈 카드도 마케팅 탭과 같이 광고와 연결된 거래만 센다 — 연결 안 된 매출(5,000)이 광고 효과를 부풀리지 않게(분리 검수 M3)
  context.performance = { report: { metrics: { spend: 0, sales: 5100, paid: 5050, roas: null }, campaigns: [{ id: 'a', spend: 0, sales: 100, paid: 50 }, { id: null, spend: 0, sales: 5000, paid: 5000 }] } };
  let html = card('performance');
  assert.match(html, /₩100/); assert.doesNotMatch(html, /5,100/);
  assert.match(html, /mkt.ratio.na/);
  assert.doesNotMatch(html, /NaN|Infinity/);
  assert.doesNotMatch(html, /biz.home.open/); // '모두 보기'는 카드 머리에만 — 본문에 같은 링크를 또 두지 않는다(유건 9/29)
  context.performance.report.campaigns[0].spend = 40;
  html = card('performance');
  assert.match(html, /mkt.times/); // 광고 효과는 %가 아니라 "광고비의 N배"로(유건 9/29)
  assert.doesNotMatch(html, /mkt.ratio.na/);
  context.business.data = { ...data, settings: { enabled: [] } };
  assert.match(card('performance'), /bizui.disabled/);
  assert.doesNotMatch(card('performance'), /mkt.metric.spend/);
});
