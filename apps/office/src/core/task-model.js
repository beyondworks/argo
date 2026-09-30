// 할 일 묶기(성과 기록 1단계, 유건 9/29). 날짜는 한국 기준 — 서버의 기한 준수율 계산과 같은 날짜를 쓴다.
export const kstDay = (date = new Date()) => new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const days = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3);

/** 기한까지 남은 날 — null(기한 없음) | { key: overdue|today|tomorrow|left, n } */
export function dueInfo(due, today) {
  if (!due) return null;
  const n = days(today, due);
  return n < 0 ? { key: 'overdue', n: -n } : n === 0 ? { key: 'today', n: 0 } : n === 1 ? { key: 'tomorrow', n: 1 } : { key: 'left', n };
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
