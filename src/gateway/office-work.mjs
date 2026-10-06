// 에이전트 할 일·페이지 도구(office_work) — 오피스 17차 B-6(PARITY-tasks I2~I6). 인트라넷 에이전트 도구 tasks_list·tasks_add·tasks_update·categories_list와
// workboard_list·read·create·append·replace를 아르고 오피스로 옮긴 것("에이전트도 오피스로 쓴다").
// 규칙은 회사·문서함 도구와 같다(office-audience.mjs officeTurn): 메신저 조직 채널의 그 조직만, 주인의 기기 세션으로만(사람 권한 그대로 — 서버 함수가 판정),
// 손님 턴은 chat.mjs 처리기가 먼저 거절, 손님·조직 밖 사람이 있을 수 있는 방에서는 다루지 않는다.
// 할 일(트랙 T의 상태·중요도·분류·시작일·메모): office_task_list(보이는 일 — 맡은 사람·만든 사람·관리자) · office_task_write · office_task_category_list · office_org_people(이름).
//   크루가 바꾸는 것은 주인이 맡은 일뿐 — 일정 도구가 주인 일정만 고치는 것과 같다. 남의 일은 읽기만, 남에게 맡기기는 하지 않는다(사람이 오피스에서).
//   크루가 만든 일은 source = { kind: 'crew', crew: 메신저 크루 id, slug, name } — 오피스 화면이 크루별로 묶는다.
//   여럿이 보는 방에서는 주인이 맡은 일만 보여 준다(남의 일은 그 사람·만든 사람·관리자만 보는 기록이다).
// 페이지: office_page_list_access(본문 없는 목록·권한) · office_pages 한 행(본문, RLS) · office_page_create · office_page_save(버전이 다르면 거절).
//   여럿이 보는 방에서는 조직 전체가 보는 페이지(일반 접근이 조직 보기·편집이고 자신·조상이 비공개가 아님)만 — 나머지는 주인과의 1:1에서만.
//   본문 바꾸기(replace)는 글자 블록만 있는 페이지에서만 — 파일·모듈·비공개 블록이 든 페이지는 덧붙이기만 한다(글자로 다시 쓰면 그 블록이 사라진다).
// 부하: 사람이 시킬 때만 부른다(폴링 없음). 목록은 호출 1, 할 일 고치기는 목록 1 + 바뀐 칸마다 쓰기 1(같은 값이면 부르지 않는다), 페이지 고치기는 목록 1 + 읽기 1 + 저장 1.
// 바깥 글(S1): 할 일 제목·메모·분류·사람 이름, 페이지 제목·본문은 남이 쓴 글이다 — 목록·읽기 결과는 경계 블록으로 감싼다(office-audience.mjs outsideOf).
import { randomUUID } from 'node:crypto';
import { officeTurn, ONLY_DM, refusalText, outsideOf, quoted, OUTSIDE_RULE } from './office-audience.mjs';
import { jsonText } from '../inbound-marks.mjs';

export const workDeps = {
  session: async () => (await import('./msgr.mjs')).sessionClient(),
  now: () => Date.now(),
  newId: () => randomUUID(),
};

const pick = (ko, en, lang) => (lang === 'en' ? en : ko);
const L = (lang) => (lang === 'en' ? 1 : 0);
const NAME = { ko: '할 일·페이지 도구', en: 'tasks and pages tool' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TASK_CAP = 60, PAGE_CAP = 80, READ_CAP = 20_000, TEXT_MAX = 100_000;
const STATUS = ['todo', 'doing', 'hold'];
const STATUS_NAME = { todo: ['할 일', 'to do'], doing: ['진행 중', 'doing'], hold: ['보류', 'on hold'], done: ['끝냄', 'done'] };
const PRIORITY = { high: 1, normal: 2, low: 3 };
const PRIORITY_NAME = { 1: ['높음', 'high'], 2: ['보통', 'normal'], 3: ['낮음', 'low'] };
const ACCESS_NAME = { full: ['편집 가능', 'can edit'], edit: ['편집 가능', 'can edit'], view: ['보기만', 'view only'] };

const kstDay = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const isDate = (d) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d ?? ''))) return false; const ms = Date.parse(`${d}T00:00:00+09:00`); return Number.isFinite(ms) && kstDay(ms) === d; }; // 없는 날(2/30·13월)은 거절
const dayNo = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400e3;
const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// 호출 이름은 글자 그대로 둔다 — 크루 계약 레지스트리(test/crew-contract.test.mjs)가 src/gateway의 rpc('…')·from('…')를 찾아 분류를 강제한다
function unwrap({ data, error }) {
  if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
  return data;
}
const ERRORS = {
  task_input: ['입력이 올바르지 않다(제목 1~200자, 메모 4000자까지, 날짜 YYYY-MM-DD)', 'invalid input (title 1-200 chars, note up to 4000, dates YYYY-MM-DD)'],
  task_forbidden: ['권한이 없다(맡은 사람은 상태·끝내기만, 제목·기한·메모·분류·중요도·시작일은 자기가 만든 자기 일이나 관리자만 바꾼다)', 'not allowed (the assignee may change status or finish; title, dates, note, category and priority need the creator of their own task or an admin)'],
  task_not_found: ['그 할 일이 없다 — tasks로 다시 확인하라', 'no such task — check with tasks'],
  task_cancelled: ['취소한 할 일이라 바꾸지 않는다', 'the task is cancelled'],
  task_done: ['끝낸 할 일이다 — status로 먼저 다시 열어라', 'the task is done — reopen it with status first'],
  task_dates: ['시작일이 기한보다 늦을 수 없다', 'the start date cannot be after the due date'],
  task_category: ['그 분류가 이 조직에 없다 — categories로 확인하라', 'no such category in this org — check with categories'],
  task_limit: ['한도에 걸렸다(할 일 하나의 고친 기록 200번, 1년에 만드는 일 5,000건)', 'limit reached (200 edits per task, 5,000 new tasks a year)'],
  task_conflict: ['같은 id의 다른 할 일이 있다 — 다시 시도하라', 'id conflict — try again'],
  business_forbidden: ['권한이 없다(이 조직의 손님 아닌 멤버만)', 'not allowed (non-guest members of this org only)'],
  version_conflict: ['그새 다른 사람이 페이지를 고쳤다 — page_read로 다시 읽고 고쳐라', 'someone changed the page meanwhile — read it again with page_read'],
  'only admins add top-level': ['최상위 페이지는 조직 관리자만 만든다 — parent_id로 상위 페이지를 골라라', 'only org admins add top-level pages — pick a parent_id'],
  'access required': ['그 페이지를 고칠 권한이 없다', 'no edit access to that page'],
  'parent missing': ['상위 페이지가 없다 — pages로 확인하라', 'the parent page does not exist — check with pages'],
  'parent in another space': ['상위 페이지가 이 조직 페이지가 아니다', 'the parent page is not in this org'],
  'id taken': ['같은 id의 페이지가 이미 있다 — 다시 시도하라', 'id conflict — try again'],
};

/* ── 할 일 ── */
const stateOf = (t) => (t.done_at ? 'done' : STATUS.includes(t.status) ? t.status : 'todo');
const lateDays = (t, today) => (!t.done_at && t.due_on && String(t.due_on).slice(0, 10) < today ? dayNo(today) - dayNo(String(t.due_on).slice(0, 10)) : 0);
/** 할 일 한 줄 — 상태·중요도(보통이 아니면)·분류·시작~기한(지난 날)·맡은 사람(남의 일을 함께 볼 때)·만든 크루·id, 메모 앞부분. 사람이 쓴 값(제목·분류·이름·메모)은 esc(기본 JSON 문자열)로 감싼다 */
export function taskLine(t, { lang = 'ko', today, names = null, ownerUid = null, esc = jsonText } = {}) {
  const bits = [`[${STATUS_NAME[stateOf(t)][L(lang)]}] ${esc(t.title)}`];
  if (t.priority && t.priority !== 2) bits.push(`${pick('중요도', 'priority', lang)} ${PRIORITY_NAME[t.priority]?.[L(lang)] ?? t.priority}`);
  if (t.category) bits.push(`${pick('분류', 'category', lang)} ${esc(t.category)}`);
  if (t.starts_on) bits.push(`${pick('시작', 'starts', lang)} ${t.starts_on}`);
  if (t.due_on) bits.push(`${pick('기한', 'due', lang)} ${t.due_on}`);
  const late = today ? lateDays(t, today) : 0;
  if (late) bits.push(pick(`기한 지남 ${late}일`, `${late} days overdue`, lang));
  if (names) bits.push(`${pick('맡은 사람', 'assignee', lang)} ${t.assignee === ownerUid ? pick('주인', 'owner', lang) : esc(names.get(t.assignee) ?? t.assignee)}`);
  if (t.source?.kind === 'crew') bits.push(pick(`에이전트 ${esc(t.source.name || t.source.slug)}가 만듦`, `made by agent ${esc(t.source.name || t.source.slug)}`, lang));
  bits.push(`id=${t.id}`);
  return `- ${bits.join(' · ')}${t.note ? `\n  ${pick('메모', 'note', lang)}: ${esc(String(t.note).slice(0, 160))}` : ''}`;
}
/** 분류 이름·id → { id } | { none: true } | null(없음) */
function findCategory(value, cats) {
  const v = String(value ?? '').trim();
  if (v.toLowerCase() === 'none') return { none: true };
  return cats.find((c) => c.id === v || String(c.name).toLowerCase() === v.toLowerCase()) ?? null;
}
const dateArg = (v) => (v == null || v === '' ? undefined : String(v).toLowerCase() === 'none' ? null : isDate(v) ? String(v) : false); // undefined=안 바꿈, null=지움, false=틀림

/* ── 페이지 본문(tiptap JSON) ↔ 글자 ── */
const inline = (nodes) => (nodes ?? []).map((n) => (n.type === 'text' ? n.text ?? '' : n.type === 'hardBreak' ? '\n' : inline(n.content))).join('');
const LEAF = { fileRef: ['파일', 'file'], moduleGrid: ['모듈', 'module'], privateBlock: ['비공개 블록', 'private block'], recordCard: ['기록 카드', 'record card'], mailRef: ['메일', 'mail'], image: ['그림', 'image'] };
/** 페이지 본문 → 읽기 쉬운 글(제목 #, 목록 -, 번호 1., 체크 - [ ], 인용 >, 코드 ```). 글자가 아닌 블록은 [종류] 자리만 */
export function docMarkdown(doc, lang = 'ko') {
  const lines = [];
  const walk = (n, pre = '') => {
    switch (n?.type) {
      case 'heading': lines.push(`${pre}${'#'.repeat(n.attrs?.level || 1)} ${inline(n.content)}`); break;
      case 'paragraph': lines.push(pre + inline(n.content)); break;
      case 'bulletList': case 'orderedList': case 'taskList':
        (n.content ?? []).forEach((it, i) => {
          const mark = n.type === 'orderedList' ? `${i + 1}. ` : n.type === 'taskList' ? (it.attrs?.checked ? '- [x] ' : '- [ ] ') : '- ';
          const kids = it.content ?? [];
          const first = kids[0]?.type === 'paragraph' ? kids[0] : null;
          lines.push(pre + mark + (first ? inline(first.content) : ''));
          (first ? kids.slice(1) : kids).forEach((k) => walk(k, `${pre}  `));
        });
        break;
      case 'horizontalRule': lines.push(`${pre}---`); break;
      case 'codeBlock': lines.push(`${pre}\`\`\``, inline(n.content), `${pre}\`\`\``); break;
      case 'blockquote': (n.content ?? []).forEach((k) => walk(k, `${pre}> `)); break;
      default: {
        const label = LEAF[n?.type]?.[L(lang)];
        const name = n?.attrs?.name || n?.attrs?.title || '';
        if (label || !n?.content) lines.push(`${pre}[${label ?? n?.type ?? '?'}${name ? `: ${name}` : ''}]`);
        else n.content.forEach((k) => walk(k, pre));
      }
    }
  };
  (doc?.content ?? []).forEach((n) => walk(n));
  return lines.join('\n');
}
/** 글 → 페이지 블록. '# '·'## '·'### ' 제목, '- ' 글머리, '1. ' 번호, '- [ ] '·'- [x] ' 체크, '> ' 인용, '---' 구분선, ``` 코드, 나머지 줄은 문단(빈 줄은 건너뛴다) */
export function textToNodes(text) {
  const para = (t) => (t ? { type: 'paragraph', content: [{ type: 'text', text: t }] } : { type: 'paragraph' }); // 빈 글자 조각은 편집기가 받지 않는다
  const out = [];
  const pushItem = (listType, item) => { const last = out[out.length - 1]; if (last?.type === listType) last.content.push(item); else out.push({ type: listType, content: [item] }); };
  let code = null;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (code) { if (/^\s*```/.test(raw)) { out.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] }); code = null; } else code.push(raw); continue; }
    const line = raw.trim();
    if (!line) continue;
    let m;
    if (/^```/.test(line)) code = [];
    else if ((m = /^(#{1,3})\s+(.+)$/.exec(line))) out.push({ type: 'heading', attrs: { level: m[1].length }, content: [{ type: 'text', text: m[2] }] });
    else if ((m = /^[-*]\s+\[( |x|X)\]\s*(.*)$/.exec(line))) pushItem('taskList', { type: 'taskItem', attrs: { checked: m[1] !== ' ' }, content: [para(m[2])] });
    else if (/^(-{3,}|\*{3,})$/.test(line)) out.push({ type: 'horizontalRule' });
    else if ((m = /^[-*]\s+(.*)$/.exec(line))) pushItem('bulletList', { type: 'listItem', content: [para(m[1])] });
    else if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) pushItem('orderedList', { type: 'listItem', content: [para(m[1])] });
    else if ((m = /^>\s?(.*)$/.exec(line))) out.push({ type: 'blockquote', content: [para(m[1])] });
    else out.push(para(line));
  }
  if (code) out.push({ type: 'codeBlock', content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] }); // 닫지 않은 코드
  return out;
}
const TEXT_TYPES = new Set(['doc', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'hardBreak', 'text']);
/** 글로 다시 쓰면 사라질 블록 종류(파일·모듈·비공개 블록 등) */
export function foreignNodes(doc) {
  const out = new Set();
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (n.type && !TEXT_TYPES.has(n.type)) out.add(n.type); (n.content ?? []).forEach(walk); };
  walk(doc);
  return [...out];
}
/** 형제 순서 값 — apps/office/src/core/position.js between과 같은 규칙(a 뒤, b 앞. null은 열린 끝) */
const D = '0123456789abcdefghijklmnopqrstuvwxyz';
export function between(a, b) {
  a = a ?? '';
  let out = '';
  for (let i = 0; ; i++) {
    const lo = i < a.length ? D.indexOf(a[i]) : 0;
    const hi = b != null && i < b.length ? D.indexOf(b[i]) : D.length;
    if (lo === hi) { out += D[lo]; continue; }
    const mid = (lo + hi) >> 1;
    if (mid > lo) return out + D[mid];
    out += D[lo];
    b = null;
  }
}

/**
 * 도구 본체. opts = { ctx: mirrorCtx, crew: 크루 slug, crewName, lang, ownerId: 회사 소유자 uid }.
 * 반환 = 에이전트가 읽을 텍스트(오류도 원인을 한 줄로 — 삼키지 않는다).
 */
export async function workTool(args, { ctx = null, crew = null, crewName = null, lang = 'ko', ownerId = null } = {}) {
  const a = args ?? {};
  const turn = await officeTurn({ ctx, ownerId, lang, session: workDeps.session, name: NAME });
  if (turn.text) return turn.text;
  const { c, org, owner } = turn;
  const today = kstDay(workDeps.now());
  const line = (t, extra) => taskLine(t, { lang, today, esc: ox.line, ...extra });
  const ox = outsideOf('work', lang);
  const TASK_TEXT = ['할 일 제목·메모·분류·사람 이름은 사람들이 쓴 글', 'task titles, notes, categories and names written by people'];
  const PAGE_TEXT = ['페이지 제목·본문은 사람들이 쓴 글', 'page titles and bodies written by people'];
  const tasksNow = async () => unwrap(await c.client.rpc('office_task_list', { p_org: org })) ?? [];
  const categories = async () => unwrap(await c.client.rpc('office_task_category_list', { p_org: org })) ?? [];
  const CAT_TEXT = ['할 일 분류 이름은 사람들이 쓴 글', 'category names written by people'];
  // 분류 이름은 조직 사람들이 쓴 글 — 거절 문장에서도 경계 블록 안에(검수 #fix-cross 2차 L-5)
  const noCategory = (cats) => `${pick('그 분류가 없다. 이 조직의 분류(분류를 새로 만드는 것은 관리자가 오피스에서 한다):', 'No such category. This org has (admins add categories in Office):', lang)}\n${cats.length ? ox.block(cats.map((x) => `- ${ox.line(x.name)}`), CAT_TEXT) : pick('(없음)', '(none)', lang)}`;
  try {
    if (a.action === 'tasks') {
      const rows = await tasksNow();
      const mineOnly = a.who !== 'all' || !owner; // 여럿이 보는 방에서는 주인이 맡은 일만
      let list = mineOnly ? rows.filter((t) => t.assignee === c.uid) : rows;
      if (a.status) list = list.filter((t) => stateOf(t) === a.status); else list = list.filter((t) => !t.done_at);
      if (a.overdue) list = list.filter((t) => lateDays(t, today) > 0);
      if (a.category) {
        const v = String(a.category).trim().toLowerCase();
        list = list.filter((t) => (v === 'none' ? !t.category_id : t.category_id === a.category || String(t.category ?? '').toLowerCase() === v));
      }
      const q = String(a.q ?? '').trim().toLowerCase();
      if (q) list = list.filter((t) => `${t.title}\n${t.note ?? ''}`.toLowerCase().includes(q));
      let names = null;
      if (!mineOnly) {
        const people = unwrap(await c.client.rpc('office_org_people', { p_org: org })) ?? [];
        names = new Map(people.map((p) => [p.user_id, p.name]));
      }
      const scope = mineOnly ? pick('주인이 맡은 일', 'assigned to the owner', lang) : pick('주인이 볼 수 있는 모든 일', 'everything the owner can see', lang);
      const hiddenNote = a.who === 'all' && !owner ? pick(` — 남의 일은 ${ONLY_DM(lang)} 보여 준다`, ` — other people's tasks are shown ${ONLY_DM(lang)}`, lang) : '';
      if (!list.length) return pick(`조건에 맞는 할 일이 없다(${scope}${hiddenNote}).`, `No tasks match (${scope}${hiddenNote}).`, lang);
      return [pick(`할 일 ${list.length}건(${scope}${hiddenNote}):`, `${list.length} tasks (${scope}${hiddenNote}):`, lang),
        ox.block(list.slice(0, TASK_CAP).map((t) => line(t, { names, ownerUid: c.uid })), TASK_TEXT),
        ...(list.length > TASK_CAP ? [pick(`…외 ${list.length - TASK_CAP}건 — status·category·q로 좁혀라.`, `…and ${list.length - TASK_CAP} more — narrow with status, category or q.`, lang)] : []),
        pick('바꿀 때는 task_set에 id를 준다(끝내기는 status=done).', 'To change one, pass its id to task_set (finish with status=done).', lang)].join('\n');
    }

    if (a.action === 'categories') {
      const cats = await categories();
      if (!cats.length) return pick('이 조직에는 할 일 분류가 없다(모두 미분류).', 'This org has no task categories.', lang);
      return [pick(`할 일 분류 ${cats.length}개(이름 · id):`, `${cats.length} task categories (name · id):`, lang),
        ox.block(cats.map((x) => `- ${ox.line(x.name)}${x.tasks != null ? pick(` · 할 일 ${x.tasks}건`, ` · ${x.tasks} tasks`, lang) : ''} · id=${x.id}`), ['할 일 분류 이름은 사람들이 쓴 글', 'category names written by people'])].join('\n');
    }

    if (a.action === 'task_add') {
      const title = one(a.title);
      if (!title || title.length > 200) return pick('task_add에는 title(1~200자)이 필요하다.', 'task_add needs a title (1-200 chars).', lang);
      const due = dateArg(a.due_on), start = dateArg(a.starts_on);
      if (due === false || start === false || due === null || start === null) return pick('due_on·starts_on은 YYYY-MM-DD(한국 날짜).', 'due_on/starts_on must be YYYY-MM-DD.', lang);
      if (due && start && start > due) return pick('시작일이 기한보다 늦을 수 없다.', 'The start date cannot be after the due date.', lang);
      if (a.status && !STATUS.includes(a.status)) return pick('새 할 일의 status는 todo·doing·hold 중 하나(끝낸 일은 만들지 않는다).', 'A new task\'s status is todo, doing or hold.', lang);
      const note = String(a.note ?? '');
      if (note.length > 4000) return pick('메모는 4000자까지.', 'The note is limited to 4000 characters.', lang);
      let categoryId = null, categoryName = null;
      if (a.category) {
        const cats = await categories();
        const hit = findCategory(a.category, cats);
        if (!hit) return noCategory(cats);
        if (!hit.none) { categoryId = hit.id; categoryName = hit.name; }
      }
      const source = Object.fromEntries(Object.entries({ kind: 'crew', crew: ctx.crewId ?? null, slug: crew, name: crewName }).filter(([, v]) => v)); // 오피스 화면이 크루별로 묶는다
      const data = { id: workDeps.newId(), title, note, due_on: due ?? null, starts_on: start ?? null, status: a.status ?? 'todo', priority: PRIORITY[a.priority] ?? 2, category_id: categoryId, source };
      const r = unwrap(await c.client.rpc('office_task_write', { p_org: org, p_action: 'task.create', p_data: data })); // 맡은 사람은 비운다 = 주인(서버 기본값)
      return `${pick('할 일을 만들었다(주인이 맡음)', 'Created the task (assigned to the owner)', lang)}:\n${ox.block([line({ ...data, ...r, category: categoryName })], TASK_TEXT)}`;
    }

    if (a.action === 'task_set') {
      if (!a.id) return pick('task_set에는 id(tasks가 보여 준 것)가 필요하다.', 'task_set needs an id from tasks.', lang);
      const rows = await tasksNow();
      const t = rows.find((x) => x.id === a.id);
      if (!t) return pick(`id=${quoted(a.id, 80)} 할 일이 없다(취소한 일·끝낸 지 30일 지난 일은 보이지 않는다) — tasks로 다시 확인하라.`, `No task id=${quoted(a.id, 80)} (cancelled tasks and tasks done over 30 days ago are hidden) — check with tasks.`, lang);
      if (t.assignee !== c.uid) return pick('이 할 일은 주인이 맡은 일이 아니라 에이전트가 바꾸지 않는다 — 맡은 사람이나 관리자가 오피스에서 바꾸면 된다고 한 줄로 알려라.', 'This task is not assigned to the owner, so an agent does not change it — say in one line that the assignee or an admin can change it in Office.', lang);
      if (a.status && ![...STATUS, 'done'].includes(a.status)) return pick('status는 todo·doing·hold·done 중 하나.', 'status must be todo, doing, hold or done.', lang);
      const plan = []; // [{ action, data, label }] — 이 순서대로 하나씩 쓴다
      const wasDone = !!t.done_at;
      const reopen = wasDone && a.status && a.status !== 'done';
      const edits = ['title', 'priority', 'category', 'starts_on', 'due_on', 'note'].filter((k) => a[k] != null && a[k] !== '');
      if (wasDone && !reopen) {
        if (a.status === 'done' && !edits.length) return pick('이미 끝낸 할 일이다.', 'The task is already done.', lang);
        return pick('끝낸 할 일은 바꾸지 않는다 — 고치려면 status(todo·doing·hold)로 먼저 다시 열어라.', 'A finished task is not changed — reopen it with status (todo, doing or hold) first.', lang);
      }
      if (reopen) plan.push({ action: 'task.reopen', data: {}, label: pick('다시 열기', 'reopen', lang) });
      const title = one(a.title);
      if (title && title !== t.title) { if (title.length > 200) return pick('제목은 200자까지.', 'Title is limited to 200 characters.', lang); plan.push({ action: 'task.title', data: { title }, label: pick('제목', 'title', lang) }); }
      if (a.priority) { const p = PRIORITY[a.priority]; if (!p) return pick('priority는 high·normal·low 중 하나.', 'priority must be high, normal or low.', lang); if (p !== t.priority) plan.push({ action: 'task.priority', data: { priority: p }, label: pick('중요도', 'priority', lang) }); }
      let categoryName;
      if (a.category) {
        const cats = await categories();
        const hit = findCategory(a.category, cats);
        if (!hit) return noCategory(cats);
        const id = hit.none ? null : hit.id;
        if (id !== (t.category_id ?? null)) { plan.push({ action: 'task.category', data: { category_id: id }, label: pick('분류', 'category', lang) }); categoryName = hit.none ? null : hit.name; }
      }
      const start = dateArg(a.starts_on), due = dateArg(a.due_on);
      if (start === false || due === false) return pick('due_on·starts_on은 YYYY-MM-DD(지우려면 none).', 'due_on/starts_on must be YYYY-MM-DD (none to clear).', lang);
      const curStart = t.starts_on ?? null, curDue = t.due_on ?? null;
      const finStart = start === undefined ? curStart : start, finDue = due === undefined ? curDue : due;
      if (finStart && finDue && finStart > finDue) return pick('시작일이 기한보다 늦을 수 없다.', 'The start date cannot be after the due date.', lang);
      const startStep = start !== undefined && start !== curStart ? { action: 'task.start', data: { starts_on: start ?? '' }, label: pick('시작일', 'start date', lang) } : null;
      const dueStep = due !== undefined && due !== curDue ? { action: 'task.due', data: { due_on: due ?? '' }, label: pick('기한', 'due date', lang) } : null;
      // 중간 상태도 시작일 ≤ 기한이어야 서버가 받는다 — 새 시작일이 지금 기한보다 늦으면 기한부터
      const startFirst = !startStep || !finStart || !curDue || finStart <= curDue;
      plan.push(...(startFirst ? [startStep, dueStep] : [dueStep, startStep]).filter(Boolean));
      if (a.note != null && a.note !== '') {
        const add = String(a.note);
        const next = a.note_mode === 'replace' || !t.note ? add : `${t.note}\n${add}`; // 기본은 덧붙이기 — 기존 메모를 지우지 않는다
        if (next.length > 4000) return pick('메모가 4000자를 넘는다 — 줄이거나 note_mode=replace로 다시 써라.', 'The note would exceed 4000 characters — shorten it or use note_mode=replace.', lang);
        if (next !== t.note) plan.push({ action: 'task.note', data: { note: next }, label: pick('메모', 'note', lang) });
      }
      if (a.status && a.status !== 'done' && a.status !== (reopen ? (t.status ?? 'todo') : stateOf(t))) plan.push({ action: 'task.status', data: { status: a.status }, label: pick('상태', 'status', lang) });
      if (a.status === 'done' && !wasDone) plan.push({ action: 'task.done', data: {}, label: pick('끝내기', 'finish', lang) }); // 다른 칸을 먼저 고치고 끝낸다(끝낸 일은 못 고친다)
      if (!plan.length) return pick('바꿀 것이 없다(이미 그 값이다).', 'Nothing to change (already that value).', lang);
      let cur = t; const did = [];
      for (const step of plan) {
        try { cur = unwrap(await c.client.rpc('office_task_write', { p_org: org, p_action: step.action, p_data: { id: t.id, ...step.data } })) ?? cur; }
        catch (e) {
          const why = refusalText(e, ERRORS, lang);
          return did.length ? pick(`${did.join('·')}은(는) 바꿨지만 ${step.label}에서 멈췄다 — ${why}`, `Changed ${did.join(', ')} but stopped at ${step.label} — ${why}`, lang) : why;
        }
        did.push(step.label);
      }
      const shown = { ...t, ...cur, category: categoryName === undefined ? t.category : categoryName }; // 쓰기 결과 행에는 분류 이름이 없다
      return `${pick(`할 일을 고쳤다(${did.join('·')})`, `Updated the task (${did.join(', ')})`, lang)}:\n${ox.block([line(shown)], TASK_TEXT)}`;
    }

    if (['pages', 'page_read', 'page_add', 'page_edit'].includes(a.action)) {
      const index = new Map((unwrap(await c.client.rpc('office_page_list_access')) ?? []).map((p) => [p.id, p]));
      // 휴지통 — 자신이나 조상이 휴지통에 있으면 없는 페이지로 본다(2차 분리 검수 의심 4: 조상만 휴지통인 하위가 목록·읽기에 남았다).
      // 조상이 목록에 없으면(볼 권한 없음) 서버 office_page_access가 휴지통 조상 아래를 이미 'none'으로 뺀다
      const inTrash = (p) => { for (let cur = p, d = 0; cur && d < 32; d++) { if (cur.archived_at) return true; cur = cur.parent_id ? index.get(cur.parent_id) : null; } return false; };
      const inOrg = (p) => p && p.org_id === org && !p.is_template && !inTrash(p);
      // 조직 전체가 보는 페이지인가 — 일반 접근이 조직 보기·편집이고 자신·조상이 비공개·휴지통이 아님. 조상을 모르면(목록에 없음) 좁게
      const orgWide = (p) => {
        if (p.space_kind !== 'org' || p.general === 'invited') return false;
        for (let cur = p, d = 0; d < 32; d++) {
          if (!cur || cur.restricted || cur.archived_at) return false;
          if (!cur.parent_id) return true;
          cur = index.get(cur.parent_id);
        }
        return false;
      };
      const seeable = (p) => inOrg(p) && (owner || orgWide(p));
      const onlyDm = pick(`이 페이지는 조직 전체가 보는 페이지가 아니라 ${ONLY_DM(lang)} 다룬다.`, `This page is not visible to the whole org, so it is handled ${ONLY_DM(lang)}.`, lang);
      const missing = (id) => pick(`id=${quoted(id, 80)} 페이지가 이 조직에 없다 — pages로 확인하라.`, `No page id=${quoted(id, 80)} in this org — check with pages.`, lang);
      const access = (p) => ACCESS_NAME[p.access]?.[L(lang)] ?? p.access;

      if (a.action === 'pages') {
        const all = [...index.values()].filter(inOrg);
        let list = all.filter(seeable);
        const hidden = all.length - list.length;
        const q = String(a.q ?? '').trim().toLowerCase();
        if (q) list = list.filter((p) => String(p.title ?? '').toLowerCase().includes(q));
        const set = new Set(list.map((p) => p.id));
        const kids = new Map();
        for (const p of list) { const k = set.has(p.parent_id) ? p.parent_id : null; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(p); }
        const out = [];
        const walk = (k, depth) => { for (const p of (kids.get(k) ?? []).sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0))) { out.push(`${'  '.repeat(depth)}- ${ox.lineOr(p.title, pick('(제목 없음)', '(untitled)', lang))} · ${access(p)} · id=${p.id}`); walk(p.id, depth + 1); } };
        walk(null, 0);
        const note = hidden && !owner ? pick(` — 조직 전체가 보지 못하는 페이지 ${hidden}개는 ${ONLY_DM(lang)}`, ` — ${hidden} pages not visible to the whole org are shown ${ONLY_DM(lang)}`, lang) : '';
        if (!out.length) return pick(`맞는 페이지가 없다${note}.`, `No pages match${note}.`, lang);
        return [pick(`이 조직 페이지 ${out.length}개(들여쓰기 = 하위 페이지${note}):`, `${out.length} org pages (indent = sub-page${note}):`, lang), ox.block(out.slice(0, PAGE_CAP), PAGE_TEXT),
          ...(out.length > PAGE_CAP ? [pick(`…외 ${out.length - PAGE_CAP}개 — q로 좁혀라.`, `…and ${out.length - PAGE_CAP} more — narrow with q.`, lang)] : []),
          pick('본문은 page_read에 id를 줘라.', 'Use page_read with the id for the body.', lang)].join('\n');
      }

      if (a.action === 'page_add') {
        const title = one(a.title);
        if (!title || title.length > 200) return pick('page_add에는 title(1~200자)이 필요하다.', 'page_add needs a title (1-200 chars).', lang);
        if (String(a.text ?? '').length > TEXT_MAX) return pick(`본문이 너무 길다(${TEXT_MAX}자까지).`, `The body is too long (up to ${TEXT_MAX} chars).`, lang);
        let parent = null;
        if (a.parent_id) {
          parent = index.get(a.parent_id);
          if (!inOrg(parent)) return missing(a.parent_id);
          if (!seeable(parent)) return onlyDm;
          if (!['edit', 'full'].includes(parent.access)) return pick('그 상위 페이지는 보기만 되는 페이지라 아래에 만들 수 없다.', 'That parent page is view-only, so nothing can be added under it.', lang);
        }
        const siblings = [...index.values()].filter((p) => p.org_id === org && (p.parent_id ?? null) === (parent?.id ?? null)).map((p) => p.position).filter(Boolean).sort();
        const nodes = textToNodes(a.text);
        const id = workDeps.newId();
        unwrap(await c.client.rpc('office_page_create', { p_id: id, p_org: org, p_parent: parent?.id ?? null, p_position: between(siblings.at(-1) ?? null, null), p_title: title,
          p_content: nodes.length ? { type: 'doc', content: nodes } : {}, p_template: false }));
        // 확인 문장도 도구 결과다(검수 #fix-cross M2) — 상위 페이지 제목은 읽어 온 남의 글이라 블록 안에, 최상위면 내가 준 제목뿐이라 한 줄로
        if (parent) return `${pick(`페이지를 만들었다(id=${id}) — 제목 · 상위 페이지:`, `Created the page (id=${id}) — title · parent page:`, lang)}\n${ox.block([`${ox.line(title)} · ${ox.lineOr(parent.title, pick('(제목 없음)', '(untitled)', lang))}`], PAGE_TEXT)}`;
        return pick(`페이지를 만들었다: ${ox.line(title)} · 최상위 (id=${id})`, `Created the page: ${ox.line(title)} · top level (id=${id})`, lang);
      }

      // page_read · page_edit — 한 페이지
      if (!a.id || !UUID.test(a.id)) return pick(`${a.action}에는 id(pages가 보여 준 것)가 필요하다.`, `${a.action} needs an id from pages.`, lang);
      const p = index.get(a.id);
      if (!inOrg(p)) return missing(a.id);
      if (!seeable(p)) return onlyDm;
      if (a.action === 'page_edit') {
        if (!['edit', 'full'].includes(p.access)) return pick('보기만 되는 페이지라 고칠 수 없다.', 'This page is view-only.', lang);
        if ((a.text == null || a.text === '') && !one(a.title)) return pick('page_edit에는 text(본문) 또는 title이 필요하다.', 'page_edit needs text or a title.', lang);
        if (String(a.text ?? '').length > TEXT_MAX) return pick(`본문이 너무 길다(${TEXT_MAX}자까지).`, `The body is too long (up to ${TEXT_MAX} chars).`, lang);
      }
      const { data: row, error } = await c.client.from('office_pages').select('id, title, content, version, updated_at').eq('id', p.id).maybeSingle();
      if (error) throw Object.assign(new Error(error.message ?? String(error)), { rpc: true });
      if (!row) return missing(a.id);
      const doc = row.content?.type === 'doc' ? row.content : { type: 'doc', content: [] };

      if (a.action === 'page_read') {
        const text = docMarkdown(doc, lang); // 길이 상한은 원문 글자 수(READ_CAP)와 이스케이프 뒤 글자 예산 둘 다(검수 3차 M-A)
        const top = [`${pick('제목', 'Title', lang)}: ${ox.lineOr(row.title, pick('(제목 없음)', '(untitled)', lang), 500)}`, '---'];
        const body = text ? ox.body(text, { chars: READ_CAP, max: ox.room(top) }) : null;
        return [`${pick('페이지', 'Page', lang)} id=${p.id} · ${access(p)} · ${pick('버전', 'version', lang)} ${row.version}`,
          ox.block([...top, ...(body ? [body.json, ...(body.cut ? [pick(`…(앞 ${body.kept}자만)`, `…(first ${body.kept} chars)`, lang)] : [])] : [pick('(본문 없음)', '(empty)', lang)])], PAGE_TEXT)].join('\n');
      }

      const mode = a.mode === 'replace' ? 'replace' : 'append';
      let next = row.content;
      if (a.text != null && a.text !== '') {
        const nodes = textToNodes(a.text);
        if (!nodes.length) return pick('넣을 내용이 없다(빈 줄뿐이다).', 'Nothing to add (only blank lines).', lang);
        if (mode === 'replace') {
          const odd = foreignNodes(doc);
          if (odd.length) return pick(`이 페이지에는 글자가 아닌 블록(${odd.join(', ')})이 있어 본문을 통째로 바꾸지 않는다 — 덧붙이기(mode=append)로 하거나 사람이 오피스에서 고치게 알려라.`, `This page has non-text blocks (${odd.join(', ')}), so the body is not replaced — append instead (mode=append) or ask a person to edit it in Office.`, lang);
          next = { type: 'doc', content: nodes };
        } else next = { ...doc, content: [...(doc.content ?? []), ...nodes] };
      }
      const title = one(a.title) || row.title;
      if (title.length > 200) return pick('제목은 200자까지.', 'Title is limited to 200 characters.', lang);
      if (title === row.title && next === row.content) return pick('바꿀 것이 없다.', 'Nothing to change.', lang);
      const version = unwrap(await c.client.rpc('office_page_save', { p_id: p.id, p_title: title, p_content: next, p_base_version: row.version }));
      const what = [next !== row.content ? (mode === 'replace' ? pick('본문 바꿈', 'body replaced', lang) : pick('끝에 덧붙임', 'appended', lang)) : null, title !== row.title ? pick('제목', 'title', lang) : null].filter(Boolean).join(pick('·', ', ', lang));
      // 제목을 안 줬으면 확인 문장의 제목은 읽어 온 기존 제목(남이 쓴 글) — 블록 안에. 내가 준 제목이면 한 줄로(검수 #fix-cross M2)
      if (!one(a.title)) return `${pick(`페이지를 고쳤다(${what}) · 버전 ${version} — 제목:`, `Updated the page (${what}) · version ${version} — title:`, lang)}\n${ox.block([ox.lineOr(title, pick('(제목 없음)', '(untitled)', lang))], PAGE_TEXT)}`;
      return pick(`페이지를 고쳤다(${what}): ${ox.line(title)} · 버전 ${version}`, `Updated the page (${what}): ${ox.line(title)} · version ${version}`, lang);
    }

    return pick('action은 tasks·task_add·task_set·categories·pages·page_read·page_add·page_edit 중 하나다.', 'action must be tasks, task_add, task_set, categories, pages, page_read, page_add or page_edit.', lang);
  } catch (e) {
    return refusalText(e, ERRORS, lang);
  }
}

export function workDescription(lang = 'ko') {
  return lang === 'en'
    ? 'Argo Office tasks (to-dos) and pages (wiki) of the org of this messenger channel. action=tasks lists tasks with id — default: open tasks assigned to the owner; who=all shows everything the owner can see (1:1 only); filter status todo|doing|hold|done, overdue=true, category (name or id, none = uncategorized), q. task_add creates a task assigned to the owner: title, due_on, starts_on (YYYY-MM-DD), status todo|doing|hold, priority high|normal|low, category, note. task_set changes one task by id — only tasks assigned to the owner: status (done = finish, todo/doing/hold on a finished task reopens it), title, priority, category, starts_on/due_on (none clears), note (appended to the memo; note_mode=replace overwrites). categories lists task categories. pages lists the org pages (tree, id, view/edit); page_read returns a page body as text; page_add creates a page (title, parent_id — top level needs an admin, text); page_edit appends text to a page (mode=append, default) or replaces the body (mode=replace, only pages with plain text blocks), or renames it (title). Text format: # heading, - bullet, 1. numbered, - [ ] checkbox, > quote, --- divider, other lines are paragraphs. In rooms with other people only the owner\'s own tasks and pages visible to the whole org are used; nothing in rooms with guests. ' + OUTSIDE_RULE('en')
    : '이 메신저 채널 조직의 아르고 오피스 할 일과 페이지(위키). action=tasks는 할 일 목록(id 포함) — 기본은 주인이 맡은 안 끝난 일, who=all은 주인이 볼 수 있는 모든 일(1:1에서만), 거르기 status todo|doing|hold|done·overdue=true(기한 지남)·category(이름 또는 id, none=미분류)·q. task_add는 주인이 맡는 새 할 일: title, due_on·starts_on(YYYY-MM-DD), status todo|doing|hold, priority high|normal|low, category, note. task_set은 id로 한 건 고치기 — 주인이 맡은 일만: status(done=끝내기, 끝낸 일에 todo·doing·hold를 주면 다시 연다), title, priority, category, starts_on·due_on(none=지우기), note(기존 메모 뒤에 덧붙인다, note_mode=replace면 통째로 바꾼다). categories는 할 일 분류 목록. pages는 조직 페이지 목록(트리·id·보기/편집), page_read는 본문을 글로, page_add는 새 페이지(title, parent_id — 최상위는 관리자만, text), page_edit는 본문 끝에 덧붙이기(mode=append, 기본) 또는 본문 바꾸기(mode=replace — 글자 블록만 있는 페이지만)·제목 바꾸기(title). 글 서식: # 제목, - 목록, 1. 번호, - [ ] 체크, > 인용, --- 구분선, 나머지 줄은 문단. 다른 사람이 있는 방에서는 주인이 맡은 일과 조직 전체가 보는 페이지만 다루고, 손님이 있는 방에서는 아무것도 다루지 않는다. ' + OUTSIDE_RULE('ko');
}
