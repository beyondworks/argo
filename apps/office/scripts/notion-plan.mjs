// Notion → 오피스 일회 이관 계획(트랙 C, 유건 10/2 "한 번 옮기고 오피스가 원본"). 네트워크·DB 없이 순수 변환만 — 실행은 notion-migrate.mjs.
// 원본: 인트라넷이 쓰던 Notion DB 그대로(lib/integrations/notion.ts의 속성 이름). 이관이지 연동이 아니다 — Notion 링크·동기화는 두지 않는다.
//   · Beyond_Tasks(일정+업무 통합 DB) → 시각·장소가 있는 항목은 오피스 일정, 날짜만 있는 항목은 오피스 할 일(일정 화면에 기한으로 같이 보인다)
//   · 워크보드 페이지 트리 → 조직 위키 '워크보드' 아래 같은 구조(본문 블록 → 오피스 편집기 문서)
//   · 회사정보 DB → 회사 정보 항목(잘 알려진 항목은 서식 칸 key)
//   · 인사고과 레포트 DB → 평가 레포트(작성자·작성 시각·기간 글 유지)
//   · 인트라넷 직원(board.db, Notion 아님) → 직원 명부(CLI 토큰은 옮기지 않는다)
import { createHash } from 'node:crypto';
import { guessKey, CATEGORY_FROM_KO } from '../src/core/company-model.js';
import { SCOPE_FROM_KO, TYPE_FROM_KO, parsePeriod, SCORE_KEYS } from '../src/core/eval-model.js';
import { agentLabel } from '../src/core/people-model.js';
import { between } from '../src/core/position.js';
import { safeHref } from '../src/core/blocks-model.js';

// Beyond_Tasks·회사정보·레포트 속성 이름(Notion 정본 — 인트라넷과 같다)
export const P = { title: 'Entry name', date: 'Date', status: 'Status', category: 'Category', relation: 'Relation', completed: 'Completed', location: 'Location (Entry)', notes: 'Notes', priority: '우선순위', automatable: '자동화', agent: '담당', source: '출처' };
export const CI = { item: '항목', value: '값', category: '분류', notes: '메모' };
export const R = { title: '제목', scope: '평가범위', subject: '평가대상', subjectType: '대상유형', period: '기간', performance: '업무성과', quality: '업무품질', productivity: '생산성', expertise: '전문성', collaboration: '협업태도', total: '종합점수', review: '총평', author: '작성자', weeklyTasks: '주차별_업무내용', weeklyAchievements: '주차별_성과' };
const NOTE_LABEL = { status: '상태', category: '카테고리', priority: '우선순위', agent: '담당', automatable: '자동화', source: '출처', done: '완료', fromNotion: '노션에서 옮김' };

/** 재실행 안전한 id — (이관·조직·종류·원본 id)로 늘 같은 uuid */
export function stableId(org, ...parts) {
  const h = createHash('sha256').update(['notion-migrate', org ?? 'me', ...parts].join(':')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export const plain = (arr) => (Array.isArray(arr) ? arr.map((x) => x?.plain_text ?? x?.text?.content ?? '').join('') : '');
const prop = (page, k) => page?.properties?.[k];
const sel = (p) => p?.select?.name ?? p?.status?.name ?? null;
const num = (p) => (typeof p?.number === 'number' ? p.number : null);
const clip = (s, n) => String(s ?? '').slice(0, n);
const kstDay = (iso) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);
const addDay = (d, n = 1) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const kstMidnight = (d) => `${d}T00:00:00+09:00`;

/** Beyond_Tasks 한 줄 → 정규화(인트라넷 normalize와 같은 칸). 날짜 없는 줄은 start null(기한 없는 할 일로 옮긴다 — 인트라넷 동기화는 건너뛰던 줄) */
export function normalizeEntry(page, parentNames = new Map()) {
  const date = prop(page, P.date)?.date;
  const rel = prop(page, P.relation)?.relation ?? [];
  return {
    id: page.id, title: plain(prop(page, P.title)?.title) || '(제목 없음)', start: date?.start ?? null, end: date?.end ?? null,
    status: sel(prop(page, P.status)), category: (rel[0] && parentNames.get(rel[0].id)) || sel(prop(page, P.category)),
    completed: !!prop(page, P.completed)?.checkbox, location: plain(prop(page, P.location)?.rich_text), notes: plain(prop(page, P.notes)?.rich_text),
    priority: sel(prop(page, P.priority)), automatable: plain(prop(page, P.automatable)?.rich_text), agent: plain(prop(page, P.agent)?.rich_text), source: sel(prop(page, P.source)),
    created: page.created_time ?? null, edited: page.last_edited_time ?? null,
  };
}

/** 일정인가 할 일인가 — 시각이 있거나 장소가 있으면 일정, 날짜만이면 할 일 */
export const isEvent = (e) => !!e.start && (e.start.includes('T') || !!e.location);
const done = (e) => e.completed || e.status === 'Completed';
function metaNote(e, keys) {
  const meta = keys.filter((k) => e[k]).map((k) => `${NOTE_LABEL[k]}: ${e[k]}`);
  return [meta.length ? `[${NOTE_LABEL.fromNotion}] ${meta.join(' · ')}` : `[${NOTE_LABEL.fromNotion}]`, e.notes].filter(Boolean).join('\n\n');
}

export function planEvent(e, org) {
  let starts, ends, allDay;
  if (e.start.includes('T')) {
    allDay = false; starts = new Date(e.start).toISOString();
    const end = e.end && e.end.includes('T') && Date.parse(e.end) > Date.parse(e.start) ? e.end : null;
    ends = new Date(end ? Date.parse(end) : Date.parse(e.start) + 3600e3).toISOString();
  } else {
    allDay = true; const last = e.end && e.end.slice(0, 10) >= e.start ? e.end.slice(0, 10) : e.start;
    starts = kstMidnight(e.start); ends = kstMidnight(addDay(last));
  }
  return { id: stableId(org, 'event', e.id), org_id: org, visibility: 'org', title: clip(e.title, 200) || '(제목 없음)', note: clip(metaNote({ ...e, done: done(e) ? 'O' : null }, ['status', 'priority', 'agent', 'automatable', 'source', 'done']), 4000),
    location: clip(e.location, 200), category: clip(e.category ?? '', 40), all_day: allDay, starts_at: starts, ends_at: ends, attendees: [], source: 'notion', source_id: e.id };
}

// 할 일 속성(유건 10/4): 상태·우선순위·카테고리는 메모 글자가 아니라 오피스 할 일 칸으로 옮긴다(인트라넷 lib/constants.ts의 값).
// 'Completed'(또는 완료 체크)는 끝낸 날짜(done_at)로 — 상태 칸은 할 일·진행 중·보류뿐이다. 모르는 값은 기본값(할 일·보통).
export const STATUS_FROM_NOTION = { 'Not Started': 'todo', 'In Progress': 'doing', Pending: 'hold' };
export const PRIORITY_FROM_NOTION = { High: 1, Medium: 2, Low: 3, 높음: 1, 보통: 2, 낮음: 3 };
/** 할 일 메모 — 원래 Notion 메모 그대로. 오피스에 칸이 없는 것(담당 에이전트·자동화·출처)만 첫 줄에 남긴다 */
function taskNote(e) {
  const meta = ['agent', 'automatable', 'source'].filter((k) => e[k]).map((k) => `${NOTE_LABEL[k]}: ${e[k]}`);
  return [meta.length ? `[${NOTE_LABEL.fromNotion}] ${meta.join(' · ')}` : '', e.notes].filter(Boolean).join('\n\n');
}

export function planTask(e, org, now = Date.now()) {
  const start = e.start?.slice(0, 10) ?? null, end = e.end?.slice(0, 10) ?? null;
  const due = end ?? start;
  const doneAt = done(e) ? new Date(Math.min(Date.parse(e.edited ?? e.created ?? new Date(now).toISOString()), now)).toISOString() : null; // 노션에 끝낸 시각이 없어 마지막 수정 시각을 쓴다
  return { id: stableId(org, 'task', e.id), title: clip(e.title, 200) || '(제목 없음)', note: clip(taskNote(e), 4000),
    due_on: due, starts_on: end && start && start < end ? start : null, // 예정일~마감일이면 시작일·기한, 하루짜리는 기한만
    status: STATUS_FROM_NOTION[e.status] ?? 'todo', priority: PRIORITY_FROM_NOTION[e.priority] ?? 2,
    category: clip(String(e.category ?? '').trim(), 40) || null, // 분류 이름 — office_task_import가 그 조직 분류에서 찾고 없으면 만든다(카테고리·Parent Task)
    done_at: doneAt, created_at: e.created && Date.parse(e.created) <= now ? e.created : null, source: { kind: 'notion', id: e.id } };
}

/* ── 워크보드: Notion 블록 → 오피스 편집기 문서(StarterKit + 할 일 목록 + 16차 블록: 토글·콜아웃·표·2열/3열·링크, src/pages/page-blocks.js) ── */
// 링크는 http(s)·mailto·tel만 링크로(노션 안쪽 주소 '/abc…'는 글자만 남는다)
const link = (url) => { const href = safeHref(url); return href ? [{ type: 'link', attrs: { href } }] : []; };
function inline(rich) {
  const out = [];
  for (const r of rich ?? []) {
    const text = r.plain_text ?? r.text?.content ?? '';
    if (!text) continue;
    const a = r.annotations ?? {}, marks = [];
    if (a.bold) marks.push({ type: 'bold' });
    if (a.italic) marks.push({ type: 'italic' });
    if (a.strikethrough) marks.push({ type: 'strike' });
    if (a.underline) marks.push({ type: 'underline' });
    if (a.code) marks.push({ type: 'code' });
    marks.push(...link(r.href ?? r.text?.link?.url ?? null));
    out.push({ type: 'text', text, ...(marks.length ? { marks } : {}) });
  }
  return out;
}
const para = (content) => (content?.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const textPara = (s, marks) => para(s ? [{ type: 'text', text: s, ...(marks ? { marks } : {}) }] : []);
/** 주소 한 줄(설명이 있으면 설명 뒤에) — 주소는 링크로 */
const urlPara = (caption, url) => {
  const href = safeHref(url);
  const parts = [...(caption ? [{ type: 'text', text: href ? `${caption} ` : `${caption} ${url ?? ''}`.trim() }] : []), ...(href ? [{ type: 'text', text: url, marks: link(url) }] : !caption && url ? [{ type: 'text', text: url }] : [])];
  return para(parts);
};
// 노션 콜아웃 이모지 → 오피스 아이콘(앱 아이콘 글꼴에 있는 것만, 모르는 것은 안내)
const EMOJI_ICON = { '💡': 'info', 'ℹ️': 'info', '❗': 'info', '⚠️': 'info', '⭐': 'star', '🌟': 'star', '📌': 'pin', '📍': 'pin', '🎯': 'target', '📣': 'megaphone', '📢': 'megaphone',
  '✅': 'check', '✔️': 'check', '🔒': 'lock', '📅': 'calendar', '🗓️': 'calendar', '⏰': 'run', '🕒': 'run', '📚': 'book', '📖': 'book', '📄': 'doc', '📝': 'doc', '✉️': 'mail', '📧': 'mail',
  '👤': 'person', '🙋': 'person', '🏢': 'building', '📊': 'chart', '📈': 'chart', '🔗': 'link', '📁': 'folder', '🗂️': 'folder', '🏷️': 'tag' };
const calloutIconOf = (icon) => EMOJI_ICON[icon?.emoji] ?? 'info';
/** 표 칸 하나(노션 칸 = 글자 조각 목록) → 편집기 칸 */
const cell = (rich, header) => ({ type: header ? 'tableHeader' : 'tableCell', content: [para(inline(rich))] });

/** 블록 목록 → 문서 노드. stats.unsupported[type]에 글자로만 옮긴 블록 수를 센다 */
export function blocksToDoc(blocks, stats = { blocks: 0, unsupported: {} }) {
  const out = [];
  let i = 0;
  const kids = (b) => blocksToDoc(b.children ?? [], stats);
  const note = (type) => { stats.unsupported[type] = (stats.unsupported[type] ?? 0) + 1; };
  while (i < (blocks ?? []).length) {
    const b = blocks[i];
    stats.blocks += 1;
    const v = b[b.type] ?? {};
    const LIST = { bulleted_list_item: 'bulletList', numbered_list_item: 'orderedList', to_do: 'taskList' };
    if (LIST[b.type]) { // 이어진 같은 종류 목록 항목은 한 목록으로(중첩은 children)
      const items = [];
      while (i < blocks.length && blocks[i].type === b.type) {
        const it = blocks[i], iv = it[it.type] ?? {};
        if (it !== b) stats.blocks += 1;
        const nested = blocksToDoc(it.children ?? [], stats);
        items.push(b.type === 'to_do' ? { type: 'taskItem', attrs: { checked: !!iv.checked }, content: [para(inline(iv.rich_text)), ...nested] } : { type: 'listItem', content: [para(inline(iv.rich_text)), ...nested] });
        i++;
      }
      out.push({ type: LIST[b.type], content: items });
      continue;
    }
    i++;
    switch (b.type) {
      case 'paragraph': out.push(para(inline(v.rich_text)), ...kids(b)); break;
      case 'heading_1': case 'heading_2': case 'heading_3': {
        const h = { type: 'heading', attrs: { level: +b.type.slice(-1) }, content: inline(v.rich_text) };
        if (v.is_toggleable) out.push({ type: 'toggle', attrs: { open: false }, content: [h, ...kids(b)] }); // 노션 '토글 제목' — 제목이 첫 줄인 토글(접힌 채)
        else out.push(h, ...kids(b));
        break;
      }
      case 'quote': out.push({ type: 'blockquote', content: [para(inline(v.rich_text)), ...kids(b)] }); break;
      case 'callout': out.push({ type: 'callout', attrs: { icon: calloutIconOf(v.icon) }, content: [para(inline(v.rich_text)), ...kids(b)] }); break;
      case 'code': { const t = plain(v.rich_text); out.push({ type: 'codeBlock', attrs: { language: v.language ?? null }, content: t ? [{ type: 'text', text: t }] : [] }); break; }
      case 'divider': out.push({ type: 'horizontalRule' }); break;
      case 'toggle': out.push({ type: 'toggle', attrs: { open: false }, content: [para(inline(v.rich_text)), ...kids(b)] }); break; // 노션처럼 접힌 채로 옮긴다
      case 'column_list': { // 칸이 둘 이상이면 2열·3열 블록, 하나뿐이면 안의 블록만(빈 칸은 빈 줄 하나)
        const cols = (b.children ?? []).map((col) => { stats.blocks += 1; const c = blocksToDoc(col.children ?? [], stats); return { type: 'column', content: c.length ? c : [{ type: 'paragraph' }] }; });
        if (cols.length >= 2) out.push({ type: 'columns', content: cols }); else out.push(...(cols[0]?.content ?? []));
        break;
      }
      case 'table': { // 첫 줄 머리(has_column_header)·첫 칸 머리(has_row_header), 칸 수는 가장 긴 줄에 맞춘다
        const rows = (b.children ?? []).map((row) => row.table_row?.cells ?? []);
        const width = Math.max(1, v.table_width ?? 0, ...rows.map((r) => r.length));
        stats.blocks += rows.length;
        if (rows.length) out.push({ type: 'table', content: rows.map((cells, r) => ({ type: 'tableRow', content: Array.from({ length: width }, (_, k) => cell(cells[k] ?? [], (r === 0 && v.has_column_header) || (k === 0 && v.has_row_header))) })) });
        break;
      }
      case 'child_page': case 'child_database': break; // 하위 페이지는 트리가 따로 옮긴다
      case 'image': case 'file': case 'pdf': case 'video': case 'audio': { note(b.type); const url = v.external?.url ?? v.file?.url ?? ''; out.push(textPara(`[${b.type}] ${plain(v.caption)} ${url}`.trim())); break; } // 노션 파일 주소는 1시간 뒤 만료 — 파일은 문서함(트랙 B)으로 따로
      case 'bookmark': case 'embed': case 'link_preview': out.push(urlPara(plain(v.caption), v.url ?? '')); break;
      case 'equation': out.push(textPara(v.expression ?? '', [{ type: 'code' }])); break;
      default: note(b.type); { const t = plain(v.rich_text); if (t) out.push(textPara(t)); out.push(...kids(b)); }
    }
  }
  return out;
}

/** 워크보드 트리({ id, title, blocks, children: [...] }) → 오피스 페이지 목록(부모 먼저). 맨 위는 원본 루트 제목의 묶음 페이지 */
export function planPages(root, org) {
  const stats = { blocks: 0, unsupported: {} }, pages = [];
  const walk = (node, parent, position) => {
    const id = stableId(org, 'page', node.id);
    const content = { type: 'doc', content: blocksToDoc(node.blocks ?? [], stats) };
    if (!content.content.length) content.content.push({ type: 'paragraph' });
    pages.push({ id, parent, position, title: clip(node.title || '(제목 없음)', 500), content, sourceId: node.id });
    let pos = null;
    for (const c of node.children ?? []) { pos = between(pos, null); walk(c, id, pos); }
  };
  if (root) walk(root, null, 'w0');
  return { pages, stats };
}

/* ── 회사 정보 ── */
export function planCompany(rows, org) {
  const used = new Set(), pos = {};
  return rows.map((pg) => {
    const label = plain(prop(pg, CI.item)?.title) || '(항목 없음)';
    let key = guessKey(label);
    if (key && used.has(key)) key = null; else if (key) used.add(key); // 같은 서식 칸이 둘이면 먼저 나온 것만
    const category = CATEGORY_FROM_KO[sel(prop(pg, CI.category))] ?? 'other';
    pos[category] = (pos[category] ?? -1) + 1;
    return { id: stableId(org, 'company', pg.id), label: clip(label, 100), value: clip(plain(prop(pg, CI.value)?.rich_text), 2000), notes: clip(plain(prop(pg, CI.notes)?.rich_text), 2000),
      category, key, position: pos[category], source: 'notion', source_id: pg.id };
  });
}

/* ── 평가 레포트 ── */
export function planEvals(rows, org, people = {}) {
  return rows.map((pg) => {
    const scope = SCOPE_FROM_KO[sel(prop(pg, R.scope))] ?? 'month';
    const type = TYPE_FROM_KO[sel(prop(pg, R.subjectType))] ?? 'staff';
    const name = plain(prop(pg, R.subject)?.rich_text) || '(대상 없음)';
    const label = plain(prop(pg, R.period)?.rich_text);
    const per = parsePeriod(label, scope, pg.created_time ? kstDay(pg.created_time) : undefined);
    const user = type === 'agent' ? null : people[name] ?? null;
    const scores = Object.fromEntries(SCORE_KEYS.map((k) => { const v = num(prop(pg, R[k])); return [k, v == null ? null : Math.max(0, Math.min(100, Math.round(v)))]; }));
    const total = num(prop(pg, R.total));
    return { id: stableId(org, 'eval', pg.id), source: 'notion', source_id: pg.id, subject_kind: type === 'agent' ? 'crew' : 'person', subject_user: user, subject_name: clip(name, 100), subject_type: type,
      scope, from: per.from, to: per.to, period_label: clip(label, 100), title: clip(plain(prop(pg, R.title)?.title) || '(제목 없음)', 200), ...scores,
      total: total == null ? null : Math.max(0, Math.min(100, Math.round(total))), review: clip(plain(prop(pg, R.review)?.rich_text), 20000),
      work: clip(plain(prop(pg, R.weeklyTasks)?.rich_text), 20000), achievements: clip(plain(prop(pg, R.weeklyAchievements)?.rich_text), 20000),
      author_name: clip(plain(prop(pg, R.author)?.rich_text), 100), created_at: pg.created_time ?? null };
  });
}

/* ── 직원(인트라넷 board.db) ── */
export const planPeople = (rows, org) => rows.map((e) => ({ id: stableId(org, 'person', String(e.id)), name: clip(e.name, 100), title: clip(e.role ?? '', 100), agent: clip(agentLabel(e.agent ?? ''), 100), source: 'intranet', source_id: String(e.id) }));

/** 전체 계획 + 대조용 건수 */
/** 화면·터미널에 찍을 계획 사본 — 계좌 분류 값과 사업자·법인 번호의 숫자를 끝 4자리만 남기고 가린다(--json 출력용, 실제 이관 값은 그대로) */
const maskDigits = (v) => { const s = String(v ?? ''); let n = (s.match(/\d/g) ?? []).length - 4; return s.replace(/\d/g, (d) => (n-- > 0 ? '*' : d)); };
export function maskForPrint(plan) {
  return { ...plan, company: (plan.company ?? []).map((c) => (c.category === 'bank' || ['biz_no', 'corp_no'].includes(c.key) ? { ...c, value: maskDigits(c.value) } : c)) };
}

export function planAll({ calendar = [], parents = [], workboard = null, company = [], reports = [], employees = [] }, { org = null, people = {}, now = Date.now() } = {}) {
  const parentNames = new Map(parents.map((p) => [p.id, plain(p.properties?.['Entry name']?.title)]));
  const entries = calendar.map((p) => normalizeEntry(p, parentNames));
  const events = entries.filter(isEvent).map((e) => planEvent(e, org));
  const tasks = entries.filter((e) => !isEvent(e)).map((e) => planTask(e, org, now));
  const { pages, stats } = planPages(workboard, org);
  const evals = planEvals(reports, org, people);
  const plan = { events, tasks, pages, company: planCompany(company, org), evals, people: planPeople(employees, org) };
  const days = [...events.map((e) => e.starts_at.slice(0, 10)), ...tasks.map((t) => t.due_on).filter(Boolean)].sort();
  return { plan, summary: {
    source: { calendar: calendar.length, undated: entries.filter((e) => !e.start).length, workboardPages: pages.length, company: company.length, reports: reports.length, employees: employees.length },
    target: { events: events.length, tasks: tasks.length, tasksDone: tasks.filter((t) => t.done_at).length, taskCategories: [...new Set(tasks.map((t) => t.category?.toLowerCase()).filter(Boolean))].length,
      pages: pages.length, company: plan.company.length, companyKeys: plan.company.filter((c) => c.key).length,
      evals: evals.length, evalsUnlinked: evals.filter((e) => e.subject_kind === 'person' && !e.subject_user).length, people: plan.people.length },
    range: days.length ? [days[0], days.at(-1)] : null, blocks: stats.blocks, textOnlyBlocks: stats.unsupported,
  } };
}
