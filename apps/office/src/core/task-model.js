// 할 일 묶기(성과 기록 1단계, 유건 9/29). 날짜는 한국 기준 — 서버의 기한 준수율 계산과 같은 날짜를 쓴다.
export const kstDay = (date = new Date()) => new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3);

/** 기한까지 남은 날 — null(기한 없음) | { key: overdue|today|tomorrow|left, n } */
export function dueInfo(due, today) {
  if (!due) return null;
  const n = days(today, due);
  return n < 0 ? { key: 'overdue', n: -n } : n === 0 ? { key: 'today', n: 0 } : n === 1 ? { key: 'tomorrow', n: 1 } : { key: 'left', n };
}

/** 메뉴 배지·홈 '챙길 것'(18차)의 할 일 수 — 내가 맡은 일 중 안 끝낸·안 취소한 일의 기한 지남·오늘 마감. 아직 안 읽었으면(rows 없음) null — 배지를 0으로 보이지 않게.
 *  날짜는 한국 자정 기준(서버 기한 준수율·홈 현황 카드와 같은 날짜) — 브라우저 시간대가 달라도 같은 수. now = 시각(ms) 또는 한국 날짜 'YYYY-MM-DD' */
export function dueCounts(rows, now, me) {
  if (!rows) return null;
  const g = groupTasks(rows.filter((r) => !r.cancelled_at), typeof now === 'string' ? now : kstDay(new Date(now)), me);
  return { overdue: g.overdue.length, today: g.today.length };
}

/** 할 일 화면이 겹쳐 보는 조직 — 속한 조직 중 손님이 아닌 곳(calendar/shared.js writableOrgs와 같은 기준) */
export const taskOrgKeys = (spaces) => spaces.filter((s) => s.kind === 'org' && s.role !== 'guest').map((s) => s.key);
/** 이 공간의 할 일 — 할 일 화면(views/data.js useViewTasks)·메뉴 배지·챙길 것이 같이 쓴다(18차 검수 M4: 셋의 건수가 같게).
 *  개인 공간은 내 할 일 + 이미 읽어 둔 조직 할 일(orgRows: 조직 키 → 행) 중 나에게 맡겨진 것. 행마다 어느 공간의 것인지(space)를 붙인다. own이 없으면(아직 안 읽음) undefined */
export function viewRows({ space, own, orgRows, orgKeys = [], me }) {
  if (!own) return undefined;
  const tag = (key) => (x) => ({ ...x, space: key });
  return [...own.map(tag(space)), ...(space === 'me' ? orgKeys.flatMap((k) => (orgRows?.get(k) ?? []).filter((x) => x.assignee === me).map(tag(k))) : [])];
}

/** 내가 맡은 일은 기한별(지남·오늘·7일 안·나중·기한 없음), 내가 남에게 맡긴 일(gave), 관리자에게만 보이는 다른 사람 일(others), 끝낸 일(done) */
export function groupTasks(rows, today, me) {
  const g = { overdue: [], today: [], week: [], later: [], none: [], gave: [], others: [], done: [] };
  for (const r of rows) {
    if (r.done_at) g.done.push(r);
    else if (r.assignee !== me) (r.created_by === me ? g.gave : g.others).push(r);
    else if (!r.due_on) g.none.push(r);
    else { const n = days(today, r.due_on); g[n < 0 ? 'overdue' : n === 0 ? 'today' : n <= 7 ? 'week' : 'later'].push(r); }
  }
  g.done.sort((a, b) => Date.parse(b.done_at) - Date.parse(a.done_at));
  return g;
}
