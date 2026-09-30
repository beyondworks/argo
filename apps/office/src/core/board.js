// 기록판 — 메신저 행(msgr_*)을 오피스 화면 모양으로 바꾼다(순수 함수). 가져오기는 pull.js, 규칙은 test/board.test.mjs.
// 모양은 예시 데이터(data/sample.js)와 같게 둬서 화면 코드는 출처를 몰라도 된다.
import { kstDay } from './task-model.js';
import { fileKind } from './files.js';

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
  const who = new Map((rows.members ?? []).map((m) => [`${m.org_id}|${m.user_id}`, m.display_name || '']));
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
    work: (rows.runs ?? []).map((r) => ({ id: r.id, space: space(r.org_id), goal: r.goal, lead: r.lead_crew_id, status: r.status, started: r.created_at, channel: ch.get(r.channel_id) ?? '', done: r.completion_criteria ?? null })),
    approvals: (rows.approvals ?? []).map((a) => ({ id: a.id, space: space(a.org_id), crew: a.crew_id, plain: a.reason || a.action, risk: a.risk, at: a.created_at, channel: ch.get(a.channel_id) ?? '', canDecide: decidable.has(a.id) })),
    decisions: (rows.decisions ?? []).map((d) => ({ id: d.id, space: space(d.org_id), crew: d.crew_id, plain: d.reason || d.action, action: d.action, risk: d.risk ?? null, result: d.status,
      by: who.get(`${d.org_id}|${d.decided_by}`) ?? '', at: d.decided_at, asked: d.created_at ?? null, channel: ch.get(d.channel_id) ?? '' })), // 결정한 사람 = 조직 멤버 이름(9/30: 늘 '—'이던 결함)
    outputs: (rows.files ?? []).map((f) => ({ id: f.id, space: space(f.org_id), name: f.name, crew: f.msg?.crew_id ?? null, channel: ch.get(f.msg?.channel_id) ?? '', bytes: f.bytes, at: f.created_at, path: f.storage_path ?? null, mime: f.mime ?? '' })),
    docs: (rows.docs ?? []).filter((d) => !d.path.startsWith('journal/')).map((d) => ({ id: d.id, space: space(d.org_id), folder: d.path.split('/')[0], title: d.title, path: d.path, updated: d.updated_at, channel: ch.get(d.channel_id) ?? '' })),
    journal: [...days.values()].map((d) => ({ ...d, entries: d.entries.sort((a, b) => a.time.localeCompare(b.time)) })).sort((a, b) => b.date.localeCompare(a.date)),
  };
}

// ── 폴더 보기(유건 9/30) — 기록 화면 네 개(산출물·일지·결정·결재)가 같은 틀을 쓴다. 규칙은 test/folders.test.mjs.

/** 에이전트가 없는 항목(사람이 붙여 넣은 파일 등)이 모이는 폴더 */
export const HUMAN = 'people';
/** 폴더 열쇠 — 에이전트 id, id를 못 찾고 이름만 있으면(지운 에이전트의 일지) 이름, 둘 다 없으면 사람 */
export const folderKey = (crew, name) => crew || (name ? `name:${name}` : HUMAN);

/** 항목 → 폴더 목록(최근 활동순). key(x) 폴더 열쇠, at(x) 밀리초 시각. 폴더마다 건수·마지막 시각·가장 최근 항목(latest) */
export function folderize(items, key, at) {
  const m = new Map();
  for (const x of items) {
    const k = key(x), a = at(x) || 0, f = m.get(k);
    if (!f) m.set(k, { id: k, n: 1, last: a, latest: x });
    else { f.n += 1; if (a > f.last) { f.last = a; f.latest = x; } }
  }
  return [...m.values()].sort((a, b) => b.last - a.last);
}

/** ISO 시각 → 한국 날짜(YYYY-MM-DD). 비었거나 잘못된 값은 '' */
export const isoDay = (iso) => { const ms = Date.parse(iso ?? ''); return Number.isNaN(ms) ? '' : kstDay(new Date(ms)); };

const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 864e5;
const DAY = /^\d{4}-\d\d-\d\d$/;

/** 날짜 구간 — today · yesterday · week(이번 주, 월요일 시작) · month(이번 달) · m:YYYY-MM(그 이전은 월별).
 *  day·today는 한국 날짜 문자열. 날짜를 모르는 항목과 미래(시계 차이)는 오늘로 본다 */
export function dateBucket(day, today) {
  if (!DAY.test(day ?? '') || day >= today) return 'today';
  const diff = dayNum(today) - dayNum(day);
  if (diff === 1) return 'yesterday';
  const sinceMonday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
  if (diff <= sinceMonday) return 'week';
  if (day.slice(0, 7) === today.slice(0, 7)) return 'month';
  return `m:${day.slice(0, 7)}`;
}

const RANK = ['today', 'yesterday', 'week', 'month'];
/** 항목을 날짜 구간으로 묶는다 — 구간 순서는 최근 먼저, 구간 안 순서는 들어온 순서 그대로 */
export function byDate(items, dayOf, today) {
  const m = new Map();
  for (const x of items) { const k = dateBucket(dayOf(x), today); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  const rank = (k) => { const i = RANK.indexOf(k); return i < 0 ? RANK.length : i; };
  return [...m].map(([key, list]) => ({ key, items: list }))
    .sort((a, b) => rank(a.key) - rank(b.key) || (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** 일지 '전체' 폴더 — 하루 수십 건이 섞이지 않게 날짜마다 에이전트별 한 줄(건수 + 마지막 내용). entries: { day, time, ... } */
export function journalDigest(entries, key) {
  const m = new Map();
  for (const e of entries) {
    const k = `${e.day}|${key(e)}`, r = m.get(k);
    if (!r) m.set(k, { id: k, day: e.day, key: key(e), n: 1, latest: e });
    else { r.n += 1; if ((e.time ?? '') > (r.latest.time ?? '')) r.latest = e; }
  }
  return [...m.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0) || (b.latest.time ?? '').localeCompare(a.latest.time ?? ''));
}

const OFFICE_DOC = /\.(docx?|xlsx?|pptx?|hwpx?|odt|ods|odp|rtf|csv|pages|numbers|key)$/i;
/** 산출물 종류 필터 — 이미지 · 문서(미리보기 되는 글·pdf와 오피스 문서) · 기타. 미리보기 판정은 fileKind 그대로 */
export function fileGroup(name = '', mime = '') {
  const k = fileKind(name, mime);
  if (k === 'image') return 'image';
  return k === 'md' || k === 'text' || k === 'pdf' || OFFICE_DOC.test(name) ? 'doc' : 'other';
}
