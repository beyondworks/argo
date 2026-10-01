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

/** 마우스 위치(x)에 가장 가까운 점의 번호(유건 9/30: 그래프에 올리면 가장 가까운 날짜의 값). 점이 없으면 -1 */
export function nearestIndex(points, x) {
  let best = -1, gap = Infinity;
  points.forEach((point, index) => { const d = Math.abs(point.x - x); if (d < gap) { gap = d; best = index; } });
  return best;
}

/** 짧은 금액 — 한국어는 만·억 단위(₩2,381만), 영어는 Intl 축약(₩23.8M). 1만 원 미만은 그대로 */
export function shortMoney(value, lang = 'ko') {
  const n = Number(value) || 0, abs = Math.abs(n), sign = n < 0 ? '-' : '';
  if (lang === 'en') return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'KRW', notation: abs >= 1e4 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n);
  const unit = (n) => new Intl.NumberFormat('ko-KR', { notation: 'compact' }).formatToParts(n).find((part) => part.type === 'compact')?.value ?? ''; // 만·억(사전 대신 Intl에서)
  if (abs >= 1e8) return `${sign}₩${(abs / 1e8).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}${unit(1e8)}`;
  if (abs >= 1e4) return `${sign}₩${Math.round(abs / 1e4).toLocaleString('ko-KR')}${unit(1e4)}`;
  return `${sign}₩${abs.toLocaleString('ko-KR')}`;
}
