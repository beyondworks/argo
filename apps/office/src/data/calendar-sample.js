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
export const SAMPLE_TASKS = [
  { id: 't-s1', org: null, title: '10월 캠페인 초안 검토', due_on: addDays(today, 1), assignee: 'u-me', created_by: 'u-me', done_at: null },
  { id: 't-s2', org: 'beyondworks', title: '3분기 부가세 자료 보내기', due_on: addDays(today, 6), assignee: 'u-me', created_by: 'u-minji', done_at: null },
  { id: 't-s3', org: 'beyondworks', title: '견적 템플릿 정리', due_on: addDays(today, 2), assignee: 'u-jun', created_by: 'u-me', done_at: null },
  { id: 't-s4', org: null, title: '영수증 정리', due_on: null, assignee: 'u-me', created_by: 'u-me', done_at: null },
  { id: 't-s5', org: 'lean-studio', title: '촬영 콘티 확인', due_on: addDays(today, 4), assignee: 'u-me', created_by: 'u-sora', done_at: null },
  { id: 't-s6', org: null, title: '지난주 회의록 올리기', due_on: addDays(today, -2), assignee: 'u-me', created_by: 'u-me', done_at: null },
];
/** 할 일 쓰기(예시 모드) — 서버 office_task_write와 같은 권한·거절 이유로 화면 메모리의 SAMPLE_TASKS만 바꾼다 */
export function sampleTaskWrite(space, action, d) {
  const role = SPACES.find((s) => s.key === space)?.role, admin = space !== 'me' && (role === 'owner' || role === 'admin');
  const org = space === 'me' ? null : space;
  if (action === 'task.create') {
    const assignee = d.assignee ?? ME.id;
    if (!d.title?.trim()) fail('task_input');
    if (assignee !== ME.id && !admin) fail('task_forbidden');
    const row = { id: d.id, org, title: d.title.trim(), due_on: d.due_on || null, assignee, created_by: ME.id, done_at: null, created_at: new Date().toISOString() };
    SAMPLE_TASKS.push(row);
    return row;
  }
  const t = SAMPLE_TASKS.find((x) => x.id === d.id && x.org === org);
  if (!t) fail('task_not_found');
  const ok = admin || (['task.done', 'task.reopen'].includes(action) && t.assignee === ME.id) || (['task.title', 'task.due', 'task.cancel'].includes(action) && t.created_by === ME.id && t.assignee === ME.id);
  if (!ok) fail('task_forbidden');
  if (t.cancelled_at) fail('task_cancelled');
  if (action === 'task.done') t.done_at ??= new Date().toISOString();
  else if (action === 'task.reopen') t.done_at = null;
  else if (t.done_at) fail('task_done');
  else if (action === 'task.due') t.due_on = d.due_on || null;
  else if (action === 'task.title') t.title = d.title.trim();
  else if (action === 'task.assign') { if (!admin) fail('task_forbidden'); t.assignee = d.assignee; }
  else if (action === 'task.cancel') t.cancelled_at = new Date().toISOString();
  else fail('task_input');
  return t;
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
