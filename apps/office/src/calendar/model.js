// 일정(캘린더) 순수 계산 — 날짜 문자열(YYYY-MM-DD)·반복 전개·격자·겹침 배치(유건 9/30 명세).
// 시간대: 시간 일정은 브라우저 시간대, 종일 일정·공휴일·할 일 기한·반복 규칙(UNTIL·exdates·recur_on)은 한국 날짜.
// 한국은 서머타임이 없어 "한국 날짜 n일 뒤" = 정확히 n×24시간 뒤다 — 반복 회차 시각은 첫 회차에 n×24시간을 더해 만든다.
import { KR_HOLIDAYS } from './holidays-kr.js';

const DAY = 86400e3, KST = 9 * 3600e3;
const pad = (n) => String(n).padStart(2, '0');

/** 날짜 문자열 ↔ UTC 자정 ms(날짜 계산 전용 — 시간대와 무관) */
const utc = (day) => Date.parse(`${day}T00:00:00Z`);
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day, n) => fromUtc(utc(day) + n * DAY);
export const dayDiff = (a, b) => Math.round((utc(b) - utc(a)) / DAY);
/** 요일 — 0=월 … 6=일 */
export const weekday = (day) => (new Date(utc(day)).getUTCDay() + 6) % 7;
export const mondayOf = (day) => addDays(day, -weekday(day));
export const monthOf = (day) => day.slice(0, 7);
export const addMonths = (day, n) => { const [y, m] = day.split('-').map(Number); const i = y * 12 + m - 1 + n; return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}-01`; };
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m: 1~12

/** 한국 날짜 — 시각(ms 또는 ISO) → 그 순간의 한국 날짜 */
export const kstDay = (t) => fromUtc((typeof t === 'number' ? t : Date.parse(t)) + KST);
/** 한국 날짜의 자정(한국 00:00)을 ms로 */
export const kstStart = (day) => utc(day) - KST;
/** 종일 일정 저장값 — [첫날 00:00+09, 끝날 다음 날 00:00+09) */
export const allDayRange = (first, last) => ({ starts_at: new Date(kstStart(first)).toISOString(), ends_at: new Date(kstStart(addDays(last, 1))).toISOString() });

/** 브라우저 시간대의 날짜·자정 */
export const localDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const localStart = (day) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
export const localTime = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const localAt = (day, time) => { const [y, m, d] = day.split('-').map(Number); const [h, mi] = time.split(':').map(Number); return new Date(y, m - 1, d, h, mi).getTime(); };

/** 월 보기 격자 — 그달 1일이 든 주의 월요일부터 6주(42일) */
export const monthGrid = (day) => { const first = mondayOf(`${monthOf(day)}-01`); return Array.from({ length: 42 }, (_, i) => addDays(first, i)); };
export const weekDays = (day) => { const first = mondayOf(day); return Array.from({ length: 7 }, (_, i) => addDays(first, i)); };

/* ── 반복 규칙 ── */
const RULE = /^FREQ=(DAILY|WEEKLY|MONTHLY)(?:;INTERVAL=([1-9]|[1-9][0-9]))?(?:;UNTIL=([0-9]{8}))?$/;
/** 'FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231' → { freq, interval, until: '2026-12-31' | null } — 모르는 모양은 null */
export function parseRule(rrule) {
  const m = RULE.exec(rrule ?? '');
  if (!m) return null;
  return { freq: m[1], interval: Number(m[2] ?? 1), until: m[3] ? `${m[3].slice(0, 4)}-${m[3].slice(4, 6)}-${m[3].slice(6)}` : null };
}
export function ruleString({ freq, interval = 1, until = null }) {
  if (!freq) return null;
  const n = Math.min(99, Math.max(1, Math.floor(Number(interval) || 1)));
  return `FREQ=${freq}${n > 1 ? `;INTERVAL=${n}` : ''}${until ? `;UNTIL=${until.replaceAll('-', '')}` : ''}`;
}

/** 반복 회차의 한국 날짜들 — lo~hi(포함) 안에서만, 첫 회차(d0) 이전은 없다. 매월은 시작일 날짜가 없는 달을 건너뛴다 */
export function seriesDays(d0, rule, lo, hi) {
  const out = [], last = rule.until && rule.until < hi ? rule.until : hi;
  if (last < d0) return out;
  if (rule.freq === 'MONTHLY') {
    const [y0, m0, dom] = d0.split('-').map(Number), i0 = y0 * 12 + m0 - 1;
    const [ly, lm] = lo.split('-').map(Number);
    for (let k = Math.max(0, Math.floor((ly * 12 + lm - 1 - i0) / rule.interval)); out.length < 500; k++) {
      const i = i0 + k * rule.interval, y = Math.floor(i / 12), m = (i % 12) + 1;
      const first = `${y}-${pad(m)}-01`;
      if (first > last) break;
      if (dom > daysInMonth(y, m)) continue;
      const day = `${y}-${pad(m)}-${pad(dom)}`;
      if (day > last) break;
      if (day >= lo) out.push(day);
    }
    return out;
  }
  const step = rule.interval * (rule.freq === 'WEEKLY' ? 7 : 1);
  for (let k = Math.max(0, Math.floor(dayDiff(d0, lo) / step)); out.length < 1000; k++) {
    const day = addDays(d0, k * step);
    if (day > last) break;
    if (day >= lo) out.push(day);
  }
  return out;
}

/** 서버가 준 일정 행 → [from, to) 안의 회차. 회차 = 행 + { key, start, end, occ(반복 회차의 원래 한국 날짜 | null), series(반복 원본 | null) }.
 *  exdates 날짜와 '이번만 수정'한 회차(parent_id + recur_on 행이 있는 날짜)는 원본 전개에서 뺀다 — 수정한 행은 따로 한 건으로 나온다. */
export function expand(rows, from, to) {
  const moved = new Set(rows.filter((r) => r.parent_id && r.recur_on).map((r) => `${r.parent_id}|${r.recur_on}`));
  const out = [];
  for (const r of rows) {
    const s = Date.parse(r.starts_at), e = Date.parse(r.ends_at);
    const rule = r.rrule ? parseRule(r.rrule) : null;
    if (!rule) { if (s < to && e > from) out.push({ ...r, key: r.id, start: s, end: e, occ: null, series: null }); continue; }
    const d0 = kstDay(s), ex = new Set(r.exdates ?? []);
    for (const day of seriesDays(d0, rule, kstDay(from - (e - s)), kstDay(to))) {
      if (ex.has(day) || moved.has(`${r.id}|${day}`)) continue;
      const os = s + dayDiff(d0, day) * DAY, oe = os + (e - s);
      if (os < to && oe > from) out.push({ ...r, key: `${r.id}|${day}`, start: os, end: oe, occ: day, series: r });
    }
  }
  return out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || a.title.localeCompare(b.title));
}

/** 회차가 차지하는 날짜(포함 범위) — 종일은 한국 날짜, 시간 일정은 브라우저 날짜 */
export const spanOf = (o) => (o.all_day ? [kstDay(o.start), kstDay(o.end - 1)] : [localDay(o.start), localDay(Math.max(o.start, o.end - 1))]);
/** 막대로 그릴 것 — 종일이거나 24시간 이상 */
export const isBar = (o) => o.all_day || o.end - o.start >= DAY;

/** 겹치는 시간 일정을 나란히 — items: { key, start, end }(분). 겹침이 이어진 무리마다 열을 나눈다 → Map(key → { col, cols }) */
export function layoutDay(items, minLen = 20) {
  const list = items.map((x) => ({ ...x, end: Math.max(x.end, x.start + minLen) })).sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map();
  let group = [], ends = [], groupEnd = -Infinity;
  const flush = () => { for (const g of group) out.set(g.key, { col: g.col, cols: ends.length }); group = []; ends = []; };
  for (const x of list) {
    if (x.start >= groupEnd) { flush(); groupEnd = -Infinity; }
    let col = ends.findIndex((end) => end <= x.start);
    if (col < 0) { col = ends.length; ends.push(x.end); } else ends[col] = x.end;
    group.push({ key: x.key, col });
    groupEnd = Math.max(groupEnd, x.end);
  }
  flush();
  return out;
}

/** 한 주(7칸) 안의 막대·칩을 줄(lane)로 — segs: { key, a, b }(칸 번호, 포함). 먼저 시작하고 긴 것부터 가장 위 빈 줄에 */
export function packLanes(segs) {
  const lanes = [], out = new Map();
  for (const s of [...segs].sort((x, y) => x.a - y.a || (y.b - y.a) - (x.b - x.a))) {
    let i = lanes.findIndex((used) => !used.some(([a, b]) => s.a <= b && a <= s.b));
    if (i < 0) { i = lanes.length; lanes.push([]); }
    lanes[i].push([s.a, s.b]);
    out.set(s.key, i);
  }
  return out;
}

/* ── 공휴일 ── */
let HOLI = null;
/** 그날의 공휴일·기념일 — [{ name, off }](off=true: 쉬는 날, 빨간 날짜) */
export function holidaysOn(day) {
  if (!HOLI) { HOLI = new Map(); for (const [d, name, off] of KR_HOLIDAYS) HOLI.set(d, [...(HOLI.get(d) ?? []), { name, off: off === 1 }]); }
  return HOLI.get(day) ?? [];
}

/* ── 색 기준 ── */
/** 문자열 → 0~n-1(같은 값은 늘 같은 색) */
export function hashIndex(s, n) { let h = 2166136261; for (const c of String(s)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619) >>> 0; } return h % n; }
/** 색을 정할 값 — 분류(없으면 중립)·사람(주인)·에이전트(사람이 만든 것은 중립) */
export function colorKey(o, by) {
  if (by === 'agent') return o.crew ? { agent: o.crew } : null;
  if (by === 'person') return o.owner ? { hash: `p:${o.owner}` } : null;
  return o.category ? { hash: `c:${o.category}` } : null;
}

/* ── 기간 ── */
/** 보기별로 서버에서 읽을 한국 날짜 창 [from, to) — 주·일 보기는 그달 격자를 같이 읽어 보기를 바꿔도 다시 읽지 않는다 */
export function windowOf(view, anchor) {
  if (view === 'list') return [anchor, addDays(anchor, 31)];
  if (view === 'customers') return [addDays(anchor, -90), addDays(anchor, 270)];
  const g = monthGrid(anchor);
  return [addDays(g[0], -1), addDays(g[41], 2)]; // 시간대 차이(브라우저 ↔ 한국)로 격자 끝에 걸치는 일정까지
}
/** ‹ › 한 번에 옮기는 양 */
export function shift(view, anchor, dir) {
  if (view === 'day') return addDays(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'list') return addDays(anchor, 30 * dir);
  return addMonths(anchor, dir);
}
