// 기록판 — 메신저 행(msgr_*)을 오피스 화면 모양으로 바꾼다(순수 함수). 가져오기는 pull.js, 규칙은 test/board.test.mjs.
// 모양은 예시 데이터(data/sample.js)와 같게 둬서 화면 코드는 출처를 몰라도 된다.

const LINE = /^- (\d\d:\d\d) · \*\*(.+?)\*\*(?: ← ([^:]+): (.*?))? → (.*)$/;

/** 크루 일지 본문(트리거 msgr_channel_journal이 쌓는 줄) → 항목들. 형식이 다른 줄은 버린다 */
export function parseJournal(body) {
  return String(body ?? '').split('\n').map((l) => LINE.exec(l.trim())).filter(Boolean)
    .map(([, time, crew, who, ask, text]) => ({ time, crew, who: who ?? null, ask: ask ?? null, text }));
}

/** rows: { crews, runs, approvals, decisions, files, channels, journals }, orgKey: org_id → 공간 키, decidable: 결재권 있는 결재 id 집합 */
export function mapBoard(rows, { orgKey, decidable }) {
  const space = (org) => orgKey.get(org) ?? null;
  const ch = new Map((rows.channels ?? []).map((c) => [c.id, c.kind === 'dm' ? 'DM' : c.name]));
  const leading = new Set((rows.runs ?? []).filter((r) => r.status === 'running').map((r) => r.lead_crew_id));
  const asking = new Set((rows.approvals ?? []).map((a) => a.crew_id));
  const crews = (rows.crews ?? []).map((c) => ({
    id: c.id, name: c.display_name, role: c.department || c.role_text || '', owner: c.owner_user_id, space: space(c.org_id), face: c.face ?? null,
    status: leading.has(c.id) ? 'work' : asking.has(c.id) ? 'ask' : 'idle',
  }));
  const byName = (org, name) => (rows.crews ?? []).find((c) => c.org_id === org && c.display_name === name)?.id ?? null;
  const days = new Map();
  for (const d of rows.journals ?? []) {
    const k = `${d.org_id}|${d.title}`;
    const entries = parseJournal(d.body).map((e) => ({ time: e.time, crew: byName(d.org_id, e.crew), name: e.crew, text: e.text }));
    if (!days.has(k)) days.set(k, { space: space(d.org_id), date: d.title, entries: [] });
    days.get(k).entries.push(...entries);
  }
  return {
    crews,
    work: (rows.runs ?? []).map((r) => ({ id: r.id, space: space(r.org_id), goal: r.goal, lead: r.lead_crew_id, status: r.status, started: r.created_at, channel: ch.get(r.channel_id) ?? '' })),
    approvals: (rows.approvals ?? []).map((a) => ({ id: a.id, space: space(a.org_id), crew: a.crew_id, plain: a.reason || a.action, risk: a.risk, at: a.created_at, channel: ch.get(a.channel_id) ?? '', canDecide: decidable.has(a.id) })),
    decisions: (rows.decisions ?? []).map((d) => ({ id: d.id, space: space(d.org_id), crew: d.crew_id, plain: d.reason || d.action, result: d.status, by: '', at: d.decided_at })),
    outputs: (rows.files ?? []).map((f) => ({ id: f.id, space: space(f.org_id), name: f.name, crew: f.msg?.crew_id ?? null, channel: ch.get(f.msg?.channel_id) ?? '', bytes: f.bytes, at: f.created_at })),
    journal: [...days.values()].map((d) => ({ ...d, entries: d.entries.sort((a, b) => a.time.localeCompare(b.time)) })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
