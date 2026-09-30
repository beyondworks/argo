// 기록판 — 메신저 행(msgr_*)을 오피스 화면 모양으로 바꾼다(순수 함수). 가져오기는 pull.js, 규칙은 test/board.test.mjs.
// 모양은 예시 데이터(data/sample.js)와 같게 둬서 화면 코드는 출처를 몰라도 된다.

const LINE = /^- (\d\d:\d\d) · \*\*(.+?)\*\*(?: ← ([^:]+): (.*?))? → (.*)$/;

/** 크루 일지 본문(트리거 msgr_channel_journal이 쌓는 줄) → 항목들. 형식이 다른 줄은 버린다 */
export function parseJournal(body) {
  return String(body ?? '').split('\n').map((l) => LINE.exec(l.trim())).filter(Boolean)
    .map(([, time, crew, who, ask, text]) => ({ time, crew, who: who ?? null, ask: ask ?? null, text }));
}

const txt = (s) => { const t = s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim(); return t ? [{ type: 'text', text: t }] : undefined; };
const para = (s) => { const c = txt(s); return c ? { type: 'paragraph', content: c } : { type: 'paragraph' }; };

/** 공용 문서 마크다운 → 편집기 문서 모양(제목·글머리 목록·문단). HTML 문자열은 만들지 않는다(화면은 DocView로만 그린다) */
export function mdToDoc(md) {
  const out = [];
  let list = null;
  for (const raw of String(md ?? '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line), li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { (list ??= (out.push({ type: 'bulletList', content: [] }), out.at(-1))).content.push({ type: 'listItem', content: [para(li[1])] }); continue; }
    list = null;
    if (!line.trim()) continue;
    if (h) { const c = txt(h[2]); out.push(c ? { type: 'heading', attrs: { level: h[1].length }, content: c } : { type: 'heading', attrs: { level: h[1].length } }); continue; }
    out.push(para(line));
  }
  return { type: 'doc', content: out };
}

/** rows: { crews, runs, approvals, decisions, files, channels, journals, docs }, orgKey: org_id → 공간 키, decidable: 결재권 있는 결재 id 집합 */
export function mapBoard(rows, { orgKey, decidable }) {
  const space = (org) => orgKey.get(org) ?? null;
  const ch = new Map((rows.channels ?? []).map((c) => [c.id, c.kind === 'dm' ? 'DM' : c.name]));
  const leading = new Set((rows.runs ?? []).filter((r) => r.status === 'running').map((r) => r.lead_crew_id));
  const asking = new Set((rows.approvals ?? []).map((a) => a.crew_id));
  const crews = (rows.crews ?? []).map((c) => ({
    id: c.id, name: c.display_name, role: c.department || c.role_text || '', dept: c.department || '', job: c.role_text || '', owner: c.owner_user_id, space: space(c.org_id), org: c.org_id, face: c.face ?? null,
    status: leading.has(c.id) ? 'work' : asking.has(c.id) ? 'ask' : 'idle',
    // 좌측 목록 정리(9/30): 주인·쓸 수 있는지(메신저와 같은 판정)·내 고정/순서 — office_crew_list가 없을 때(옛 DB)는 모두 쓸 수 있는 것으로
    ownerName: c.owner_name ?? null, company: !!c.company, access: c.access ?? 'ok', pinned: !!c.pinned, pinPos: c.pin_pos ?? null, sortPos: c.sort_pos ?? null,
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
    docs: (rows.docs ?? []).filter((d) => !d.path.startsWith('journal/')).map((d) => ({ id: d.id, space: space(d.org_id), folder: d.path.split('/')[0], title: d.title, path: d.path, updated: d.updated_at, channel: ch.get(d.channel_id) ?? '' })),
    journal: [...days.values()].map((d) => ({ ...d, entries: d.entries.sort((a, b) => a.time.localeCompare(b.time)) })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}
