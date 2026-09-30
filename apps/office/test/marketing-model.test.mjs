import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPeriod } from '../src/business/dashboard-model.js';
import { performanceLayout, campaignBars } from '../src/business/marketing-model.js';

test('all business surfaces select the same local calendar month with UTC report boundaries', () => {
  const date = new Date(2026, 8, 28, 0, 15);
  assert.deepEqual(defaultPeriod(date), { from: '2026-09-01', to: '2026-09-28', customer: null });
});

test('saved performance order, size and hidden choices survive registry reconciliation', () => {
  const saved = [{ id: 'paid', size: 'l', hidden: true }, { id: 'sales', size: 'm', hidden: false }, { id: 'paid', size: 's' }, { id: 'unknown', size: 'full' }];
  const items = performanceLayout(saved);
  assert.equal(items.length, 9);
  assert.deepEqual(items.slice(0, 2), saved.slice(0, 2));
  assert.ok(items.slice(2).every((item) => item.hidden));
  assert.ok(performanceLayout([]).every((item) => item.hidden));
  assert.ok(performanceLayout().every((item) => !item.hidden));
});

test('negative campaign returns fall below zero without invalid or overflowing geometry', () => {
  const chart = campaignBars([{ id: 'positive', sales: 200 }, { id: 'refund', sales: -100 }, { id: 'empty', sales: 0 }]);
  assert.equal(chart.low, -100);
  assert.equal(chart.high, 200);
  const negative = chart.rows.find((row) => row.id === 'refund');
  assert.equal(negative.y, chart.baseline);
  assert.ok(negative.height > 0);
  for (const row of chart.rows) {
    for (const key of ['x', 'y', 'height', 'width']) assert.ok(Number.isFinite(row[key]));
    assert.ok(row.y >= 30 && row.y + row.height <= 174);
  }
  assert.equal(campaignBars(Array.from({ length: 25 }, (_, id) => ({ id, sales: id }))).rows.length, 20);
  assert.deepEqual(campaignBars([]).rows, []);
  assert.equal(campaignBars([{ id: 'zero', sales: 0 }]).rows[0].height, 0);
});
