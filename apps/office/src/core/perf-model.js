// 성과 기록 기간 계산(유건 9/29) — 한국 날짜 문자열(YYYY-MM-DD)만 다룬다. 주는 월요일 시작, 월은 달력 1일~말일.
const D = (s) => new Date(`${s}T00:00:00Z`);
const S = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return S(d); };
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1~12

export function periodRange(unit, anchor) {
  const [y, m] = anchor.split('-').map(Number);
  if (unit === 'week') { const from = addDays(anchor, -((D(anchor).getUTCDay() + 6) % 7)); return { unit, from, to: addDays(from, 6), key: null }; }
  if (unit === 'month') { const mm = String(m).padStart(2, '0'); return { unit, from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(lastDay(y, m)).padStart(2, '0')}`, key: `${y}-${mm}` }; }
  if (unit === 'year') return { unit, from: `${y}-01-01`, to: `${y}-12-31`, key: String(y) };
  return { unit: 'day', from: anchor, to: anchor, key: null };
}

export function shiftAnchor(unit, anchor, dir) {
  if (unit === 'day') return addDays(anchor, dir);
  if (unit === 'week') return addDays(anchor, 7 * dir);
  const [y, m] = anchor.split('-').map(Number);
  if (unit === 'year') return `${y + dir}${anchor.slice(4)}`;
  const t = new Date(Date.UTC(y, m - 1 + dir, 1));
  return S(t);
}

/** 월은 그달이 끝난 다음 날부터, 연은 12월 1일부터 공유할 수 있다(서버 규칙과 같다) */
export const canShare = (key, today) => (key.length === 4 ? today >= `${key}-12-01` : periodRange('month', `${key}-01`).to < today);

export const rate = (n, d) => (d > 0 ? Math.round((n * 100) / d) : null);

/** 서버 기록을 날짜별로 — 최근 날이 먼저. 할 일은 그날 끝낸 것만 */
export function groupByDay(report) {
  const days = new Map();
  const at = (day) => { if (!days.has(day)) days.set(day, { day, deals: [], tasks: [], approvals: 0, pages: [], crew: 0, notes: [], mail: [], asks: [] }); return days.get(day); };
  for (const d of report.deals ?? []) at(d.day).deals.push(d);
  for (const t of report.tasks ?? []) if (t.done && t.day) at(t.day).tasks.push(t);
  for (const a of report.approvals ?? []) at(a.day).approvals += a.n;
  for (const p of report.pages ?? []) at(p.day).pages.push(p);
  for (const c of report.crew ?? []) at(c.day).crew += c.n;
  for (const n of report.notes ?? []) at(n.day).notes.push(n);
  for (const m of report.mail ?? []) at(m.day).mail.push(m);   // 거래처 메일(3단계)
  for (const q of report.asks ?? []) at(q.day).asks.push(q);   // 메신저 요청(3단계)
  return [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
}
