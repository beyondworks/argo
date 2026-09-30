export function timeSeriesGeometry(series, width, height = 220, labelWidth = 72) {
  const values = series.map((point) => point.value);
  const low = Math.min(0, ...values), high = Math.max(0, ...values), span = high - low || 1;
  const left = Math.min(labelWidth, width * 0.35), right = Math.max(left + 1, width - 12);
  const top = 20, bottom = height - 32;
  const first = Date.parse(series[0]?.date), last = Date.parse(series.at(-1)?.date);
  const barWidth = Math.max(1, Math.min(32, (right - left) / Math.max(1, series.length) * 0.7));
  const x = (point) => first === last ? (left + right) / 2 : left + barWidth / 2 + (Date.parse(point.date) - first) / (last - first) * (right - left - barWidth);
  const y = (value) => bottom - (value - low) / span * (bottom - top);
  return { low, high, left, right, top, bottom, barWidth, baseline: y(0), points: series.map((point) => ({ ...point, x: x(point), y: y(point.value) })) };
}

export function horizontalBarGeometry(value, low, high, width) {
  const left = 0, right = Math.max(1, width), span = high - low || 1;
  const x = (amount) => left + (amount - low) / span * (right - left);
  return { baseline: x(0), x: Math.min(x(0), x(value)), width: Math.abs(x(value) - x(0)) };
}
