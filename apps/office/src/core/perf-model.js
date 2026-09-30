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

// 주간·월간·연간 기록 접기(유건 9/30) — 날짜·월마다 한 줄 요약. 칩 순서는 펼친 항목 배지 순서와 같다
export const SUMMARY_KEYS = ['contract', 'uncontract', 'invoice', 'credit', 'payment', 'refund', 'task', 'approval', 'page', 'crew', 'mail_good', 'mail_normal', 'mail_caution', 'ask', 'note'];
const CONTRACT_KINDS = new Set(['contract', 'uncontract']); // 서버 totals.contract와 같은 기준(취소는 이미 음수 금액)

const counts = (d) => {
  const c = Object.fromEntries(SUMMARY_KEYS.map((k) => [k, 0]));
  for (const x of d.deals) if (x.kind in c) c[x.kind] += 1;
  c.task = d.tasks.length; c.approval = d.approvals; c.page = d.pages.length; c.crew = d.crew;
  for (const m of d.mail) if (`mail_${m.grade}` in c) c[`mail_${m.grade}`] += 1;
  c.ask = d.asks.length; c.note = d.notes.length;
  return c;
};
const chipsOf = (c) => SUMMARY_KEYS.filter((k) => c[k] > 0).map((k) => ({ key: k, n: c[k] }));

/** 하루 요약 — 칩(0건 제외)과 계약 금액(계약·취소가 없는 날은 null, 같은 날 계약+취소면 차감한 값) */
export function daySummary(d) {
  const contract = d.deals.filter((x) => CONTRACT_KINDS.has(x.kind));
  return { day: d.day, chips: chipsOf(counts(d)), amount: contract.length ? contract.reduce((a, x) => a + Number(x.amount || 0), 0) : null };
}

/** groupByDay 결과를 월(YYYY-MM)로 — 최근 달이 먼저, 달 안의 날짜 순서는 그대로 */
export function groupByMonth(days) {
  const months = new Map();
  for (const d of days) {
    const key = d.day.slice(0, 7);
    if (!months.has(key)) months.set(key, { month: key, days: [], c: Object.fromEntries(SUMMARY_KEYS.map((k) => [k, 0])), amount: null });
    const m = months.get(key), s = daySummary(d), c = counts(d);
    m.days.push(d);
    for (const k of SUMMARY_KEYS) m.c[k] += c[k];
    if (s.amount != null) m.amount = (m.amount ?? 0) + s.amount;
  }
  return [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1)).map(({ month, days: ds, c, amount }) => ({ month, days: ds, chips: chipsOf(c), amount }));
}
