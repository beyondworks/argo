import test from 'node:test';
import assert from 'node:assert/strict';
import { timeSeriesGeometry, horizontalBarGeometry, nearestIndex, shortMoney } from '../src/business/chart-geometry.js';

const series = [{ date: '2026-09-01', value: -25 }, { date: '2026-09-02', value: 100 }];
test('chart plot expands to the measured card width without changing its height', () => {
  const narrow = timeSeriesGeometry(series, 280), wide = timeSeriesGeometry(series, 1100);
  assert.equal(wide.right, 1088);
  assert.equal(wide.top, narrow.top);
  assert.equal(wide.bottom, narrow.bottom);
  assert.ok(wide.points[1].x > 1000);
  for (const chart of [narrow, wide]) {
    for (const point of chart.points) {
      assert.ok(point.x - chart.barWidth / 2 >= chart.left);
      assert.ok(point.x + chart.barWidth / 2 <= chart.right);
      assert.ok(point.y >= chart.top && point.y <= chart.bottom);
    }
    assert.ok(chart.baseline > chart.top && chart.baseline < chart.bottom);
  }
});

test('single-day and zero series retain finite centered coordinates', () => {
  const chart = timeSeriesGeometry([{ date: '2026-09-01', value: 0 }], 300);
  assert.equal(chart.points[0].x, (chart.left + chart.right) / 2);
  assert.equal(chart.points[0].y, chart.baseline);
  assert.ok(Number.isFinite(chart.baseline));
});

test('horizontal bars share a zero baseline with negative amounts extending left', () => {
  const negative = horizontalBarGeometry(-25, -25, 100, 280);
  const positive = horizontalBarGeometry(100, -25, 100, 280);
  assert.equal(negative.baseline, positive.baseline);
  assert.equal(negative.x + negative.width, negative.baseline);
  assert.equal(positive.x, positive.baseline);
  assert.equal(positive.x + positive.width, 280);
  assert.equal(negative.x, 0);
  assert.equal(horizontalBarGeometry(0, 0, 0, 280).width, 0);
});

// 유건 9/30: 그래프에 마우스를 올리면 가장 가까운 날짜의 세로선·점과 '날짜 · 값'
test('hover picks the nearest date and formats the value short', () => {
  const chart = timeSeriesGeometry([{ date: '2026-09-01', value: 1 }, { date: '2026-09-02', value: 2 }, { date: '2026-09-03', value: 3 }], 600);
  const [a, b, c] = chart.points.map((p) => p.x);
  assert.equal(nearestIndex(chart.points, a - 50), 0);
  assert.equal(nearestIndex(chart.points, b + (c - b) * 0.4), 1);
  assert.equal(nearestIndex(chart.points, c + 50), 2);
  assert.equal(nearestIndex([], 10), -1);
  assert.equal(shortMoney(23810000), '₩2,381만');
  assert.equal(shortMoney(-23810000), '-₩2,381만');
  assert.equal(shortMoney(123000000), '₩1.23억');
  assert.equal(shortMoney(9500), '₩9,500');
  assert.equal(shortMoney(23810000, 'en'), '₩23.8M');
});
