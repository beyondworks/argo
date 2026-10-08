// 일정 예시 데이터(예시 모드 — 서버 설정 없음). 사람·회사는 가상이다. 달력 화면 묶음에만 들어간다(첫 화면 묶음 밖).
// 쓰기는 서버 office_event_write와 같은 뜻으로 화면 메모리에만 남는다(새로고침하면 처음으로).
import { ME, SPACES } from '../core/session.js';
import { kstDay, addDays, allDayRange, mondayOf, parseRule, ruleString } from '../calendar/model.js';

const orgId = (key) => SPACES.find((s) => s.key === key)?.id ?? key; // 예시 공간은 id가 없어 키를 id로 쓴다
export const SAMPLE_PEOPLE = {
  beyondworks: [{ user_id: 'u-me', name: '김유건', role: 'owner' }, { user_id: 'u-minji', name: '최민지', role: 'admin' }, { user_id: 'u-jun', name: '박준', role: 'member' }],
  'lean-studio': [{ user_id: 'u-sora', name: '한소라', role: 'owner' }, { user_id: 'u-me', name: '김유건', role: 'member' }],
};
export const SAMPLE_CUSTOMERS = {
  me: [{ id: 'c-me-1', name: '프리랜서 계약처' }],
  beyondworks: [{ id: 'c-hanbit', name: '한빛코퍼레이션' }, { id: 'c-next', name: '넥스트필드' }, { id: 'c-tax', name: '한국세무회계' }],
  'lean-studio': [{ id: 'c-sori', name: '소리스튜디오' }],
};
const NAMES = { 'u-minji': '최민지', 'u-jun': '박준', 'u-sora': '한소라' };
const today = kstDay(Date.now()), mon = mondayOf(today);
const at = (day, time) => new Date(Date.parse(`${day}T${time}:00+09:00`)).toISOString();
// 할 일 분류(유건 10/4) — 공간 키마다 이름·순서. 서버 office_task_categories와 같은 모양
export const SAMPLE_TASK_CATEGORIES = {
  me: [{ id: 'tc-me-1', name: '개인 업무', position: 0 }, { id: 'tc-me-2', name: '공부', position: 1 }],
  beyondworks: [{ id: 'tc-bw-1', name: '영업', position: 0 }, { id: 'tc-bw-2', name: '세무', position: 1 }, { id: 'tc-bw-3', name: '디자인', position: 2 }],
  'lean-studio': [{ id: 'tc-ls-1', name: '촬영', position: 0 }],
};
const ago = (days) => new Date(Date.now() - days * 86400e3).toISOString();
const task = (over) => ({ assignee: 'u-me', created_by: 'u-me', done_at: null, status: 'todo', priority: 2, category_id: null, starts_on: null, note: '', hold_reason: null, held_at: null, created_at: ago(10), ...over });
export const SAMPLE_TASKS = [
  task({ id: 't-s1', org: null, title: '10월 캠페인 초안 검토', due_on: addDays(today, 1), status: 'doing', priority: 1, category_id: 'tc-me-1', starts_on: addDays(today, -2), note: '초안 2개 중 하나를 고르고 문구만 다듬기', created_at: ago(5) }),
  task({ id: 't-s2', org: 'beyondworks', title: '3분기 부가세 자료 보내기', due_on: addDays(today, 6), created_by: 'u-minji', priority: 1, category_id: 'tc-bw-2', note: '세무사 사무실에 매출·매입 자료 정리본 전달', created_at: ago(8) }),
  task({ id: 't-s3', org: 'beyondworks', title: '견적 템플릿 정리', due_on: addDays(today, 2), assignee: 'u-jun', status: 'hold', hold_reason: '가격표 확정 뒤 다시 시작', held_at: ago(2), category_id: 'tc-bw-1', note: '가격표 확정 뒤 다시 시작', created_at: ago(12) }),
  task({ id: 't-s4', org: null, title: '영수증 정리', due_on: null, priority: 3, created_at: ago(20) }),
  task({ id: 't-s5', org: 'lean-studio', title: '촬영 콘티 확인', due_on: addDays(today, 4), created_by: 'u-sora', category_id: 'tc-ls-1', created_at: ago(3) }),
  task({ id: 't-s6', org: null, title: '지난주 회의록 올리기', due_on: addDays(today, -2), category_id: 'tc-me-1', created_at: ago(9) }),
  task({ id: 't-s7', org: 'beyondworks', title: '한빛코퍼레이션 견적 회신', due_on: addDays(today, -1), category_id: 'tc-bw-1', done_at: ago(1), created_at: ago(6) }),
  task({ id: 't-s8', org: null, title: '노션 정리법 읽기', due_on: addDays(today, 10), category_id: 'tc-me-2', created_at: ago(2) }),
  // 크루가 만든 할 일(17차) — 크루 도구가 남기는 출처 모양(source.kind 'crew', crew = 크루 id). 에이전트 상세 '맡은 일'에 묶인다
  task({ id: 't-s9', org: 'beyondworks', title: '경쟁사 가격표를 표로 정리', due_on: addDays(today, 3), category_id: 'tc-bw-1', note: '가격 조사 결과를 회의 자료용 표로', source: { kind: 'crew', crew: 'crew-otto', slug: 'otto', name: '오토' }, created_at: ago(1) }),
  // 맥 세션이 남긴 할 일(업무 현황 10/8) — 출처 kind 'session', name = 세션 제목. 업무 현황 화면이 세션 주인 이름(" - " 앞부분)으로 묶는다
  task({ id: 't-s10', org: 'beyondworks', title: '오피스 업무 현황 화면 만들기', due_on: addDays(today, 1), status: 'doing', note: '사람별 카드·보류된 업무 먼저', source: { kind: 'session', name: '맥가이버 - 정비사' }, created_at: ago(1) }),
  task({ id: 't-s11', org: 'beyondworks', title: '노션 업무 이관 범위 확인', due_on: addDays(today, -1), status: 'hold', hold_reason: '이것부터: 업무 현황 화면 검수', held_at: ago(0.5), source: { kind: 'session', name: '페퍼 - 총괄' }, created_at: ago(4) }),
];
// 바뀐 기록(예시) — 할 일 id → 새것부터 쌓인 줄. 서버 office_task_history와 같은 모양
const NAME_OF = (id) => (id === 'u-me' ? ME.name : NAMES[id] ?? '?');
const SAMPLE_TASK_EVENTS = Object.fromEntries(SAMPLE_TASKS.map((x) => [x.id, [
  ...(x.done_at ? [{ kind: 'done', at: x.done_at, actor: x.assignee, name: NAME_OF(x.assignee), from: null, to: null }] : []),
  ...(x.status !== 'todo' ? [{ kind: 'status', at: ago(1.5), actor: x.assignee, name: NAME_OF(x.assignee), from: 'todo', to: x.status }] : []),
  { kind: 'create', at: x.created_at, actor: x.created_by, name: NAME_OF(x.created_by), from: null, to: x.due_on },
]]));
export const sampleTaskHistory = (id) => (SAMPLE_TASK_EVENTS[id] ?? []).slice();
const logEvent = (id, kind, from = null, to = null) => { (SAMPLE_TASK_EVENTS[id] ??= []).unshift({ kind, at: new Date().toISOString(), actor: ME.id, name: ME.name, from: from == null ? null : String(from), to: to == null ? null : String(to) }); };
const catName = (key, id) => SAMPLE_TASK_CATEGORIES[key]?.find((c) => c.id === id)?.name ?? null;
/** 보류 사유 — 서버와 같게 앞뒤 공백을 걷고 1~500자, 비면 null */
const holdReason = (v) => { if (v == null) return null; if (typeof v !== 'string') fail('task_input'); const r = v.trim(); if (r.length > 500) fail('task_input'); return r || null; };
const EDITS = ['task.title', 'task.due', 'task.cancel', 'task.note', 'task.priority', 'task.category', 'task.start'];
/** 할 일 쓰기(예시 모드) — 서버 office_task_write와 같은 권한·거절 이유로 화면 메모리의 SAMPLE_TASKS만 바꾼다 */
export function sampleTaskWrite(space, action, d) {
  const role = SPACES.find((s) => s.key === space)?.role, admin = space !== 'me' && (role === 'owner' || role === 'admin');
  const org = space === 'me' ? null : space;
  const key = space === 'me' ? 'me' : space;
  const cat = (id) => { if (id && !catName(key, id)) fail('task_category'); return id || null; };
  if (action === 'task.create') {
    const assignee = d.assignee ?? ME.id;
    if (!d.title?.trim()) fail('task_input');
    if (assignee !== ME.id && !admin) fail('task_forbidden');
    if (d.starts_on && d.due_on && d.starts_on > d.due_on) fail('task_dates');
    const row = task({ id: d.id, org, title: d.title.trim(), due_on: d.due_on || null, assignee, created_by: ME.id, created_at: new Date().toISOString(),
      status: d.status || 'todo', priority: Number(d.priority) || 2, category_id: cat(d.category_id), starts_on: d.starts_on || null, note: d.note ?? '', source: d.source ?? null,
      ...(d.status === 'hold' ? { held_at: new Date().toISOString(), hold_reason: holdReason(d.hold_reason) } : {}) });
    SAMPLE_TASKS.push(row);
    logEvent(row.id, 'create', null, row.due_on);
    return row;
  }
  const t = SAMPLE_TASKS.find((x) => x.id === d.id && x.org === org);
  if (!t) fail('task_not_found');
  const ok = admin || (['task.done', 'task.reopen', 'task.status'].includes(action) && t.assignee === ME.id) || (EDITS.includes(action) && t.created_by === ME.id && t.assignee === ME.id);
  if (!ok) fail('task_forbidden');
  if (t.cancelled_at) fail('task_cancelled');
  const set = (field, kind, value, from = t[field], to = value) => { if (t[field] !== value) { logEvent(t.id, kind, from, to); t[field] = value; } };
  if (action === 'task.done') { if (!t.done_at) { t.done_at = new Date().toISOString(); logEvent(t.id, 'done'); } }
  else if (action === 'task.reopen') { if (t.done_at) { logEvent(t.id, 'reopen'); t.done_at = null; } }
  else if (t.done_at) fail('task_done');
  else if (action === 'task.due') { if (t.starts_on && d.due_on && t.starts_on > d.due_on) fail('task_dates'); set('due_on', 'due', d.due_on || null); }
  else if (action === 'task.title') set('title', 'title', d.title.trim());
  else if (action === 'task.status') {
    if (!['todo', 'doing', 'hold'].includes(d.status)) fail('task_input');
    const reason = d.status === 'hold' ? holdReason(d.hold_reason) : null;
    // 사유만 고치기(reason_only — 할 일 패널): 그사이 남이 보류를 풀었으면 상태를 되돌리지 않고 task_conflict(서버와 같다)
    if (d.reason_only && (d.status !== 'hold' || t.status !== 'hold')) fail('task_conflict');
    if (t.status === 'hold' && d.status === 'hold') { // 이미 보류: 사유를 보냈고 다르면 사유만(보류한 때 그대로), 기록은 'status' 보류→보류 한 줄(사유 값은 남기지 않는다)
      if ('hold_reason' in d && t.hold_reason !== reason) { logEvent(t.id, 'status', 'hold', 'hold'); t.hold_reason = reason; }
    } else {
      t.held_at = d.status === 'hold' ? new Date().toISOString() : null; t.hold_reason = reason;
      set('status', 'status', d.status);
    }
  }
  else if (action === 'task.priority') { if (![1, 2, 3].includes(Number(d.priority))) fail('task_input'); set('priority', 'priority', Number(d.priority)); }
  else if (action === 'task.category') { const id = cat(d.category_id); set('category_id', 'category', id, catName(key, t.category_id), catName(key, id)); }
  else if (action === 'task.start') { if (d.starts_on && t.due_on && d.starts_on > t.due_on) fail('task_dates'); set('starts_on', 'start', d.starts_on || null); }
  else if (action === 'task.note') { if (typeof d.note !== 'string') fail('task_input'); if (t.note !== d.note) { logEvent(t.id, 'note'); t.note = d.note; } }
  else if (action === 'task.assign') { if (!admin) fail('task_forbidden'); set('assignee', 'assign', d.assignee, NAME_OF(t.assignee), NAME_OF(d.assignee)); }
  else if (action === 'task.cancel') { t.cancelled_at = new Date().toISOString(); logEvent(t.id, 'cancel'); }
  else fail('task_input');
  return t;
}
/** 분류 관리(예시 모드) — 서버 office_task_category_write와 같은 권한·거절 이유. 지우면 그 분류의 할 일은 미분류 */
export function sampleCategoryWrite(space, action, d) {
  const role = SPACES.find((s) => s.key === space)?.role;
  if (space !== 'me' && role !== 'owner' && role !== 'admin') fail('task_forbidden');
  const list = (SAMPLE_TASK_CATEGORIES[space] ??= []);
  const name = String(d.name ?? '').trim();
  const taken = (id) => list.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase());
  if (action === 'category.create') {
    if (!name || name.length > 40) fail('task_input');
    if (list.some((c) => c.id === d.id)) return;
    if (taken(d.id)) fail('task_category_name');
    if (list.length >= 200) fail('task_limit');
    list.push({ id: d.id, name, position: list.reduce((m, c) => Math.max(m, c.position + 1), 0) });
  } else if (action === 'category.rename') {
    const c = list.find((x) => x.id === d.id);
    if (!c) fail('task_category');
    if (!name || name.length > 40) fail('task_input');
    if (taken(d.id)) fail('task_category_name');
    c.name = name;
  } else if (action === 'category.order') {
    const ids = Array.isArray(d.ids) ? d.ids : [];
    if (ids.length !== list.length || new Set(ids).size !== ids.length || ids.some((id) => !list.some((c) => c.id === id))) fail('task_input');
    ids.forEach((id, i) => { list.find((c) => c.id === id).position = i; });
  } else if (action === 'category.delete') {
    const i = list.findIndex((c) => c.id === d.id);
    if (i < 0) fail('task_category');
    list.splice(i, 1);
    for (const x of SAMPLE_TASKS) if (x.category_id === d.id) x.category_id = null;
  } else fail('task_input');
}
let demo = null;
function sampleRows() {
  if (demo) return demo;
  const row = (over) => ({ org_id: null, owner: 'u-me', crew: null, visibility: 'private', note: '', location: '', category: '', customer_id: null, all_day: false, attendees: [], rrule: null, exdates: [], parent_id: null, recur_on: null, ...over });
  const weekly = row({ id: 'ev-weekly', org_id: 'beyondworks', visibility: 'org', title: '주간 회의', category: '회의', location: '3층 회의실', starts_at: at(addDays(mon, -21), '10:00'), ends_at: at(addDays(mon, -21), '11:00'), rrule: 'FREQ=WEEKLY', attendees: ['u-me', 'u-minji', 'u-jun'], exdates: [addDays(mon, 7)], note: '지난주 결정 확인 → 이번 주 할 일 배분' });
  demo = [
    weekly,
    row({ id: 'ev-weekly-moved', org_id: 'beyondworks', visibility: 'org', title: '주간 회의(시간 변경)', category: '회의', location: '3층 회의실', starts_at: at(addDays(mon, 8), '14:00'), ends_at: at(addDays(mon, 8), '15:00'), attendees: weekly.attendees, parent_id: 'ev-weekly', recur_on: addDays(mon, 7) }),
    row({ id: 'ev-dentist', title: '치과 예약', category: '개인', starts_at: at(today, '09:30'), ends_at: at(today, '10:00') }),
    row({ id: 'ev-review', org_id: 'beyondworks', visibility: 'org', crew: 'crew-mio', title: '오피스 화면 디자인 리뷰', category: '회의', starts_at: at(today, '16:00'), ends_at: at(today, '17:00'), attendees: ['u-me', 'u-minji'] }),
    row({ id: 'ev-call', org_id: 'beyondworks', visibility: 'org', title: '넥스트필드 수익 배분 통화', category: '영업', customer_id: 'c-next', starts_at: at(today, '16:30'), ends_at: at(today, '17:30') }),
    row({ id: 'ev-quote', org_id: 'beyondworks', visibility: 'org', crew: 'crew-luna', title: '한빛코퍼레이션 재견적 회신', category: '영업', customer_id: 'c-hanbit', starts_at: at(addDays(today, 1), '11:00'), ends_at: at(addDays(today, 1), '11:30'), note: '1,800개 기준 단가표로 회신(루나가 메일에서 잡은 일정)' }),
    row({ id: 'ev-salary', org_id: 'beyondworks', visibility: 'private', title: '연봉 협상 자료 정리', category: '인사', starts_at: at(addDays(today, 1), '15:00'), ends_at: at(addDays(today, 1), '16:00') }),
    row({ id: 'ev-partner', org_id: 'beyondworks', visibility: 'org', owner: 'u-minji', title: '넥스트필드 파트너 미팅', category: '영업', customer_id: 'c-next', location: '강남 본사', starts_at: at(addDays(today, 2), '14:00'), ends_at: at(addDays(today, 2), '15:30'), attendees: ['u-minji', 'u-me'] }),
    row({ id: 'ev-trip', org_id: 'beyondworks', visibility: 'org', title: '부산 출장', category: '출장', customer_id: 'c-hanbit', location: '부산 공장', all_day: true, ...allDayRange(addDays(today, 3), addDays(today, 4)) }),
    row({ id: 'ev-shoot', org_id: 'lean-studio', visibility: 'org', owner: 'u-sora', title: '스튜디오 촬영', category: '촬영', customer_id: 'c-sori', location: '성수동 스튜디오', starts_at: at(addDays(today, 5), '13:00'), ends_at: at(addDays(today, 5), '18:00'), attendees: ['u-sora', 'u-me'] }),
    row({ id: 'ev-card', title: '카드 대금 확인', category: '개인', all_day: true, ...allDayRange(`${today.slice(0, 7)}-25`, `${today.slice(0, 7)}-25`), rrule: 'FREQ=MONTHLY' }),
  ];
  return demo;
}
const canEditSample = (r) => r.owner === ME.id || (r.org_id && ['owner', 'admin'].includes(SPACES.find((s) => orgId(s.key) === r.org_id)?.role));
const custName = (r) => Object.values(SAMPLE_CUSTOMERS).flat().find((c) => c.id === r.customer_id)?.name ?? null;
const shape = (r) => ({ ...r, owner_name: NAMES[r.owner] ?? ME.name, customer_name: custName(r), can_edit: canEditSample(r) });
export function sampleList() {
  return { events: sampleRows().map(shape), orgs: SPACES.filter((s) => s.kind === 'org').map((s) => ({ id: orgId(s.key), name: s.name, role: s.role })) };
}
const fail = (code) => { throw new Error(code); };
/** 서버와 같은 뜻으로 — save(upsert)·delete·skip(한 회차 빼기)·split(이 일정 및 이후) */
export function sampleWrite(action, d) {
  const rows = sampleRows(), find = (id) => rows.find((r) => r.id === id);
  const cur = d?.id && find(d.id);
  if (action !== 'save' && !cur) fail('calendar_not_found');
  if (cur && !canEditSample(cur)) fail('calendar_forbidden');
  const put = (x) => {
    if (!x.title?.trim() || Date.parse(x.ends_at) <= Date.parse(x.starts_at)) fail('calendar_invalid');
    const next = { ...(find(x.id) ?? { owner: ME.id, crew: null, exdates: [] }), ...x, visibility: x.org_id ? x.visibility ?? 'org' : 'private', attendees: x.org_id ? x.attendees ?? [] : [] };
    const i = rows.findIndex((r) => r.id === x.id);
    if (i >= 0) rows[i] = next; else rows.push(next);
    if (next.parent_id && next.recur_on) { const p = find(next.parent_id); if (p && !p.exdates.includes(next.recur_on)) p.exdates = [...p.exdates, next.recur_on]; }
    return next;
  };
  if (action === 'save') return { ok: true, event: shape(put(d)) };
  if (action === 'delete') { for (let i = rows.length - 1; i >= 0; i--) if (rows[i].id === d.id || rows[i].parent_id === d.id) rows.splice(i, 1); return { ok: true }; }
  if (action === 'skip') { if (!cur.exdates.includes(d.day)) cur.exdates = [...cur.exdates, d.day]; return { ok: true }; }
  if (action === 'split') {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].parent_id === cur.id && rows[i].recur_on >= d.day) rows.splice(i, 1); // 그날 뒤의 회차 수정 행
    cur.exdates = cur.exdates.filter((x) => x < d.day);
    if (d.day <= kstDay(cur.starts_at)) rows.splice(rows.indexOf(cur), 1);
    else cur.rrule = ruleString({ ...parseRule(cur.rrule), until: addDays(d.day, -1) });
    return d.next ? { ok: true, event: shape(put({ ...d.next, owner: cur.owner })) } : { ok: true }; // next 없으면 자르기만
  }
  return fail('calendar_invalid');
}
